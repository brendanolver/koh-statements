// Run with:  node tests/amex-import.test.js
// Amex activity CSV → rows, stable keys, merchant rules, duplicate detection and Xero statement CSV.
const assert = require('assert');
const A = require('../amex-import.js');
let n = 0;
const test = (name, fn) => { try { fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };

// A slice of a real export (same quirks: padded merchant/location, quoted payment lines, repeat charges).
const SAMPLE = [
  'Date,Date Processed,Description,Amount,Flexible',
  '03/11/2026,04/11/2026,FACEBK *9CBGJAW5B4      FACEBOOK.COM,3373.49,FS',
  '03/11/2026,04/11/2026,FACEBK *JNA8DBJ5B4      FACEBOOK.COM,3373.04,FS',
  '03/11/2026,03/11/2026,WOOLWORTHS 3389         FISHERMANS BN,29.50,FS',
  '02/11/2026,02/11/2026,7-Eleven 1033           Port Melbourn,163.14,FS',
  '22/10/2026,23/10/2026,PIPIS KIOSK             ALBERT PARK,5.50,FS',
  '22/10/2026,23/10/2026,PIPIS KIOSK             ALBERT PARK,5.50,FS',
  '22/10/2026,22/10/2026,"PayID Payment Received, Thank you",-70000.00,',
  '20/10/2026,21/10/2026,W PHO VIETNAMESE 309545 SOUTH MELBOURNE,9.00,FS',
  '19/10/2026,19/10/2026,"PayID Payment Received, Thank you",-88225.77,',
  '15/10/2026,16/10/2026,SP BUTTER GOODS         PERTH,269.90,FS',
  '14/10/2026,15/10/2026,"Refund, Some Shop",-12.30,FS',
].join('\r\n');

const parsed = A.parseAmex(SAMPLE);

test('reads every line with AU dates and no errors', () => {
  assert.deepStrictEqual(parsed.errors, []);
  assert.strictEqual(parsed.rows.length, 11);
  assert.strictEqual(parsed.rows[0].date, '2026-11-03');
  assert.strictEqual(parsed.rows[0].processed, '2026-11-04');
  assert.strictEqual(parsed.rows[0].amount, 3373.49);
  assert.strictEqual(parsed.rows[0].cents, 337349);
});
test('charges are SPEND, card payments are recognised, other negatives are refunds (RECEIVE)', () => {
  assert.strictEqual(parsed.rows[0].kind, 'charge'); assert.strictEqual(parsed.rows[0].type, 'SPEND');
  const pay = parsed.rows.find((r) => r.cents === -7000000);
  assert.strictEqual(pay.kind, 'payment'); assert.strictEqual(pay.amount, 70000);
  const refund = parsed.rows.find((r) => r.cents === -1230);
  assert.strictEqual(refund.kind, 'credit'); assert.strictEqual(refund.type, 'RECEIVE'); assert.strictEqual(refund.amount, 12.3);
});
test('descriptions are tidied; merchant keys drop references and store numbers', () => {
  assert.strictEqual(parsed.rows[0].description, 'FACEBK *9CBGJAW5B4 FACEBOOK.COM');
  assert.deepStrictEqual(parsed.rows.slice(0, 4).map((r) => r.merchant), ['FACEBK', 'FACEBK', 'WOOLWORTHS', '7-ELEVEN']);
  assert.strictEqual(A.merchantKey('W PHO VIETNAMESE 309545 SOUTH MELBOURNE'), 'W PHO VIETNAMESE SOUTH MELBOURNE');
  assert.strictEqual(A.merchantKey('BARTIER BE* TICKETS-ME  NARRE WARREN SO'), 'BARTIER BE');
});
test('keys are stable, unique per line, and tell apart identical repeat charges', () => {
  const keys = parsed.rows.map((r) => r.key);
  assert.strictEqual(new Set(keys).size, keys.length, 'every line has its own key');
  assert.ok(keys.every((k) => /^AMEX:[0-9a-f]{12}$/.test(k)));
  const again = A.parseAmex(SAMPLE).rows.map((r) => r.key);
  assert.deepStrictEqual(again, keys, 'same file → same keys');
  const pipis = parsed.rows.filter((r) => r.merchant === 'PIPIS KIOSK');
  assert.strictEqual(pipis.length, 2); assert.notStrictEqual(pipis[0].key, pipis[1].key);
});
test('a later download (new lines on top, processed date changed) still gives the old lines the same keys', () => {
  const later = A.parseAmex(['Date,Date Processed,Description,Amount,Flexible', '05/11/2026,05/11/2026,NEW SHOP   MELBOURNE,10.00,FS']
    .concat(SAMPLE.split('\r\n').slice(1).map((l) => l.replace('04/11/2026', '05/11/2026'))).join('\n'));
  const oldKeys = new Set(parsed.rows.map((r) => r.key));
  assert.strictEqual(later.rows.filter((r) => oldKeys.has(r.key)).length, parsed.rows.length);
});
test('an export with its own Reference column keys off that', () => {
  const p = A.parseAmex('Date,Description,Amount,Reference\n01/11/2026,SHOP,10.00,REF123\n01/11/2026,SHOP,10.00,REF456');
  assert.notStrictEqual(p.rows[0].key, p.rows[1].key);
  const q = A.parseAmex('Date,Description,Amount,Reference\n02/11/2026,SHOP RENAMED,10.00,REF123');
  assert.strictEqual(q.rows[0].key.length, p.rows[0].key.length);
});
test('Facebook defaults to Advertising - Social Media / GST Free; everything else to Suspense with GST on Expenses', () => {
  A.applyRules(parsed.rows, null);
  assert.deepStrictEqual([parsed.rows[0].account, parsed.rows[0].tax, parsed.rows[0].contact], ['401', 'GST Free Expenses', 'Facebook']);
  const w = parsed.rows[2];
  assert.deepStrictEqual([w.account, w.tax, w.contact, w.ruled], ['850', 'GST on Expenses', 'Woolworths', false]);
});
test('Facebook lines start approved; other lines don\'t, even when a saved rule changes Facebook\'s account', () => {
  A.applyRules(parsed.rows, null);
  assert.deepStrictEqual(parsed.rows.filter((r) => r.autoApprove).map((r) => r.merchant), ['FACEBK', 'FACEBK']);
  assert.strictEqual(parsed.rows.filter((r) => !r.autoApprove).length, parsed.rows.length - 2);
  A.applyRules(parsed.rows, { FACEBK: { account: '400' }, WOOLWORTHS: { account: '480' } });
  assert.deepStrictEqual(parsed.rows.filter((r) => r.autoApprove).map((r) => r.account), ['400', '400'], 'a partial saved rule keeps the built-in approval');
  assert.strictEqual(parsed.rows.find((r) => r.merchant === 'WOOLWORTHS').autoApprove, false);
  A.applyRules(parsed.rows, null);
});
test('a saved rule can hold just some fields; the rest come from the built-in rule, then the fallback', () => {
  A.applyRules(parsed.rows, { FACEBK: { account: '400' }, WOOLWORTHS: { tax: 'GST Free Expenses' } });
  const fb = parsed.rows[0];
  assert.deepStrictEqual([fb.account, fb.tax, fb.contact], ['400', 'GST Free Expenses', 'Facebook'], 'only the account was overridden');
  const w = parsed.rows[2];
  assert.deepStrictEqual([w.account, w.tax, w.contact], ['850', 'GST Free Expenses', 'Woolworths'], 'only the tax was set');
  A.applyRules(parsed.rows, null);
});
test('moving a line onto a drawings/revenue account means BAS Excluded, and back off restores GST on Expenses', () => {
  assert.strictEqual(A.taxAfterAccountChange('GST on Expenses', 'EXPENSE', 'EQUITY'), 'BAS Excluded');
  assert.strictEqual(A.taxAfterAccountChange('GST Free Expenses', 'EXPENSE', 'REVENUE'), 'BAS Excluded');
  assert.strictEqual(A.taxAfterAccountChange('BAS Excluded', 'EQUITY', 'EXPENSE'), 'GST on Expenses');
  assert.strictEqual(A.taxAfterAccountChange('BAS Excluded', 'EQUITY', 'LIABILITY'), 'GST on Expenses');
  assert.strictEqual(A.taxAfterAccountChange('BAS Excluded', 'EXPENSE', 'EXPENSE'), 'BAS Excluded', 'a deliberate BAS Excluded is left alone');
  assert.strictEqual(A.taxAfterAccountChange('GST Free Expenses', 'EXPENSE', 'EXPENSE'), 'GST Free Expenses');
  assert.strictEqual(A.taxAfterAccountChange('GST on Expenses', 'EXPENSE', 'LIABILITY'), 'GST on Expenses');
});
test('saved rules win over defaults; the longest matching key wins', () => {
  const saved = { WOOLWORTHS: { account: '480', tax: 'GST on Expenses', contact: 'Woolworths' }, FACEBK: { account: '400', tax: 'BAS Excluded', contact: 'Meta' }, 'W PHO': { account: '420', tax: 'GST Free Expenses' }, 'W PHO VIETNAMESE SOUTH': { account: '480', tax: 'GST on Expenses' } };
  A.applyRules(parsed.rows, saved);
  assert.strictEqual(parsed.rows[2].account, '480');
  assert.strictEqual(parsed.rows[0].account, '400'); assert.strictEqual(parsed.rows[0].contact, 'Meta');
  const pho = parsed.rows.find((r) => /PHO/.test(r.description));
  assert.strictEqual(pho.account, '480', 'the longer rule beat the shorter one');
  A.applyRules(parsed.rows, null);
});
test('against Xero: exact key = already imported; same date+amount = maybe; payments = skipped; rest new', () => {
  A.applyRules(parsed.rows, null);
  const existing = [
    { date: '2026-11-03', type: 'SPEND', cents: 2950, reference: '' },                    // Woolworths entered by hand
    { date: '2026-11-02', type: 'SPEND', cents: 16314, reference: parsed.rows[3].key },   // 7-Eleven pushed by this app
    { date: '2026-10-22', type: 'SPEND', cents: 550, reference: '' },                     // only ONE of the two $5.50 coffees
  ];
  A.classify(parsed.rows, existing);
  const st = (frag) => parsed.rows.filter((r) => r.description.includes(frag)).map((r) => r.status);
  assert.deepStrictEqual(st('WOOLWORTHS'), ['maybe']);
  assert.deepStrictEqual(st('7-Eleven'), ['imported']);
  assert.deepStrictEqual(st('PIPIS'), ['maybe', 'new'], 'one existing entry covers one of the two identical charges');
  assert.deepStrictEqual(st('PayID'), ['payment', 'payment']);
  assert.deepStrictEqual(st('FACEBK'), ['new', 'new']);
  const s = A.summary(parsed.rows);
  assert.deepStrictEqual([s.total, s.imported, s.maybe, s.payment, s.new], [11, 1, 2, 2, 6]);
  assert.strictEqual(s.newCents, 337349 + 337304 + 550 + 900 + 26990 - 1230);
});
test('Xero statement CSV: spend negative, payments/refunds positive, DD/MM/YYYY, quoted where needed', () => {
  A.applyRules(parsed.rows, null);
  const csv = A.toXeroStatementCsv(parsed.rows.slice(0, 1).concat(parsed.rows.filter((r) => r.kind !== 'charge').slice(0, 1)));
  const lines = csv.trim().split('\r\n');
  assert.strictEqual(lines[0], 'Date,Amount,Payee,Description,Reference');
  assert.strictEqual(lines[1], '03/11/2026,-3373.49,Facebook,FACEBK *9CBGJAW5B4 FACEBOOK.COM,');
  assert.ok(lines[2].startsWith('22/10/2026,70000.00,'), lines[2]);
  assert.ok(lines[2].includes('"PayID Payment Received, Thank you"'), lines[2]);
});
test('bad input is reported, not guessed at', () => {
  assert.ok(A.parseAmex('').errors.length);
  assert.ok(A.parseAmex('Foo,Bar\n1,2').errors[0].includes('Amex activity file'));
  const p = A.parseAmex('Date,Description,Amount\n31/02/2026,X,5.00\n01/11/2026,Y,abc\n01/11/2026,Z,0.00\n02/11/2026,OK,1,234.50');
  assert.strictEqual(p.errors.length, 2); assert.strictEqual(p.rows.length, 1);
  assert.strictEqual(A.parseAmount('1,234.50'), 1234.5); assert.strictEqual(A.parseAmount('(12.00)'), -12);
});
test('date range of a file', () => {
  assert.deepStrictEqual(A.dateRange(parsed.rows), { from: '2026-10-14', to: '2026-11-03' });
});

console.log(`\n${n} passing${process.exitCode ? ' — with failures' : ''}`);
