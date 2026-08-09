const { pdfFromSource } = require('./lib/pdf');

const RESEND_URL = 'https://api.resend.com/emails';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fmtMoney(n) {
  const v = Number(n || 0);
  const abs = Math.abs(v).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `($${abs})` : `$${abs}`;
}

// Standalone document (not the email body) — converted to the "attached"
// PDF via PDFShift, same mechanism send-statement.js uses for the statement
// PDF. Mirrors the in-app expanded detail view: Customer -> Invoice rows,
// per-customer subtotal, grand total.
function reportHtml({ agentName, monthLabel, customers, total, currency }) {
  const customerBlocks = (customers || []).map((cust) => {
    const rows = (cust.invoices || []).map((li) => `
      <tr>
        <td>Invoice ${li.invoiceNum}</td>
        <td>${li.date || ''}</td>
        <td>${li.po || ''}</td>
        <td class="num">${Number(li.rate).toFixed(2)}%</td>
        <td class="num">${fmtMoney(li.commission)}</td>
      </tr>`).join('');
    return `
      <tr class="cust-row"><td colspan="5">${cust.customerName}</td></tr>
      ${rows}
      <tr class="subtotal-row"><td colspan="4">Subtotal</td><td class="num">${fmtMoney(cust.subtotal)}</td></tr>`;
  }).join('');

  return `<html><head><meta charset="utf-8"><style>
    body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; margin: 32px; }
    h1 { font-size: 18px; margin: 0 0 2px; }
    .sub { color: #6b7280; font-size: 12px; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: #6b7280; border-bottom: 1.5px solid #1a1a1a; padding: 0 6px 6px; }
    td { padding: 5px 6px; border-bottom: 1px solid #eee; }
    .num { text-align: right; }
    .cust-row td { font-weight: 700; border-bottom: none; padding-top: 14px; }
    .subtotal-row td { font-weight: 700; border-top: 1px solid #ccc; border-bottom: none; }
    .total-row td { font-weight: 700; font-size: 14px; border-top: 2px solid #1a1a1a; padding-top: 10px; }
  </style></head><body>
    <h1>Commission Report — ${monthLabel}</h1>
    <div class="sub">${agentName}</div>
    <table>
      <thead><tr><th>Invoice</th><th>Date</th><th>PO</th><th class="num">Rate</th><th class="num">Commission</th></tr></thead>
      <tbody>
        ${customerBlocks}
        <tr class="total-row"><td colspan="4">Total (ex GST)</td><td class="num">${fmtMoney(total)} ${currency || 'AUD'}</td></tr>
      </tbody>
    </table>
  </body></html>`;
}

// Short, plain wording — replicates Brendan's own existing phrasing verbatim
// rather than the longer branded copy used for customer statement emails.
function emailBodyHtml({ greetingName, monthLabel, total }) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;background:#f4f5f7;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:6px;">
<tr><td style="padding:32px 32px 8px;"><img src="https://koh-statements.netlify.app/logo.png" alt="KOH Industries" width="160" style="display:block;height:auto;"></td></tr>
<tr><td style="padding:0 32px 24px;font-size:11px;color:#6b7280;letter-spacing:2px;">WNDRR</td></tr>
<tr><td style="padding:0 32px 16px;font-size:14px;color:#1a1a1a;line-height:1.6;">Hi ${greetingName},</td></tr>
<tr><td style="padding:0 32px 16px;font-size:14px;color:#1a1a1a;line-height:1.6;">Please find attached ${monthLabel} commission report.</td></tr>
<tr><td style="padding:0 32px 16px;font-size:14px;color:#1a1a1a;line-height:1.6;">Please check over the report &amp; let me know if there are any issues.</td></tr>
<tr><td style="padding:0 32px 24px;font-size:14px;color:#1a1a1a;line-height:1.6;">If not can you please email back an invoice for ${fmtMoney(total)} ex gst we'll get it paid to you asap.</td></tr>
<tr><td style="padding:16px 32px 32px;border-top:1px solid #d8dbe0;font-size:12px;color:#6b7280;">KOH Industries Pty Ltd — Unit 5, 6 Builders Close, Wendouree Victoria 3355, Australia</td></tr>
</table>
</td></tr>
</table>`;
}

async function sendEmail({ agentName, greetingName, recipientEmails, monthLabel, customers, total, currency }) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const from = (process.env.STATEMENTS_FROM_EMAIL || '').trim();

  const pdfBase64 = await pdfFromSource(reportHtml({ agentName, monthLabel, customers, total, currency }));

  const payload = {
    from,
    to: recipientEmails,
    reply_to: 'brendan@kohindustries.com',
    subject: `Commission Report — ${monthLabel}`,
    html: emailBodyHtml({ greetingName, monthLabel, total }),
    attachments: [
      {
        filename: `Commission Report - ${agentName} - ${monthLabel}.pdf`,
        content: pdfBase64,
        content_type: 'application/pdf',
      },
    ],
  };

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

    const { agentName, greetingName, recipientEmails, monthLabel, customers, total, currency } = body;
    if (!agentName || !monthLabel || !Array.isArray(customers) || !Array.isArray(recipientEmails)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing agentName, monthLabel, customers, or recipientEmails' }) };
    }
    const validEmails = recipientEmails.map((e) => String(e || '').trim()).filter(Boolean);
    if (!validEmails.length || !validEmails.every((e) => EMAIL_RE.test(e))) {
      return { statusCode: 400, body: JSON.stringify({ error: 'recipientEmails must be a non-empty list of valid email addresses' }) };
    }

    const result = await sendEmail({ agentName, greetingName: greetingName || agentName, recipientEmails: validEmails, monthLabel, customers, total, currency });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, id: result.id }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
