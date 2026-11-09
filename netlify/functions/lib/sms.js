/* SMS helpers — pure functions, no DOM, no network.
 *
 * Shared by the Statements page (so a mobile number and message can be checked before anything is sent) and by
 * the send-sms function (which checks them again — never trust the page). Loaded by index.html as a plain script
 * (window.SMS) and by the tests / function via require.
 *
 *  • normaliseMobile  – "0412 345 678", "+61 (0)412…", "61412…" → one clean international number; tells a
 *                       landline from a mobile (an AU 02 number is a Sydney landline, but a NZ 02x number is a mobile,
 *                       so the customer's country matters).
 *  • suggestMobile    – first usable mobile out of the numbers Xero / ApparelMagic hold for a customer.
 *  • buildMessage     – the overdue text in one of three wordings (Friendly / Firm / Final), with or without held stock.
 *  • suggestTemplate  – a suggested wording from the records (the sender always decides).
 *  • segments         – how many SMS parts a message costs (plain text 160/153 characters, anything fancy 70/67).
 */
(function (root) {
  'use strict';

  const digitsOf = (s) => String(s == null ? '' : s).replace(/\D/g, '');
  const countryOf = (hint) => (/new\s*zealand|^nz$/i.test(String(hint || '').trim()) ? 'NZ' : 'AU');

  // → { ok:true, e164:'+61412345678', digits:'61412345678', display:'+61 412 345 678', country:'AU'|'NZ' }
  //   { ok:false, reason:'empty'|'landline'|'invalid'|'unsupported', note:'…' }
  function normaliseMobile(raw, countryHint) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return { ok: false, reason: 'empty', note: 'No mobile number' };
    s = s.replace(/\(0\)/g, '');                       // "+61 (0)412…" — the (0) isn't dialled internationally
    const international = /^\s*(\+|00)/.test(s);
    let d = digitsOf(s);
    const home = countryOf(countryHint);

    let intl;
    if (international) {
      intl = d.replace(/^00/, '');
    } else if (d.startsWith('0')) {
      intl = (home === 'NZ' ? '64' : '61') + d.slice(1);
    } else if (/^61\d{9}$/.test(d) || /^64\d{8,10}$/.test(d)) {
      intl = d;                                        // already international, just without the +
    } else if (home === 'AU' && /^4\d{8}$/.test(d)) {
      intl = '61' + d;                                 // 412345678 — the leading 0 got dropped (spreadsheets do this)
    } else if (home === 'NZ' && /^2\d{7,9}$/.test(d)) {
      intl = '64' + d;
    } else {
      return { ok: false, reason: 'invalid', note: 'Not a valid mobile number' };
    }

    if (intl.startsWith('61')) {
      if (/^614\d{8}$/.test(intl)) return good(intl, 'AU');
      if (/^61[2378]\d{8}$/.test(intl)) return { ok: false, reason: 'landline', note: 'Looks like a landline — enter their mobile' };
      return { ok: false, reason: 'invalid', note: 'Not a valid Australian mobile' };
    }
    if (intl.startsWith('64')) {
      if (/^642\d{7,9}$/.test(intl)) return good(intl, 'NZ');
      if (/^64[34679]\d{7,8}$/.test(intl)) return { ok: false, reason: 'landline', note: 'Looks like a landline — enter their mobile' };
      return { ok: false, reason: 'invalid', note: 'Not a valid New Zealand mobile' };
    }
    return { ok: false, reason: 'unsupported', note: 'Only Australian and New Zealand mobiles are set up' };
  }

  function good(intl, country) {
    const rest = intl.slice(2);                         // the digits after the 61 / 64
    const display = country === 'AU'
      ? `+61 ${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6)}`
      : `+64 ${rest.slice(0, 2)} ${rest.slice(2, 5)} ${rest.slice(5)}`;
    return { ok: true, e164: '+' + intl, digits: intl, display, country };
  }

  // candidates: [{ value, source }] in order of preference → { value, display, e164, source } or null.
  function suggestMobile(candidates, countryHint) {
    for (const c of candidates || []) {
      const n = normaliseMobile(c && c.value, countryHint);
      if (n.ok) return { value: c.value, display: n.display, e164: n.e164, source: c.source || '' };
    }
    return null;
  }

  // ---- first names -------------------------------------------------------------------------------------------

  // Customer records are messy ("SAM", "sam", "Accounts Payable", "Reception"): keep only things that read like a
  // person's first name — one or two plain words, nothing business-like, no digits.
  const NOT_A_NAME = /\b(pty|ltd|limited|store|shop|sports?|surf|accounts?|payable|payables|reception|office|manager|admin|team|retail|boutique|club|co|company|group|the|and|buyer|sales|info|orders?)\b|[\d&@]/i;
  function looksLikeName(raw) {
    const t = String(raw == null ? '' : raw).trim();
    if (!t || NOT_A_NAME.test(t)) return false;
    const words = t.split(/\s+/);
    return words.length <= 2 && words.every((w) => /^[A-Za-z][A-Za-z'\u2019-]+$/.test(w));
  }

  // "SAM" / "sam" → "Sam", "anne-marie" → "Anne-Marie", "o'brien" → "O'Brien". Names that already have mixed case are left alone.
  function tidyName(raw) {
    const t = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
    if (t !== t.toUpperCase() && t !== t.toLowerCase()) return t;
    return t.toLowerCase().replace(/(^|[\s'\u2019-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  }

  // candidates: [{ value, source }] best first → { name, source } for the first one that reads like a name, or null.
  function suggestName(candidates) {
    for (const c of candidates || []) {
      if (looksLikeName(c && c.value)) return { name: tidyName(c.value), source: c.source || '' };
    }
    return null;
  }

  // ---- the message -------------------------------------------------------------------------------------------

  function money(n, currency) {
    const abs = Math.abs(Number(n || 0)).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `$${abs}` + (currency && currency !== 'AUD' ? ` ${currency}` : '');
  }

  // ---- the messages ------------------------------------------------------------------------------------------
  //
  // Three wordings for an overdue account, chosen by the person sending (never switched automatically):
  //   friendly — good customers, or ones we have a positive relationship with
  //   firm     — our standard reminder (the default)
  //   final    — customers who have ignored earlier reminders, or are seriously overdue
  // Each has a version for "stock is on hold" and one without, so a customer with nothing held is never told about
  // held stock. Plain characters only (straight quotes, no emoji or dashes) to stay in the cheaper 160-character text size.
  // Texts come from the sender name WNDRR, which can't receive replies, so each one gives Brendan's mobile to call.
  const CONTACT_PHONE = '0418 519939';           // Brendan's mobile, as in the signature on his other emails

  // An Australian mobile is dialled as 04…, but from New Zealand it needs the +61.
  function phoneFor(country) {
    return countryOf(country) === 'NZ' ? '+61 418 519 939' : CONTACT_PHONE;
  }

  const TEMPLATES = {
    friendly: { key: 'friendly', label: 'Friendly Reminder', short: 'Friendly', blurb: 'For good customers, or ones we have a positive relationship with.' },
    firm:     { key: 'firm',     label: 'Firm Reminder',     short: 'Firm',     blurb: 'Our standard reminder for overdue accounts.' },
    final:    { key: 'final',    label: 'Final Reminder',    short: 'Final',    blurb: 'For customers who have ignored earlier reminders, or are seriously overdue.' },
  };
  const TEMPLATE_ORDER = ['friendly', 'firm', 'final'];

  // priorReminders = texts already sent to this customer during the current overdue period. The Final wording says
  // "despite previous reminders" ONLY when that is true of our records; otherwise that phrase is left out (the page
  // tells the sender, who may have chased by phone or email and can put it back).
  // → { template, text, hasHold, leftOutPriorReminders } or null when there is nothing overdue to chase.
  function buildMessage({ template, greet, overdue, holdTotal, currency, country, priorReminders, phone }) {
    if (!(Number(overdue) > 0)) return null;
    const tpl = TEMPLATES[template] ? template : 'firm';
    const g = greet || 'there';
    const o = money(overdue, currency);
    const hasHold = Number(holdTotal) > 0;
    const h = hasHold ? money(holdTotal, currency) : '';
    const ph = phone || phoneFor(country);
    let leftOut = false;
    let text;
    if (tpl === 'friendly') {
      text = `Hi ${g}, Brendan from WNDRR. Just following up on your overdue balance of ${o}. `
        + (hasHold ? `We've also got ${h} of stock ready to go, but can't release it until the account is brought up to date. ` : '')
        + `Can you let me know when we can expect payment? Give me a call on ${ph} if you need to discuss. Cheers, Brendan.`;
    } else if (tpl === 'firm') {
      text = `Hi ${g}, your WNDRR account has an overdue balance of ${o}`
        + (hasHold ? `, with ${h} of stock currently on hold. Please arrange payment today so we can release your stock. ` : `. Please arrange payment today. `)
        + `If there's an issue with payment, please call me on ${ph}. Thanks, Brendan.`;
    } else {
      const prior = Number(priorReminders) > 0;
      leftOut = !prior;
      text = `Hi ${g}, Brendan from WNDRR. Your account ${prior ? 'remains overdue by' : 'is overdue by'} ${o}${prior ? ' despite previous reminders' : ''}. `
        + (hasHold ? `Your outstanding orders totalling ${h} remain on hold. ` : '')
        + `We require payment or a confirmed payment arrangement today to avoid further account action. Please contact me directly on ${ph}. Brendan.`;
    }
    return { template: tpl, text, hasHold, leftOutPriorReminders: leftOut };
  }

  // A SUGGESTION for which wording to start from — never applied automatically, and based only on what the records show
  // (not on how old the invoices are). Evidence, strongest first:
  //   • 2+ texts already sent during this overdue period, or a payment promise (noted by the user) that has passed → Final
  //   • 1 text already sent, or a pattern of paying 2+ weeks late (3+ paid invoices on record)                  → Firm
  //   • no text yet AND a record of paying within a week of the due date (3+ paid invoices)                       → Friendly
  // Anything else → null (Firm stays the default and nothing is suggested).
  // { priorReminders, promiseDate:'YYYY-MM-DD'|null, avgLateDays, paidCount, overdue, today:'YYYY-MM-DD' } → { template, reason } | null
  function suggestTemplate({ priorReminders, promiseDate, avgLateDays, paidCount, overdue, today }) {
    if (!(Number(overdue) > 0)) return null;
    const n = Number(priorReminders) || 0;
    const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
    if (n >= 2) return { template: 'final', reason: `${plural(n, 'text')} already sent about this overdue balance` };
    if (promiseDate && today && promiseDate < today) return { template: 'final', reason: `a payment promise for ${promiseDate} has passed and the account is still overdue` };
    if (n === 1) return { template: 'firm', reason: '1 text already sent about this overdue balance' };
    const history = Number(paidCount) >= 3 && typeof avgLateDays === 'number';
    if (history && avgLateDays > 14) return { template: 'firm', reason: `usually pays about ${Math.round(avgLateDays)} days after the due date (${paidCount} paid invoices)` };
    if (history && avgLateDays <= 7) return { template: 'friendly', reason: `usually pays within a week of the due date (${paidCount} paid invoices) and no text has been sent yet` };
    return null;
  }

  // ---- length / cost -----------------------------------------------------------------------------------------

  // The standard SMS alphabet. Anything outside it (emoji, curly quotes, em dash, most accents) makes the whole
  // message "unicode": 70 characters per part instead of 160, so it costs more and gets cut sooner.
  const GSM_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  const GSM_EXTENDED = '^{}\\[~]|€';                    // each of these costs two characters

  function segments(text) {
    const t = String(text == null ? '' : text);
    let units = 0;
    let gsm = true;
    for (const ch of t) {
      if (GSM_BASIC.includes(ch)) units += 1;
      else if (GSM_EXTENDED.includes(ch)) units += 2;
      else { gsm = false; break; }
    }
    if (gsm) return { unicode: false, chars: units, parts: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153), max: 612 };
    const len = t.length;                              // unicode counts UTF-16 units (an emoji is two)
    return { unicode: true, chars: len, parts: len === 0 ? 0 : len <= 70 ? 1 : Math.ceil(len / 67), max: 268 };
  }

  // → { ok:true } | { ok:false, reason }
  function validateMessage(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return { ok: false, reason: 'The message is empty' };
    const s = segments(t);
    if (s.chars > s.max) return { ok: false, reason: `The message is too long (${s.chars} characters; the most is ${s.max}${s.unicode ? ' with special characters' : ''})` };
    return { ok: true };
  }

  root.SMS = { normaliseMobile, suggestMobile, looksLikeName, tidyName, suggestName, buildMessage, suggestTemplate, TEMPLATES, TEMPLATE_ORDER, money, segments, validateMessage, countryOf, phoneFor, CONTACT_PHONE };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SMS;
})(typeof window !== 'undefined' ? window : globalThis);
