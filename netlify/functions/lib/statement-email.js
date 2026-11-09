// The wording of the statement email — pulled out of send-statement.js so it can be tested without PDFShift/Resend.
//
// Two kinds of "your account is behind" message:
//   • Overdue only            → the standard nudge (unchanged): "your account could be on hold … advise when you'll pay".
//   • Overdue AND stock held  → the urgent version: it names the held stock and its value, says it can't leave until the
//                               overdue invoices are paid, and asks for a payment date today.
// Stock on hold with nothing overdue gets neither — "bring your account back within terms" wouldn't be true for them.

function fmtMoney(n) {
  const v = Number(n || 0);
  const abs = Math.abs(v).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `($${abs})` : `$${abs}`;
}

function todayFormatted(asAt) {
  return (asAt || new Date()).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}

// True only when the customer has held stock AND is actually outside terms.
function isHoldCase({ holdTotal, overdue }) {
  return Number(holdTotal) > 0 && Number(overdue) > 0;
}

// The wording for the held-stock case, as plain text pieces (the HTML below only styles them).
function holdLines({ holdTotal, holdCount, overdue, currency }) {
  const cur = currency || 'AUD';
  const orders = Number(holdCount) > 0 ? ` (${holdCount} order${Number(holdCount) === 1 ? '' : 's'})` : '';
  return {
    headline: 'Your stock is on hold',
    why: `We're holding ${fmtMoney(holdTotal)} ${cur} of your stock${orders} and can't release it while your account is outside our trading terms. You currently have ${fmtMoney(overdue)} ${cur} overdue.`,
    action: `As soon as your overdue invoices are paid we'll release your held stock — the sooner we receive payment, the sooner it's on its way to you.`,
    ask: `Can you please reply today with the date you'll be making payment, so we can get your account back within our trading terms?`,
  };
}

function emailSubject({ customerName, holdTotal, overdue }) {
  const base = `Statement from KOH Industries — ${customerName}`;
  return isHoldCase({ holdTotal, overdue }) ? `Action needed: your stock is on hold — ${base}` : base;
}

// Table-based, inline-styled — arbitrary CSS (flexbox/grid, like the full statement uses) renders unreliably across
// email clients, so this body is deliberately simpler than the statement itself; the PDF attachment is the full detail.
//
// The collections-style "your account could be on hold" paragraph only makes sense — and is only factually true — for a
// customer who actually has an overdue balance, so it's conditional on overdue > 0 rather than shown on every statement
// email (e.g. a fully-current customer getting a courtesy copy of their statement shouldn't be told they're at risk of
// being cut off).
function emailBodyHtml({ customerName, contactFirstName, recipientName, balanceDue, overdue, holdTotal, holdCount, attachedInvoiceCount, currency, asAt }) {
  // recipientName is a saved override (or Brendan's own edit right before sending) and always wins; contactFirstName
  // (Xero's on-file FirstName) is the older fallback, kept for a customer nothing's ever been set for.
  const greetName = recipientName || contactFirstName || customerName;
  const invoiceCopiesLine = attachedInvoiceCount > 0
    ? `<tr><td style="padding:0 32px 16px;font-size:13px;color:#6b7280;line-height:1.6;">Copies of the ${attachedInvoiceCount} underlying invoice${attachedInvoiceCount === 1 ? '' : 's'} are included in the attached zip file.</td></tr>`
    : '';

  let overdueBlock = '';
  if (isHoldCase({ holdTotal, overdue })) {
    const t = holdLines({ holdTotal, holdCount, overdue, currency });
    overdueBlock = `
<tr><td style="padding:0 32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff4f2;border-left:4px solid #d0021b;border-radius:4px;">
    <tr><td style="padding:14px 16px 6px;font-size:15px;font-weight:700;color:#b42318;">${t.headline}</td></tr>
    <tr><td style="padding:0 16px 10px;font-size:13px;color:#1a1a1a;line-height:1.6;">${t.why}</td></tr>
    <tr><td style="padding:0 16px 10px;font-size:13px;color:#1a1a1a;line-height:1.6;">${t.action}</td></tr>
    <tr><td style="padding:0 16px 14px;font-size:13px;color:#1a1a1a;line-height:1.6;font-weight:700;">${t.ask}</td></tr>
  </table>
</td></tr>`;
  } else if ((overdue || 0) > 0) {
    overdueBlock = `
<tr><td style="padding:0 32px 16px;font-size:13px;color:#1a1a1a;line-height:1.6;">You have received this email because you have overdue invoices &amp; your account could be on hold, which means we cannot deliver any more stock until the overdue invoices are paid.</td></tr>
<tr><td style="padding:0 32px 16px;font-size:13px;color:#1a1a1a;line-height:1.6;">Can you please advise via return email when you will be making payment to bring your account back within our trading terms?</td></tr>`;
  }

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;background:#f4f5f7;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:6px;">
<tr><td style="padding:32px 32px 8px;"><img src="https://koh-statements.netlify.app/logo.png" alt="KOH Industries" width="160" style="display:block;height:auto;"></td></tr>
<tr><td style="padding:0 32px 24px;font-size:11px;color:#6b7280;letter-spacing:2px;">WNDRR</td></tr>
<tr><td style="padding:0 32px 16px;font-size:14px;color:#1a1a1a;">Hi ${greetName},</td></tr>
<tr><td style="padding:0 32px 16px;font-size:14px;color:#1a1a1a;line-height:1.5;">Here's your statement as at ${todayFormatted(asAt)} with amount outstanding of:</td></tr>
<tr><td style="padding:0 32px 24px;">
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#6b7280;">Balance Due ${currency || 'AUD'}</div>
  <div style="font-size:28px;font-weight:700;color:#0f5c4a;">${fmtMoney(balanceDue)}</div>
</td></tr>
${overdueBlock}
${invoiceCopiesLine}
<tr><td style="padding:0 32px 24px;font-size:13px;color:#1a1a1a;line-height:1.6;">If you have any questions, please let us know.</td></tr>
<tr><td style="padding:0 32px 24px;font-size:13px;color:#1a1a1a;">Thanks,<br>Brendan Olver</td></tr>
<tr><td style="padding:16px 32px 32px;border-top:1px solid #d8dbe0;font-size:12px;color:#6b7280;">KOH Industries Pty Ltd — Unit 5, 6 Builders Close, Wendouree Victoria 3355, Australia</td></tr>
</table>
</td></tr>
</table>`;
}

module.exports = { fmtMoney, todayFormatted, isHoldCase, holdLines, emailSubject, emailBodyHtml };
