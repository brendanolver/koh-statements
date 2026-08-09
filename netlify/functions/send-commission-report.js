const RESEND_URL = 'https://api.resend.com/emails';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fmtMoney(n) {
  const v = Number(n || 0);
  const abs = Math.abs(v).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `($${abs})` : `$${abs}`;
}

// Table-based, inline-styled — same email-client-safe constraints as
// send-statement.js's emailBodyHtml. No PDF attachment for v1 (there's no
// existing "commission statement PDF" to replicate the way customer
// statements have) — the table itself, grouped Customer -> Invoice matching
// AM's own "Commission Report (Transaction Currency)", is the report.
function emailBodyHtml({ agentName, monthLabel, customers, total, currency }) {
  const customerBlocks = (customers || []).map((cust) => {
    const rows = (cust.invoices || []).map((li) => `
      <tr>
        <td style="padding:6px 8px;font-size:12px;color:#1a1a1a;border-bottom:1px solid #eee;">Invoice ${li.invoiceNum}</td>
        <td style="padding:6px 8px;font-size:12px;color:#1a1a1a;border-bottom:1px solid #eee;">${li.date || ''}</td>
        <td style="padding:6px 8px;font-size:12px;color:#6b7280;border-bottom:1px solid #eee;">${li.po || ''}</td>
        <td style="padding:6px 8px;font-size:12px;color:#1a1a1a;text-align:right;border-bottom:1px solid #eee;">${li.rate}%</td>
        <td style="padding:6px 8px;font-size:12px;color:#1a1a1a;text-align:right;font-weight:600;border-bottom:1px solid #eee;">${fmtMoney(li.commission)}</td>
      </tr>`).join('');
    return `
      <tr><td colspan="5" style="padding:16px 0 4px;font-size:12px;font-weight:700;color:#1a1a1a;">${cust.customerName}</td></tr>
      ${rows}
      <tr><td colspan="4" style="padding:6px 8px;font-size:12px;font-weight:700;color:#1a1a1a;text-align:right;">Subtotal</td><td style="padding:6px 8px;font-size:12px;font-weight:700;color:#1a1a1a;text-align:right;">${fmtMoney(cust.subtotal)}</td></tr>`;
  }).join('');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;background:#f4f5f7;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:6px;">
<tr><td style="padding:32px 32px 8px;"><img src="https://koh-statements.netlify.app/logo.png" alt="KOH Industries" width="160" style="display:block;height:auto;"></td></tr>
<tr><td style="padding:0 32px 24px;font-size:11px;color:#6b7280;letter-spacing:2px;">WNDRR</td></tr>
<tr><td style="padding:0 32px 8px;font-size:14px;color:#1a1a1a;">Hi ${agentName},</td></tr>
<tr><td style="padding:0 32px 16px;font-size:14px;color:#1a1a1a;line-height:1.5;">Here's your commission report for ${monthLabel}:</td></tr>
<tr><td style="padding:0 32px 24px;">
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#6b7280;">Total Commission ${currency || 'AUD'}</div>
  <div style="font-size:28px;font-weight:700;color:#0f5c4a;">${fmtMoney(total)}</div>
</td></tr>
<tr><td style="padding:0 32px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${customerBlocks}
</table>
</td></tr>
<tr><td style="padding:24px 32px 24px;font-size:13px;color:#1a1a1a;line-height:1.6;">If anything looks off, let us know and we'll check it.</td></tr>
<tr><td style="padding:0 32px 24px;font-size:13px;color:#1a1a1a;">Thanks,<br>Brendan Olver</td></tr>
<tr><td style="padding:16px 32px 32px;border-top:1px solid #d8dbe0;font-size:12px;color:#6b7280;">KOH Industries Pty Ltd — Unit 5, 6 Builders Close, Wendouree Victoria 3355, Australia</td></tr>
</table>
</td></tr>
</table>`;
}

async function sendEmail({ agentName, recipientEmail, monthLabel, customers, total, currency }) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const from = (process.env.STATEMENTS_FROM_EMAIL || '').trim();

  const payload = {
    from,
    to: recipientEmail,
    reply_to: 'brendan@kohindustries.com',
    subject: `Commission Report — ${monthLabel}`,
    html: emailBodyHtml({ agentName, monthLabel, customers, total, currency }),
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

    if (!process.env.RESEND_API_KEY || !process.env.STATEMENTS_FROM_EMAIL) {
      return { statusCode: 500, body: JSON.stringify({ error: 'RESEND_API_KEY / STATEMENTS_FROM_EMAIL not configured' }) };
    }

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { agentName, recipientEmail, monthLabel, customers, total, currency } = body;
    if (!agentName || !recipientEmail || !monthLabel || !Array.isArray(customers)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing agentName, recipientEmail, monthLabel, or customers' }) };
    }
    if (!EMAIL_RE.test(recipientEmail)) {
      return { statusCode: 400, body: JSON.stringify({ error: `"${recipientEmail}" doesn't look like a valid email address` }) };
    }

    const result = await sendEmail({ agentName, recipientEmail, monthLabel, customers, total, currency });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, id: result.id }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
