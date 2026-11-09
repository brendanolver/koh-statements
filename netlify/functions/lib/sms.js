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
 *  • buildMessage     – the overdue text, with the "stock on hold" version when that applies.
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

  // ---- the message -------------------------------------------------------------------------------------------

  function money(n, currency) {
    const abs = Math.abs(Number(n || 0)).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `$${abs}` + (currency && currency !== 'AUD' ? ` ${currency}` : '');
  }

  // Texts are sent under the sender name "WNDRR", and customers can't reply to a sender name — so every message says
  // who it is from and tells them to email instead of "reply". Plain characters only (no emoji, curly quotes or dashes)
  // so it keeps the cheap 160-character text size where it can.
  // → { kind:'hold'|'overdue', text } or null when there is nothing overdue to chase.
  const CONTACT_EMAIL = 'brendan@kohindustries.com';

  function buildMessage({ greet, overdue, holdTotal, currency, contact }) {
    if (!(Number(overdue) > 0)) return null;
    const email = contact || CONTACT_EMAIL;
    const hi = `Hi ${greet || 'there'}, it's Brendan from WNDRR.`;
    if (Number(holdTotal) > 0) {
      return {
        kind: 'hold',
        text: `${hi} Your account has ${money(overdue, currency)} overdue, so your ${money(holdTotal, currency)} of held stock can't be released. Pay today and we'll release it straight away. Please email ${email} with when you'll pay.`,
      };
    }
    return {
      kind: 'overdue',
      text: `${hi} Your account has ${money(overdue, currency)} overdue. Please email ${email} with when you'll be making payment. Thanks`,
    };
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

  root.SMS = { normaliseMobile, suggestMobile, buildMessage, money, segments, validateMessage, countryOf, CONTACT_EMAIL };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SMS;
})(typeof window !== 'undefined' ? window : globalThis);
