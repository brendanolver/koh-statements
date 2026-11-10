const { withAuth } = require('./lib/auth');
const JSZip = require('jszip');
const { pdfFromSource } = require('./lib/pdf');
const { emailBodyHtml, emailSubject } = require('./lib/statement-email');

const RESEND_URL = 'https://api.resend.com/emails';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Fetches each underlying AM invoice PDF in parallel (one slow/failed
// invoice shouldn't block the statement email from going out, so failures
// are just dropped rather than failing the whole send), then bundles them
// into a single zip attachment rather than one file per invoice — a
// customer with 10 open invoices would otherwise get 11 separate PDFs in
// one email. Returns null when there's nothing to zip.
async function buildInvoicesZipAttachment(invoicePdfs, customerName) {
  const results = await Promise.allSettled(
    (invoicePdfs || []).map(async ({ invoiceNumber, printUrl }) => ({
      invoiceNumber,
      base64: await pdfFromSource(printUrl),
    }))
  );
  const pdfs = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (pdfs.length === 0) return null;

  const zip = new JSZip();
  for (const { invoiceNumber, base64 } of pdfs) {
    zip.file(`Invoice ${invoiceNumber}.pdf`, base64, { base64: true });
  }
  const zipBase64 = await zip.generateAsync({ type: 'base64' });

  return {
    filename: `Invoices - ${customerName}.zip`,
    content: zipBase64,
    content_type: 'application/zip',
    count: pdfs.length,
  };
}

async function sendEmail({ recipientEmails, ccEmails, customerName, contactFirstName, recipientName, statementPdfBase64, invoicesZip, xlsxBase64, balanceDue, overdue, holdTotal, holdCount, currency }) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const from = (process.env.STATEMENTS_FROM_EMAIL || '').trim();

  const attachments = [
    {
      filename: `Statement - ${customerName}.pdf`,
      content: statementPdfBase64,
      content_type: 'application/pdf',
    },
  ];
  if (xlsxBase64) {
    attachments.push({
      filename: `Statement - ${customerName}.xlsx`,
      content: xlsxBase64,
      content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }
  if (invoicesZip) {
    attachments.push({ filename: invoicesZip.filename, content: invoicesZip.content, content_type: invoicesZip.content_type });
  }

  const payload = {
    from,
    to: recipientEmails, // Resend accepts an array — one or many recipients, same call either way
    reply_to: 'brendan@kohindustries.com',
    subject: emailSubject({ customerName, holdTotal, overdue }),
    html: emailBodyHtml({ customerName, contactFirstName, recipientName, balanceDue, overdue, holdTotal, holdCount, attachedInvoiceCount: invoicesZip ? invoicesZip.count : 0, currency }),
    attachments,
  };
  if (Array.isArray(ccEmails) && ccEmails.length > 0) {
    payload.cc = ccEmails;
  }

  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Resend failed (${res.status})`);
  }
  return data;
}

const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
    }

    if (!process.env.PDFSHIFT_API_KEY || !process.env.RESEND_API_KEY || !process.env.STATEMENTS_FROM_EMAIL) {
      return { statusCode: 500, body: JSON.stringify({ error: 'PDFSHIFT_API_KEY / RESEND_API_KEY / STATEMENTS_FROM_EMAIL not configured' }) };
    }

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { html, customerName, contactFirstName, recipientName, recipientEmail, balanceDue, overdue, holdTotal, holdCount, invoicePdfs, currency, xlsxBase64, ccEmails } = body;
    if (!html || !customerName || !recipientEmail) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing html, customerName, or recipientEmail' }) };
    }
    // recipientEmail may be a single address or a comma-separated list —
    // the client's <input multiple> and the queue's recipient field both
    // hand this straight through as one string.
    const recipientEmails = String(recipientEmail).split(',').map((e) => e.trim()).filter(Boolean);
    if (!recipientEmails.length || !recipientEmails.every((e) => EMAIL_RE.test(e))) {
      return { statusCode: 400, body: JSON.stringify({ error: `"${recipientEmail}" doesn't look like a valid email address` }) };
    }
    const validCcEmails = Array.isArray(ccEmails) ? ccEmails.filter((e) => EMAIL_RE.test(e)) : [];

    const [statementPdfBase64, invoicesZip] = await Promise.all([
      pdfFromSource(html),
      buildInvoicesZipAttachment(invoicePdfs, customerName),
    ]);
    const result = await sendEmail({ recipientEmails, ccEmails: validCcEmails, customerName, contactFirstName, recipientName, statementPdfBase64, invoicesZip, xlsxBase64, balanceDue, overdue, holdTotal, holdCount, currency });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, id: result.id }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Signed-in people only, and only with one of these sections ticked (see lib/auth.js).
exports.handler = withAuth(['statements'], handler);
