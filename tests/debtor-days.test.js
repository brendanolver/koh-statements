// Run with:  node tests/debtor-days.test.js
// Average days to pay: from fully-paid customer invoices to one average per customer, an overall figure, and
// exact group totals (everyone, those on stop…).
const assert = require('assert');
const D = require('../debtor-days.js');
let n = 0;
const test = (name, fn) => { try { fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };

const x = (iso) => `/Date(${Date.parse(iso + 'T00:00:00Z')}+0000)/`;
const inv = (contact, date, due, paid, extra) => Object.assign({ Status: 'PAID', Contact: { ContactID: contact, Name: contact }, Date: x(date), DueDate: x(due), FullyPaidOnDate: x(paid), Payments: [] }, extra || {});

test('an invoice becomes: customer, invoice date, due date, paid date', () => {
  assert.deepStrictEqual(D.rowFrom(inv('a', '2026-05-01', '2026-05-31', '2026-05-08')), { c: 'a', d: '2026-05-01', due: '2026-05-31', paid: '2026-05-08' });
});
test('if Xero gives no fully-paid date, the last payment (not a deleted one) is used', () => {
  const i = inv('a', '2026-05-01', '2026-05-31', '2026-05-08', { FullyPaidOnDate: undefined, Payments: [{ Date: x('2026-05-10') }, { Date: x('2026-05-20') }, { Date: x('2026-06-30'), Status: 'DELETED' }] });
  assert.strictEqual(D.rowFrom(i).paid, '2026-05-20');
});
test('invoices that are unpaid, have no date to measure against, or have no customer are left out', () => {
  assert.strictEqual(D.rowFrom(inv('a', '2026-05-01', '2026-05-31', '2026-05-08', { Status: 'AUTHORISED' })), null);
  assert.strictEqual(D.rowFrom(inv('a', '2026-05-01', '2026-05-31', '2026-05-08', { FullyPaidOnDate: undefined })), null);
  assert.strictEqual(D.rowFrom(inv('a', '2026-05-01', '2026-05-31', '2026-05-08', { Contact: {} })), null);
  assert.strictEqual(D.rowFrom(null), null);
});
test('days to pay = invoice date to paid date, per customer and overall', () => {
  const rows = [inv('a', '2026-01-01', '2026-01-31', '2026-01-31'), inv('a', '2026-02-01', '2026-03-03', '2026-03-23'), inv('b', '2026-03-01', '2026-03-31', '2026-03-11')].map(D.rowFrom);
  const agg = D.aggregate(rows);
  assert.deepStrictEqual(D.avg(agg.byContact.a), { n: 2, days: Math.round((30 + 50) / 2), late: Math.round((0 + 20) / 2) });
  assert.deepStrictEqual(D.avg(agg.byContact.b), { n: 1, days: 10, late: -20 });
  assert.deepStrictEqual(D.avg(agg), { n: 3, days: Math.round((30 + 50 + 10) / 3), late: Math.round((0 + 20 - 20) / 3) });
});
test('a payment dated before its invoice counts as 0 days; a missing due date only skips the "late" figure', () => {
  const rows = [D.rowFrom(inv('a', '2026-05-10', '2026-06-09', '2026-05-05')), D.rowFrom(inv('a', '2026-05-01', null, '2026-05-21', { DueDate: undefined }))];
  const e = D.aggregate(rows).byContact.a;
  assert.deepStrictEqual([e.n, e.days, e.nLate], [2, 0 + 20, 1]);
  assert.deepStrictEqual(D.avg(e), { n: 2, days: 10, late: -35 });
  assert.strictEqual(D.avg(D.aggregate([D.rowFrom(inv('z', '2026-05-01', null, '2026-05-21', { DueDate: undefined }))]).byContact.z).late, null);
});
test('groups combine exactly by adding invoices, not by averaging averages', () => {
  const rows = [
    ...Array.from({ length: 9 }, () => D.rowFrom(inv('big', '2026-01-01', '2026-01-31', '2026-01-21'))),   // 9 invoices at 20 days
    D.rowFrom(inv('slow', '2026-01-01', '2026-01-31', '2026-04-11')),                                        // 1 invoice at 100 days
  ];
  const agg = D.aggregate(rows);
  assert.strictEqual(D.avg(D.combine(agg.byContact, ['big', 'slow'])).days, Math.round((9 * 20 + 100) / 10), '28, not the 60 you get from averaging 20 and 100');
  assert.deepStrictEqual(D.combine(agg.byContact, ['nobody']), { n: 0, days: 0, late: 0, nLate: 0 });
  assert.strictEqual(D.avg(D.combine(agg.byContact, [])), null);
  assert.strictEqual(D.avg(D.combine(null, ['big'])), null);
});
test('colour band follows lateness: on time, up to two weeks late, later', () => {
  assert.deepStrictEqual(['a', 'b', 'c', 'd', 'e'].map((_, i) => D.band([{ late: -5 }, { late: 0 }, { late: 14 }, { late: 15 }, { late: null }][i])), ['ok', 'ok', 'warn', 'bad', 'none']);
  assert.strictEqual(D.band(null), 'none');
});
test('the tooltip wording reads naturally for early, on time, late, one invoice and no history', () => {
  assert.strictEqual(D.describe({ n: 12, days: 47, late: 9 }), '12 paid invoices in the last 12 months · paid 9 days after the due date, on average');
  assert.strictEqual(D.describe({ n: 1, days: 20, late: -1 }), '1 paid invoice in the last 12 months · paid 1 day before the due date, on average');
  assert.strictEqual(D.describe({ n: 3, days: 30, late: 0 }), '3 paid invoices in the last 12 months · paid on the due date, on average');
  assert.strictEqual(D.describe({ n: 3, days: 30, late: null }), '3 paid invoices in the last 12 months');
  assert.strictEqual(D.describe(null), 'No invoices paid in the last 12 months');
});

console.log(`\n${n} passing${process.exitCode ? ' — with failures' : ''}`);
