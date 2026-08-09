const { pdfFromSource } = require('./lib/pdf');
const { buildCommissionReportHtml, fmtMoney } = require('./lib/commission-report-html');

const RESEND_URL = 'https://api.resend.com/emails';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  const pdfBase64 = await pdfFromSource(buildCommissionReportHtml({ agentName, monthLabel, customers, total, currency }));

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
