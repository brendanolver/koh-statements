// Run with:  node tests/pnl-report.test.js
const assert = require('assert');
const P = require('../pnl-report.js');
let n = 0;
const test = (name, fn) => { try { fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };
const cell = (v, id) => ({ Value: String(v), ...(id ? { Attributes: [{ Value: id, Id: 'account' }] } : {}) });
const line = (name, vals, id) => ({ RowType: 'Row', Cells: [cell(name, id), ...vals.map((v) => cell(v))] });
const sum = (name, vals) => ({ RowType: 'SummaryRow', Cells: [cell(name), ...vals.map((v) => cell(v))] });
// A report shaped like Xero's: header, Income, Less Cost of Sales, untitled Gross Profit, Less Operating Expenses, untitled Net Profit.
const mk = (hdr, inc, cos, opx) => {
  const t = (rows) => hdr.map((_, i) => rows.reduce((a, r) => a + r[i], 0));
  const I = t(inc.map((r) => r[1])), C = t(cos.map((r) => r[1])), X = t(opx.map((r) => r[1]));
  const G = I.map((v, i) => v - C[i]), N = G.map((v, i) => v - X[i]);
  return { Reports: [{ ReportName: 'Profit and Loss', Rows: [
    { RowType: 'Header', Cells: [cell(''), ...hdr.map((h) => cell(h))] },
    { RowType: 'Section', Title: 'Income', Rows: [...inc.map((r) => line(r[0], r[1], 'a-' + r[0])), sum('Total Income', I)] },
    { RowType: 'Section', Title: 'Less Cost of Sales', Rows: [...cos.map((r) => line(r[0], r[1])), sum('Total Cost of Sales', C)] },
    { RowType: 'Section', Title: '', Rows: [line('Gross Profit', G)] },
    { RowType: 'Section', Title: 'Less Operating Expenses', Rows: [...opx.map((r) => line(r[0], r[1])), sum('Total Operating Expenses', X)] },
    { RowType: 'Section', Title: '', Rows: [line('Net Profit', N)] },
  ] }] };
};

test('month labels are read from Xero header text', () => {
  assert.strictEqual(P.monthOfLabel('30 Sep 2026'), '2026-09'); assert.strictEqual(P.monthOfLabel('Sep 2026'), '2026-09'); assert.strictEqual(P.monthOfLabel('1 September 2026'), '2026-09'); assert.strictEqual(P.monthOfLabel('Total'), null);
});
test('a single-column report parses into sections, lines and summary rows', () => {
  const r = P.parseReport(mk(['30 Sep 2026'], [['Sales - Online', [100000]], ['Sales - Wholesale', [50000]]], [['Product costs', [60000]]], [['Wages', [20000]], ['Rent', [5000]]]));
  assert.strictEqual(r.columns.length, 1); assert.deepStrictEqual(r.sections.map((s) => s.title), ['Income', 'Less Cost of Sales', '', 'Less Operating Expenses', '']);
  assert.strictEqual(r.sections[0].rows[0].id, 'a-Sales - Online'); assert.strictEqual(r.sections[0].summary.values[0], 150000);
  const h = P.headline(r, 0);
  assert.deepStrictEqual([h.income, h.cost, h.grossProfit, h.opex, h.netProfit, h.margin], [150000, 60000, 90000, 25000, 65000, 43.33]);
});
test('comparison columns arrive newest-first and are put oldest-first, values staying with their month', () => {
  const r = P.parseReport(mk(['30 Sep 2026', '31 Aug 2026', '31 Jul 2026'], [['Sales', [300, 200, 100]]], [['COGS', [30, 20, 10]]], [['Wages', [50, 50, 50]]]));
  assert.deepStrictEqual(r.columns.map((c) => c.month), ['2026-07', '2026-08', '2026-09']); assert.strictEqual(r.assumedOrder, false);
  assert.deepStrictEqual(r.sections[0].rows[0].values, [100, 200, 300]); assert.deepStrictEqual(r.sections[0].summary.values, [100, 200, 300]);
  assert.deepStrictEqual(P.headline(r, 0), { income: 100, cost: 10, grossProfit: 90, opex: 50, netProfit: 40, margin: 40 });
  assert.strictEqual(P.headline(r, 'sum').income, 600); assert.strictEqual(P.headline(r, 'sum').netProfit, 90 + 180 + 270 - 150 + 0, 'net profit sums across months: 540-150=390');
});
test('already-ascending headers are left alone; unreadable headers fall back to newest-first and say so', () => {
  const asc = P.parseReport(mk(['31 Jul 2026', '31 Aug 2026'], [['S', [1, 2]]], [['C', [0, 0]]], [['X', [0, 0]]]));
  assert.deepStrictEqual(asc.sections[0].rows[0].values, [1, 2]);
  const unk = P.parseReport(mk(['Col A', 'Col B'], [['S', [1, 2]]], [['C', [0, 0]]], [['X', [0, 0]]]));
  assert.deepStrictEqual(unk.sections[0].rows[0].values, [2, 1]); assert.strictEqual(unk.assumedOrder, true);
});
test('numbers with commas, blanks and negatives are read correctly', () => {
  assert.strictEqual(P.num('1,234,567.89'), 1234567.89); assert.strictEqual(P.num('-45.5'), -45.5); assert.strictEqual(P.num(''), 0); assert.strictEqual(P.num(undefined), 0);
});
test('a business with no cost of sales: gross profit falls back to income, net still read from Net Profit', () => {
  const rep = { Reports: [{ Rows: [{ RowType: 'Header', Cells: [cell(''), cell('Sep 2026')] }, { RowType: 'Section', Title: 'Income', Rows: [line('Fees', [1000]), sum('Total Income', [1000])] }, { RowType: 'Section', Title: 'Less Operating Expenses', Rows: [line('Rent', [400]), sum('Total Operating Expenses', [400])] }, { RowType: 'Section', Title: '', Rows: [line('Net Profit', [600])] }] }] };
  const h = P.headline(P.parseReport(rep), 0); assert.strictEqual(h.grossProfit, 1000); assert.strictEqual(h.cost, null); assert.strictEqual(h.netProfit, 600);
});
test('not a report -> null; empty report -> no columns', () => {
  assert.strictEqual(P.parseReport({}), null); assert.strictEqual(P.parseReport({ Reports: [{}] }), null); assert.deepStrictEqual(P.parseReport({ Reports: [{ Rows: [] }] }).columns, []);
});
test('by-month range snaps to whole months, stops at the current month, caps at the latest 12', () => {
  const t = '2026-10-03';
  assert.deepStrictEqual(P.monthRange('2025-07-01', '2026-06-30', t).months.length, 12);
  const l12 = P.monthRange('2025-11-01', '2026-10-03', t); assert.strictEqual(l12.months[0], '2025-11'); assert.strictEqual(l12.months[11], '2026-10');
  const cy = P.monthRange('2026-01-01', '2026-12-31', t); assert.strictEqual(cy.months.length, 10, 'Jan..Oct — future months are not requested');
  const long = P.monthRange('2020-01-01', '2026-10-03', t); assert.strictEqual(long.months.length, 12); assert.strictEqual(long.capped, true); assert.strictEqual(long.months[0], '2025-11');
  assert.deepStrictEqual(P.monthRange('2027-01-01', '2027-12-31', t).months, []);
});
test('request: total = the plain range; month = latest month as base + (n-1) earlier months', () => {
  const t = '2026-10-03';
  assert.deepStrictEqual(P.requestFor('total', '2025-07-01', '2026-06-30', t), { path: 'Reports/ProfitAndLoss', fromDate: '2025-07-01', toDate: '2026-06-30' });
  assert.deepStrictEqual(P.requestFor('month', '2025-07-01', '2026-06-30', t), { path: 'Reports/ProfitAndLoss', fromDate: '2026-06-01', toDate: '2026-06-30', periods: '11', timeframe: 'MONTH' });
  assert.deepStrictEqual(P.requestFor('month', '2026-09-01', '2026-09-30', t), { path: 'Reports/ProfitAndLoss', fromDate: '2026-09-01', toDate: '2026-09-30' }, 'a single month needs no comparison periods');
  assert.deepStrictEqual(P.requestFor('month', '2026-01-01', '2026-12-31', t), { path: 'Reports/ProfitAndLoss', fromDate: '2026-10-01', toDate: '2026-10-31', periods: '9', timeframe: 'MONTH' });
  assert.strictEqual(P.requestFor('month', '2027-01-01', '2027-12-31', t), null);
});
test('last 12 completed months = 12 whole months ending last month (never the part-finished current one)', () => {
  assert.deepStrictEqual(P.last12Completed('2026-10-03'), { from: '2025-10-01', to: '2026-09-30' });
  assert.deepStrictEqual(P.last12Completed('2026-10-31'), { from: '2025-10-01', to: '2026-09-30' });
  assert.deepStrictEqual(P.last12Completed('2026-01-01'), { from: '2025-01-01', to: '2025-12-31' }, 'crosses the year boundary');
  assert.deepStrictEqual(P.last12Completed('2024-03-15'), { from: '2023-03-01', to: '2024-02-29' }, 'leap-year February');
  const r = P.last12Completed('2026-10-03'); assert.strictEqual(P.monthRange(r.from, r.to, '2026-10-03').months.length, 12);
});
console.log(`\n${n} passing${process.exitCode ? ' — with failures' : ''}`);
