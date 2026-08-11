const { pdfFromSource } = require('./lib/pdf');

const RESEND_URL = 'https://api.resend.com/emails';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Short, internal-facing body — this goes to KOH staff, not a customer, so
// it skips the branded customer-statement template and just carries the
// same plain wording the mailto: link used to (see the removed
// emailDebtorsList()) plus the KOH signature already established for the
// Commission report email.
function emailBodyHtml({ dateStr }) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;background:#f4f5f7;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:6px;">
<tr><td style="padding:32px 32px 8px;"><img src="https://koh-statements.netlify.app/logo.png" alt="KOH Industries" width="160" style="display:block;height:auto;"></td></tr>
<tr><td style="padding:0 32px 24px;font-size:11px;color:#6b7280;letter-spacing:2px;">WNDRR</td></tr>
<tr><td style="padding:0 32px 16px;font-size:14px;color:#1a1a1a;line-height:1.6;">Please find attached the Debtors Overdue List as at ${dateStr}.</td></tr>
<tr><td style="padding:0 32px 28px;font-size:14px;color:#1a1a1a;line-height:1.6;">Customers highlighted in red are on stop supply.</td></tr>
<tr><td style="padding:20px 32px 4px;border-top:1px solid #d8dbe0;font-size:14px;color:#1a1a1a;">Regards,</td></tr>
<tr><td style="padding:14px 32px 16px;">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="padding-right:16px;"><img src="https://koh-statements.netlify.app/logo.png" alt="KOH Industries" width="86" style="display:block;height:auto;"></td>
    <td style="border-left:2px solid #1a1a1a;padding-left:16px;">
      <div style="font-size:16px;font-weight:800;color:#1a1a1a;line-height:1.3;">Brendan Olver</div>
      <div style="font-size:13px;font-weight:600;color:#1a1a1a;line-height:1.3;">Director</div>
    </td>
  </tr></table>
</td></tr>
<tr><td style="padding:0 32px 32px;font-size:12px;color:#1a1a1a;line-height:1.8;">
  Mobile: 0418 519939<br>
  Email: brendan@kohindustries.com<br>
  Unit 5, 6 Builders Close,<br>
  Wendouree VIC 3355
</td></tr>
</table>
</td></tr>
</table>`;
}

async function sendEmail({ recipientEmails, html, dateStr }) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const from = (process.env.STATEMENTS_FROM_EMAIL || '').trim();

  const pdfBase64 = await pdfFromSource(html);

  const payload = {
    from,
    to: recipientEmails,
    reply_to: 'brendan@kohindustries.com',
    subject: `Debtors Overdue List ${dateStr}`,
    html: emailBodyHtml({ dateStr }),
    attachments: [
      {
        filename: `Debtors Overdue List ${dateStr}.pdf`,
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

    const { html, recipientEmails, dateStr } = body;
    if (!html || !dateStr || !Array.isArray(recipientEmails)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing html, dateStr, or recipientEmails' }) };
    }
    const validEmails = recipientEmails.map((e) => String(e || '').trim()).filter(Boolean);
    if (!validEmails.length || !validEmails.every((e) => EMAIL_RE.test(e))) {
      return { statusCode: 400, body: JSON.stringify({ error: 'recipientEmails must be a non-empty list of valid email addresses' }) };
    }

    const result = await sendEmail({ recipientEmails: validEmails, html, dateStr });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, id: result.id }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
