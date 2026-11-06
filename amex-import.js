/* Amex Import — pure helpers, no DOM, no network.
 *
 * Reads an American Express "activity" CSV export, works out what each line is (charge / refund / card
 * payment), gives every line a stable key so the same line is never pushed to Xero twice, picks the
 * Xero account + tax for it from the saved merchant rules, and compares the file with what Xero
 * already holds on the card account.
 *
 * Loaded by index.html as a plain script (window.AMX) and by tests/amex-import.test.js.
 */
(function (root) {
  'use strict';

  // Where the card lives in Xero ("American Express® Platinum#001"), and where lines land until someone
  // codes them. Suspense is a balance-sheet holding account, so nothing hits the P&L by guesswork. Everything
  // except Facebook defaults to GST on Expenses (ordinary Australian purchases carry GST on the card statement).
  const CARD_ACCOUNT_CODE = '810';
  const FALLBACK_RULE = { account: '850', tax: 'GST on Expenses' };
  // Starter rules, keyed by the upper-case text they look for in the description. Anything the user changes
  // in the table is saved on top of these (see applyRules).
  const DEFAULT_RULES = {
    'FACEBK': { contact: 'Facebook', account: '401', tax: 'GST Free Expenses' },
  };
  const TAX_OPTIONS = ['GST on Expenses', 'GST Free Expenses', 'BAS Excluded'];

  const r2 = (n) => Math.round(n * 100) / 100;
  const pad = (n) => String(n).padStart(2, '0');

  // ── CSV ──────────────────────────────────────────────────────────────
  // Minimal RFC-4180 reader: quoted fields, "" escapes, CRLF/LF, BOM. Returns an array of string arrays.
  function parseCsv(text) {
    const s = String(text || '').replace(/^﻿/, '');
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQ) {
        if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some((f) => f !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some((f) => f !== '')) rows.push(row);
    return rows;
  }

  // Amex is Australian: DD/MM/YYYY. ISO is accepted too. Returns 'YYYY-MM-DD' or null.
  function parseDate(v) {
    const t = String(v || '').trim();
    let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
    let y, mo, d;
    if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; }
    else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return `${y}-${pad(mo)}-${pad(d)}`;
  }

  // "1,234.50" / "-70000.00" / "(12.00)" → number, or null.
  function parseAmount(v) {
    let t = String(v == null ? '' : v).trim().replace(/[$,\s]/g, '');
    if (!t) return null;
    let neg = false;
    if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
    const n = parseFloat(t);
    return r2(neg ? -n : n);
  }

  // ── Merchants ────────────────────────────────────────────────────────
  const clean = (desc) => String(desc || '').replace(/\s+/g, ' ').trim();

  // The part of the description that identifies the merchant. Amex pads "MERCHANT      LOCATION" with
  // runs of spaces; per-charge references ("*9CBGJAW5B4") and store numbers ("3389") are dropped so every
  // charge from the same merchant shares one key.
  function merchantKey(desc) {
    const first = String(desc || '').trim().split(/\s{2,}/)[0] || '';
    const noRef = first.toUpperCase().replace(/\*.*$/, '');
    const words = noRef.split(/\s+/).filter((w) => w && !/^\d+$/.test(w));
    return words.join(' ').trim();
  }

  function titleCase(s) {
    return String(s || '').toLowerCase().replace(/(^|[\s\-\/(])([a-z])/g, (m, p, c) => p + c.toUpperCase());
  }

  // ── Stable keys ──────────────────────────────────────────────────────
  // cyrb53: small, fast, deterministic 53-bit hash (same answer in the browser and in Node).
  function hash53(str, seed) {
    let h1 = 0xdeadbeef ^ (seed || 0), h2 = 0x41c6ce57 ^ (seed || 0);
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  }

  const KEY_PREFIX = 'AMEX:';

  // The Amex export has no transaction id, so a line's identity is date + amount + description, plus "which
  // one of the identical lines" (two $5.50 coffees at the same place on the same day are two real charges).
  // The processed date is left out on purpose: a pending charge can get a different processed date on the
  // next download, and it must still be recognised. If the export does carry a reference column, that wins.
  function assignKeys(rows) {
    const seen = {};
    for (const r of rows) {
      const base = r.reference
        ? `ref|${r.reference}`
        : `${r.date}|${r.cents}|${clean(r.description).toUpperCase()}`;
      seen[base] = (seen[base] || 0) + 1;
      r.key = KEY_PREFIX + hash53(`${base}|${seen[base]}`).slice(0, 12);
    }
    return rows;
  }

  // ── Parse an Amex activity export ────────────────────────────────────
  const HEADER_ALIASES = {
    date: ['date', 'transaction date'],
    processed: ['date processed', 'processed date', 'post date'],
    description: ['description', 'appears on your statement as'],
    amount: ['amount'],
    reference: ['reference'],
  };

  function findCols(header) {
    const lc = header.map((h) => String(h).trim().toLowerCase());
    const cols = {};
    for (const [name, aliases] of Object.entries(HEADER_ALIASES)) {
      const i = lc.findIndex((h) => aliases.includes(h));
      if (i >= 0) cols[name] = i;
    }
    return cols;
  }

  // A card payment shows as a negative line ("PayID Payment Received, Thank you"). Xero already holds those
  // as transfers from the bank account, so they're recognised and left out by default.
  const isPayment = (desc, cents) => cents < 0 && /payment|direct debit|thank you/i.test(desc);

  function parseAmex(text) {
    const table = parseCsv(text);
    const errors = [];
    if (!table.length) return { rows: [], errors: ['The file is empty.'] };
    const cols = findCols(table[0]);
    if (cols.date === undefined || cols.amount === undefined || cols.description === undefined) {
      return { rows: [], errors: ['This doesn\'t look like an Amex activity file — expected Date, Description and Amount columns.'] };
    }
    const rows = [];
    table.slice(1).forEach((cells, i) => {
      const lineNo = i + 2;
      const date = parseDate(cells[cols.date]);
      const amount = parseAmount(cells[cols.amount]);
      const description = clean(cells[cols.description]);
      if (!date) { errors.push(`Line ${lineNo}: unreadable date "${cells[cols.date] || ''}".`); return; }
      if (amount === null) { errors.push(`Line ${lineNo}: unreadable amount "${cells[cols.amount] || ''}".`); return; }
      if (amount === 0) return;
      const cents = Math.round(amount * 100);
      const processed = cols.processed !== undefined ? parseDate(cells[cols.processed]) : null;
      const reference = cols.reference !== undefined ? String(cells[cols.reference] || '').trim() : '';
      const kind = cents > 0 ? 'charge' : isPayment(description, cents) ? 'payment' : 'credit';
      rows.push({
        line: lineNo,
        date,
        processed: processed || date,
        description,
        raw: String(cells[cols.description] || ''),
        amount: Math.abs(amount),
        cents,
        kind,
        type: cents > 0 ? 'SPEND' : 'RECEIVE', // a refund is money back onto the card
        merchant: merchantKey(cells[cols.description]),
        reference,
      });
    });
    assignKeys(rows);
    return { rows, errors };
  }

  // ── Rules ────────────────────────────────────────────────────────────
  // Saved rules sit on top of DEFAULT_RULES. A rule matches when its key appears in the description; the
  // longest matching key wins, so a specific rule beats a general one.
  // Rules saved from the table are keyed by the merchant key (store numbers and references already removed),
  // so they're matched against that as well as the full description.
  // A saved rule may hold only some of account / tax / contact — whatever it leaves out comes from the built-in
  // rule for the same key (e.g. Facebook's contact), and then from the fallback.
  function ruleFor(description, saved, merchant) {
    const sv = saved || {};
    const keys = new Set(Object.keys(DEFAULT_RULES).concat(Object.keys(sv)));
    const d = clean(description).toUpperCase();
    const m = String(merchant || merchantKey(description)).toUpperCase();
    let best = null, bestKey = '';
    for (const k of keys) {
      const kk = String(k).toUpperCase();
      if (kk && (d.includes(kk) || m.includes(kk)) && kk.length > bestKey.length) { best = Object.assign({}, DEFAULT_RULES[k], sv[k]); bestKey = kk; }
    }
    return best;
  }

  // Equity (drawings) and revenue accounts can't carry GST on Expenses / GST Free Expenses in Xero, so moving a
  // line onto one means BAS Excluded; moving it back off restores GST on Expenses — but only if BAS Excluded was
  // that automatic switch, never over a tax the user chose on purpose.
  const NO_GST_CLASSES = ['EQUITY', 'REVENUE'];
  function taxAfterAccountChange(prevTax, prevClass, newClass) {
    if (NO_GST_CLASSES.includes(newClass)) return 'BAS Excluded';
    if (NO_GST_CLASSES.includes(prevClass) && prevTax === 'BAS Excluded') return 'GST on Expenses';
    return prevTax;
  }

  function applyRules(rows, saved) {
    for (const r of rows) {
      const rule = ruleFor(r.description, saved, r.merchant);
      r.account = (rule && rule.account) || FALLBACK_RULE.account;
      r.tax = (rule && rule.tax) || FALLBACK_RULE.tax;
      r.contact = (rule && rule.contact) || titleCase(r.merchant) || 'American Express';
      r.ruled = !!rule;
    }
    return rows;
  }

  // ── Compare with Xero ────────────────────────────────────────────────
  // existing: [{ date, type, cents, reference, reconciled }] — what Xero already has on the card account
  // in the file's date range. 'imported' = this app already pushed that exact line (matched on its key).
  // 'maybe' = same date, amount and direction exists that this app didn't create (entered by hand, or a
  // feed) — shown but left unticked so nothing is doubled up by accident.
  function classify(rows, existing) {
    const refs = new Set();
    const loose = {};
    for (const e of existing || []) {
      if (e.reference) refs.add(e.reference);
      const k = `${e.date}|${e.type}|${e.cents}`;
      loose[k] = (loose[k] || 0) + 1;
    }
    const looseUsed = {};
    for (const r of rows) {
      if (refs.has(r.key)) { r.status = 'imported'; continue; }
      if (r.kind === 'payment') { r.status = 'payment'; continue; }
      const k = `${r.date}|${r.type}|${Math.abs(r.cents)}`;
      if ((looseUsed[k] || 0) < (loose[k] || 0)) { looseUsed[k] = (looseUsed[k] || 0) + 1; r.status = 'maybe'; continue; }
      r.status = 'new';
    }
    return rows;
  }

  const isoToDmy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

  // Xero's own "Import a statement" layout. Xero reads money spent as NEGATIVE, so Amex's positive charges
  // are flipped and card payments / refunds come through positive.
  function toXeroStatementCsv(rows) {
    const lines = [['Date', 'Amount', 'Payee', 'Description', 'Reference'].join(',')];
    for (const r of rows) {
      lines.push([isoToDmy(r.date), (-r.cents / 100).toFixed(2), r.contact || titleCase(r.merchant), r.description, ''].map(csvCell).join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  function dateRange(rows) {
    let from = null, to = null;
    for (const r of rows) { if (!from || r.date < from) from = r.date; if (!to || r.date > to) to = r.date; }
    return { from, to };
  }

  const summary = (rows) => {
    const s = { total: rows.length, new: 0, newCents: 0, imported: 0, maybe: 0, payment: 0 };
    for (const r of rows) {
      if (r.status === 'new') { s.new++; s.newCents += r.cents; } // net: charges minus refunds
      else if (r.status) s[r.status]++;
    }
    return s;
  };

  root.AMX = {
    CARD_ACCOUNT_CODE, FALLBACK_RULE, DEFAULT_RULES, TAX_OPTIONS, KEY_PREFIX,
    parseCsv, parseDate, parseAmount, parseAmex, merchantKey, titleCase, hash53, assignKeys,
    ruleFor, applyRules, taxAfterAccountChange, NO_GST_CLASSES, classify, toXeroStatementCsv, dateRange, summary, isoToDmy,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.AMX;
})(typeof window !== 'undefined' ? window : globalThis);
