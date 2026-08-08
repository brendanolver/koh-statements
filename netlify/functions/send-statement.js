const JSZip = require('jszip');
const { pdfFromSource } = require('./lib/pdf');

const RESEND_URL = 'https://api.resend.com/emails';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Table-based, inline-styled — arbitrary CSS (flexbox/grid, like the full
// statement uses) renders unreliably across email clients, so this body is
// deliberately simpler than the statement itself; the PDF attachment is the
// full detail.
function emailBodyHtml({ customerName, balanceDue, invoiceCount, attachedInvoiceCount, currency }) {
  const invoiceWord = invoiceCount === 1 ? 'invoice' : 'invoices';
  const invoiceCopiesLine = attachedInvoiceCount > 0
    ? `<tr><td style="padding:0 32px 16px;font-size:13px;color:#6b7280;line-height:1.6;">Copies of the ${attachedInvoiceCount} underlying invoice${attachedInvoiceCount === 1 ? '' : 's'} are included in the attached zip file.</td></tr>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;background:#f4f5f7;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:6px;">
<tr><td style="padding:32px 32px 8px;"><img src="https://koh-statements.netlify.app/logo.png" alt="KOH Industries" width="160" style="display:block;height:auto;"></td></tr>
<tr><td style="padding:0 32px 24px;font-size:11px;color:#6b7280;letter-spacing:2px;">WNDRR</td></tr>
<tr><td style="padding:0 32px 16px;font-size:14px;color:#1a1a1a;">Hi ${customerName},</td></tr>
<tr><td style="padding:0 32px 16px;font-size:14px;color:#1a1a1a;line-height:1.5;">Please find attached your current account statement from KOH Industries — ${invoiceCount} open ${invoiceWord} totalling:</td></tr>
<tr><td style="padding:0 32px 24px;">
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#6b7280;">Balance Due ${currency || 'AUD'}</div>
  <div style="font-size:28px;font-weight:700;color:#0f5c4a;">${fmtMoney(balanceDue)}</div>
</td></tr>
${invoiceCopiesLine}
<tr><td style="padding:0 32px 24px;font-size:13px;color:#6b7280;line-height:1.6;">Full invoice and PO numbers are in the attached PDF. Please email remittance advice to <a href="mailto:brendan@kohindustries.com" style="color:#0f5c4a;">brendan@kohindustries.com</a>.</td></tr>
<tr><td style="padding:16px 32px 32px;border-top:1px solid #d8dbe0;font-size:12px;color:#6b7280;">KOH Industries Pty Ltd — Unit 5, 6 Builders Close, Wendouree Victoria 3355, Australia</td></tr>
</table>
</td></tr>
</table>`;
}

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

async function sendEmail({ recipientEmail, ccEmails, customerName, statementPdfBase64, invoicesZip, xlsxBase64, balanceDue, invoiceCount, currency }) {
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
    to: recipientEmail,
    reply_to: 'brendan@kohindustries.com',
    subject: `Statement from KOH Industries — ${customerName}`,
    html: emailBodyHtml({ customerName, balanceDue, invoiceCount, attachedInvoiceCount: invoicesZip ? invoicesZip.count : 0, currency }),
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

exports.handler = async (event) => {
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

    const { html, customerName, recipientEmail, balanceDue, invoiceCount, invoicePdfs, currency, xlsxBase64, ccEmails } = body;
    if (!html || !customerName || !recipientEmail) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing html, customerName, or recipientEmail' }) };
    }
    if (!EMAIL_RE.test(recipientEmail)) {
      return { statusCode: 400, body: JSON.stringify({ error: `"${recipientEmail}" doesn't look like a valid email address` }) };
    }
    const validCcEmails = Array.isArray(ccEmails) ? ccEmails.filter((e) => EMAIL_RE.test(e)) : [];

    const [statementPdfBase64, invoicesZip] = await Promise.all([
      pdfFromSource(html),
      buildInvoicesZipAttachment(invoicePdfs, customerName),
    ]);
    const result = await sendEmail({ recipientEmail, ccEmails: validCcEmails, customerName, statementPdfBase64, invoicesZip, xlsxBase64, balanceDue, invoiceCount, currency });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, id: result.id }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
