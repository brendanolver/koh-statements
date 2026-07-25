const PDFSHIFT_URL = 'https://api.pdfshift.io/v3/convert/pdf';
const RESEND_URL = 'https://api.resend.com/emails';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Table-based, inline-styled — arbitrary CSS (flexbox/grid, like the full
// statement uses) renders unreliably across email clients, so this body is
// deliberately simpler than the statement itself; the PDF attachment is the
// full detail.
function emailBodyHtml({ customerName, balanceDue, invoiceCount }) {
  const invoiceWord = invoiceCount === 1 ? 'invoice' : 'invoices';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;background:#f4f5f7;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:6px;">
<tr><td style="padding:32px 32px 4px;font-size:20px;font-weight:700;color:#1a1a1a;">KOH INDUSTRIES</td></tr>
<tr><td style="padding:0 32px 24px;font-size:11px;color:#6b7280;letter-spacing:2px;">WNDRR</td></tr>
<tr><td style="padding:0 32px 16px;font-size:14px;color:#1a1a1a;">Hi ${customerName},</td></tr>
<tr><td style="padding:0 32px 16px;font-size:14px;color:#1a1a1a;line-height:1.5;">Please find attached your current account statement from KOH Industries — ${invoiceCount} open ${invoiceWord} totalling:</td></tr>
<tr><td style="padding:0 32px 24px;">
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#6b7280;">Balance Due AUD</div>
  <div style="font-size:28px;font-weight:700;color:#0f5c4a;">${fmtMoney(balanceDue)}</div>
</td></tr>
<tr><td style="padding:0 32px 24px;font-size:13px;color:#6b7280;line-height:1.6;">Full invoice and PO numbers are in the attached PDF. Please email remittance advice to <a href="mailto:brendan@kohindustries.com" style="color:#0f5c4a;">brendan@kohindustries.com</a>.</td></tr>
<tr><td style="padding:16px 32px 32px;border-top:1px solid #d8dbe0;font-size:12px;color:#6b7280;">KOH Industries Pty Ltd — Unit 5, 6 Builders Close, Wendouree Victoria 3355, Australia</td></tr>
</table>
</td></tr>
</table>`;
}

async function htmlToPdfBase64(html) {
  const apiKey = (process.env.PDFSHIFT_API_KEY || '').trim();
  const res = await fetch(PDFSHIFT_URL, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: html, format: 'A4' }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PDFShift failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

async function sendEmail({ recipientEmail, customerName, pdfBase64, balanceDue, invoiceCount }) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const from = (process.env.STATEMENTS_FROM_EMAIL || '').trim();

  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: recipientEmail,
      reply_to: 'brendan@kohindustries.com',
      subject: `Statement from KOH Industries — ${customerName}`,
      html: emailBodyHtml({ customerName, balanceDue, invoiceCount }),
      attachments: [
        {
          filename: `Statement - ${customerName}.pdf`,
          content: pdfBase64,
          content_type: 'application/pdf',
        },
      ],
    }),
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

    const { html, customerName, recipientEmail, balanceDue, invoiceCount } = body;
    if (!html || !customerName || !recipientEmail) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing html, customerName, or recipientEmail' }) };
    }
    if (!EMAIL_RE.test(recipientEmail)) {
      return { statusCode: 400, body: JSON.stringify({ error: `"${recipientEmail}" doesn't look like a valid email address` }) };
    }

    const pdfBase64 = await htmlToPdfBase64(html);
    const result = await sendEmail({ recipientEmail, customerName, pdfBase64, balanceDue, invoiceCount });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, id: result.id }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
