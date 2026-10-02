// Run with:  node tests/debtors-feed.test.js
// Proves the server-side debtors builder gives the same numbers as the Debtors tab's own
// buildDebtorsList() (extracted from index.html and run against the same fixtures).
process.env.TZ = 'Australia/Melbourne';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { buildDebtors, bucketLabels, decorate, todayIso } = require('../netlify/functions/lib/debtors');

const FIXED = Date.parse('2026-10-02T10:00:00+10:00');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function extractFn(src, header) {
  const start = src.indexOf(header);
  assert(start >= 0, 'not found: ' + header);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(start, i + 1);
}
const clientSrc = [
  "const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];",
  'let AGING_BUCKET_LABELS = [];',
  extractFn(html, 'function xeroDate('),
  extractFn(html, 'function buildAgingBucketLabels('),
  extractFn(html, 'function invoiceBucketIndex('),
  extractFn(html, 'async function buildDebtorsList('),
].join('\n');

const ms = (iso) => `/Date(${Date.parse(iso + 'T00:00:00Z')}+0000)/`;
const C = (id, name) => ({ ContactID: id, Name: name });
const inv = (c, date, due, amt, cur = 'AUD') => ({ Contact: c, Date: ms(date), DueDate: ms(due), AmountDue: amt, Total: amt, CurrencyCode: cur });
const A = C('a', 'ALPHA PTY LTD'), B = C('b', 'BETA NZ'), D = C('d', 'DELTA HOLD ONLY'), E = C('e', 'ECHO');
const openInvoices = [
  inv(A, '2026-10-01', '2026-10-31', 1000.10),   // current month, not due
  inv(A, '2026-09-05', '2026-10-02', 250),       // due today → NOT overdue
  inv(A, '2026-08-15', '2026-10-01', 400.55),    // due yesterday → overdue, 2 months back
  inv(A, '2025-12-01', '2026-01-01', 99.99),     // older
  inv(B, '2026-07-31', '2026-08-30', 500, 'NZD'),// 3 months back
  inv(B, '2026-06-30', '2026-07-30', 10, 'NZD'), // 4 months → older
  inv(E, '2026-05-01', '2026-05-31', 75),
];
const creditNotes = [
  { Contact: A, Date: ms('2026-08-20'), RemainingCredit: 50, CurrencyCode: 'AUD' },
  { Contact: B, Date: ms('2026-09-10'), RemainingCredit: 5.5, CurrencyCode: 'NZD' },
];
const submittedInvoices = [
  { Contact: D, Total: 1234.5, CurrencyCode: 'AUD' },   // holds stock, owes nothing
  { Contact: A, Total: 300, CurrencyCode: 'AUD' },
];

(async () => {
  const today = todayIso(new Date(FIXED));
  assert.strictEqual(today, '2026-10-02');

  const ctx = { assert, Promise, Math, Number, String, isNaN, Map, Array, Set, customers: [] };
  ctx.Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(FIXED); } static now() { return FIXED; } };
  ctx.fetchAllOpenInvoicesOrgWide = async () => openInvoices;
  ctx.fetchSubmittedInvoicesOrgWide = async () => submittedInvoices;
  ctx.fetchOutstandingCreditNotesOrgWide = async () => creditNotes;
  ctx.fetchContactsByIds = async () => [];
  vm.createContext(ctx);
  vm.runInContext(clientSrc + '\nthis.__build = buildDebtorsList; this.__labels = () => AGING_BUCKET_LABELS;', ctx);
  const clientRows = await ctx.__build();
  const clientLabels = ctx.__labels();

  const rows = buildDebtors({ openInvoices, submittedInvoices, creditNotes, today });
  assert.strictEqual(JSON.stringify(bucketLabels(today)), JSON.stringify(clientLabels), 'bucket labels differ');

  const byId = (arr) => Object.fromEntries(arr.map((r) => [r.contactId, r]));
  const c = byId(clientRows), s = byId(rows);
  assert.deepStrictEqual(Object.keys(s).sort(), Object.keys(c).sort(), 'different customers');
  for (const id of Object.keys(c)) {
    assert.strictEqual(s[id].name, c[id].name);
    for (const f of ['total', 'overdue', 'holdTotal']) {
      assert.strictEqual(s[id][f], Math.round(c[id][f] * 100) / 100, `${id}.${f}: server ${s[id][f]} vs client ${c[id][f]}`);
    }
    assert.strictEqual(JSON.stringify(s[id].buckets), JSON.stringify(Array.from(c[id].buckets, (v) => Math.round(v * 100) / 100)), `${id} buckets`);
    assert.strictEqual(s[id].creditCount, c[id].creditCount || 0, `${id} creditCount`);
  }
  assert.deepStrictEqual(rows.map((r) => r.contactId), clientRows.map((r) => r.contactId), 'sort order differs');

  // spot-check the edge cases directly
  assert.strictEqual(s.a.overdue, 400.55 + 99.99, 'due-today must not count as overdue; due-yesterday must');
  assert.strictEqual(s.d.total, 0); assert.strictEqual(s.d.holdTotal, 1234.5);
  assert.strictEqual(s.b.currency, 'NZD'); assert.strictEqual(s.d.currency, 'AUD');

  // status / hidden / stats
  const out = decorate(rows, { a: 'stop', b: 'clear' }, { ECHO: { reason: 'x' } });
  assert.strictEqual(out.hiddenCount, 1);
  assert(!out.debtors.find((d) => d.name === 'ECHO'));
  assert.deepStrictEqual(out.stats, { onStop: 1, cleared: 1, pending: 0, stockOnHold: 2, totalOnStop: s.a.total, eligible: 2 });
  console.log('debtors-feed tests passed (' + rows.length + ' customers match the Debtors tab)');
})().catch((e) => { console.error(e); process.exit(1); });
