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
test('previous year = the same dates a year earlier; month-end periods stay month-end (incl. leap years)', () => {
  assert.deepStrictEqual(P.priorYear('2025-07-01', '2026-06-30'), { from: '2024-07-01', to: '2025-06-30' });
  assert.deepStrictEqual(P.priorYear('2025-10-01', '2026-09-30'), { from: '2024-10-01', to: '2025-09-30' });
  assert.deepStrictEqual(P.priorYear('2027-03-01', '2028-02-29'), { from: '2026-03-01', to: '2027-02-28' }, 'a leap-year month end maps to the 28th');
  assert.deepStrictEqual(P.priorYear('2025-03-01', '2026-02-28'), { from: '2024-03-01', to: '2025-02-28' });
  assert.deepStrictEqual(P.priorYear('2024-02-29', '2024-05-15'), { from: '2023-02-28', to: '2023-05-15' }, 'a mid-month custom range just moves back a year');
});
test('compare: lines are matched by account, sections by title; lines in only one year show 0 in the other', () => {
  const cur = P.parseReport(mk(['x'], [['Sales - Online', [100]], ['Sales - Wholesale', [50]]], [['COGS', [60]]], [['Wages', [20]], ['New Software', [5]]]));
  const prv = P.parseReport(mk(['x'], [['Sales - Online', [80]], ['Old Channel', [10]]], [['COGS', [50]]], [['Wages', [18]], ['Rent', [4]]]));
  const c = P.compareReports(cur, prv);
  const inc = c.sections[0]; assert.strictEqual(inc.title, 'Income');
  assert.deepStrictEqual(inc.rows.map((r) => [r.name, r.values[0], r.prior]), [['Sales - Online', 100, 80], ['Sales - Wholesale', 50, 0], ['Old Channel', 0, 10]]);
  assert.deepStrictEqual([inc.summary.values[0], inc.summary.prior], [150, 90]);
  const ex = c.sections.find((s) => s.title === 'Less Operating Expenses'); assert.deepStrictEqual(ex.rows.map((r) => [r.name, r.values[0], r.prior]), [['Wages', 20, 18], ['New Software', 5, 0], ['Rent', 0, 4]]);
  const net = c.sections.find((s) => !s.title && s.rows[0].name === 'Net Profit').rows[0]; assert.deepStrictEqual([net.values[0], net.prior], [150 - 60 - 25, 90 - 50 - 22]);
  const gp = c.sections.find((s) => !s.title && s.rows[0].name === 'Gross Profit').rows[0]; assert.deepStrictEqual([gp.values[0], gp.prior], [90, 40]);
  assert.strictEqual(c.compare, true);
});
test('compare: a section that only existed last year is kept (before the profit lines); no prior data = all zeros', () => {
  const cur = P.parseReport(mk(['x'], [['Sales', [100]]], [], [['Wages', [20]]]));
  const prv = P.parseReport(mk(['x'], [['Sales', [90]]], [['COGS', [30]]], [['Wages', [20]]]));
  const c = P.compareReports(cur, prv); const titles = c.sections.map((s) => s.title);
  assert.ok(titles.indexOf('Less Cost of Sales') > -1 && titles.indexOf('Less Cost of Sales') < titles.indexOf(''), 'COS section placed before the untitled profit sections: ' + JSON.stringify(titles));
  assert.deepStrictEqual(c.sections.find((s) => s.title === 'Less Cost of Sales').rows[0], { name: 'COGS', id: null, values: [0], prior: 30 });
  const none = P.compareReports(cur, { columns: [], sections: [] }); assert.strictEqual(none.sections[0].rows[0].prior, 0);
});
test('percentage change: sign-correct, relative to the size of last year, blank when last year was zero', () => {
  assert.strictEqual(P.pctChange(110, 100), 10); assert.strictEqual(P.pctChange(90, 100), -10); assert.strictEqual(P.pctChange(50, 0), null);
  assert.strictEqual(P.pctChange(-50, -100), 50, 'a loss that halves is +50% better'); assert.strictEqual(P.pctChange(100, -100), 200);
});
test('opening and closing stock lines are recognised by name (and only those)', () => {
  for (const ok of ['Opening Stock', 'Closing Stock', 'opening stock', ' Closing Stock ', 'Opening Inventory']) assert.strictEqual(P.isStockRow(ok), true, ok);
  for (const no of ['Cost of Goods Sold', 'Stock Adjustments', 'Freight & Courier', 'Stockholding costs', 'Closing balance', '']) assert.strictEqual(P.isStockRow(no), false, no);
});
test('stock totals: opening + closing (closing is negative in Xero) = the net stock movement inside Cost of Sales', () => {
  // the shape of the real report: Opening 581,930.52 / COGS / Freight / Closing -583,206.82, Total Cost of Sales 5,554,843.31
  const cos = [['Opening Stock', [581930.52]], ['Cost of Goods Sold', [4546837.53]], ['Freight & Courier', [1009282.08]], ['Closing Stock', [-583206.82]]];
  const r = P.parseReport(mk(['30 Sep 26'], [['Sales', [11274985.36]]], cos, [['Rent', [1]]]));
  const st = P.stockTotals(r.sections);
  assert.deepStrictEqual(st, { opening: 581930.52, closing: -583206.82, found: 2, net: -1276.3 });
  assert.ok(Math.abs(r.sections[1].summary.values[0] - 5554843.31) < 0.005, 'Xero\'s Total Cost of Sales still includes the stock lines');
  assert.strictEqual(P.stockTotals(P.parseReport(mk(['x'], [['S', [1]]], [['COGS', [1]]], [['R', [1]]])).sections).found, 0);
});
test('stock totals add across month columns, and work on the merged comparison shape too', () => {
  const r = P.parseReport(mk(['30 Sep 2026', '31 Aug 2026'], [['S', [5, 5]]], [['Opening Stock', [100, 90]], ['Closing Stock', [-110, -100]]], [['R', [1, 1]]]));
  assert.deepStrictEqual(P.stockTotals(r.sections), { opening: 190, closing: -210, found: 2, net: -20 });
  const c = P.compareReports(P.parseReport(mk(['x'], [['S', [5]]], [['Opening Stock', [100]], ['Closing Stock', [-110]]], [['R', [1]]])), P.parseReport(mk(['x'], [['S', [5]]], [['Opening Stock', [80]], ['Closing Stock', [-90]]], [['R', [1]]])));
  assert.deepStrictEqual(P.stockTotals(c.sections), { opening: 100, closing: -110, found: 2, net: -10 }, 'this period only (values), not the prior-year figures');
});
test('compare: lines still pair by name when only one side carries Xero account ids', () => {
  const withIds = P.parseReport(mk(['x'], [['Sales', [100]]], [['Opening Stock', [10]]], [['Rent', [5]]]));
  const noIds = P.parseReport(mk(['x'], [['Sales', [80]]], [['Opening Stock', [8]]], [['Rent', [4]]]));
  for (const s of noIds.sections) for (const r of s.rows) r.id = null;
  for (const s of withIds.sections) for (const r of s.rows) r.id = 'acct-' + r.name;
  const c = P.compareReports(withIds, noIds);
  assert.deepStrictEqual(c.sections.find((s) => s.title === 'Less Cost of Sales').rows.map((r) => [r.name, r.values[0], r.prior]), [['Opening Stock', 10, 8]]);
  assert.strictEqual(c.sections[0].rows.length, 1, 'no duplicate Sales line');
});
test('quarter labels follow a Jul–Jun financial year', () => {
  assert.deepStrictEqual(P.quarterLabel('2026-07'), { label: 'Q1 FY27', sub: 'Jul–Sep 26' }); assert.deepStrictEqual(P.quarterLabel('2026-10'), { label: 'Q2 FY27', sub: 'Oct–Dec 26' });
  assert.deepStrictEqual(P.quarterLabel('2027-01'), { label: 'Q3 FY27', sub: 'Jan–Mar 27' }); assert.deepStrictEqual(P.quarterLabel('2027-04'), { label: 'Q4 FY27', sub: 'Apr–Jun 27' });
});
test('quarters for a range: snapped out to whole quarters, stop at the current month, at most the latest 4', () => {
  const t = '2026-10-03', q = (f, to) => P.quarterRange(f, to, t);
  const fy = q('2025-07-01', '2026-06-30'); assert.deepStrictEqual(fy.quarters.map((x) => x.label), ['Q1 FY26', 'Q2 FY26', 'Q3 FY26', 'Q4 FY26']); assert.ok(fy.quarters.every((x) => x.months.length === 3 && !x.partial));
  const l12 = q('2025-10-01', '2026-09-30'); assert.deepStrictEqual(l12.quarters.map((x) => x.sub), ['Oct–Dec 25', 'Jan–Mar 26', 'Apr–Jun 26', 'Jul–Sep 26']);
  const cy = q('2026-01-01', '2026-12-31'); assert.deepStrictEqual(cy.quarters.map((x) => [x.sub, x.months.length, x.partial]), [['Jan–Mar 26', 3, false], ['Apr–Jun 26', 3, false], ['Jul–Sep 26', 3, false], ['Oct–Dec 26', 1, true]], 'October only so far: part-finished');
  const mid = q('2026-02-10', '2026-04-20'); assert.deepStrictEqual(mid.quarters.map((x) => [x.sub, x.months.length, x.partial]), [['Jan–Mar 26', 3, false], ['Apr–Jun 26', 3, false]], 'a mid-quarter range widens to whole quarters at BOTH ends; a finished quarter is never "part-finished"');
  assert.deepStrictEqual(q('2026-08-15', '2026-09-10').quarters.map((x) => [x.sub, x.months.length]), [['Jul–Sep 26', 3]]);
  assert.deepStrictEqual(q('2026-10-01', '2026-10-31').quarters.map((x) => [x.sub, x.months.length, x.partial]), [['Oct–Dec 26', 1, true]], 'only the quarter in progress is partial');
  const long = q('2018-01-01', '2026-10-03'); assert.strictEqual(long.quarters.length, 4); assert.strictEqual(long.capped, true); assert.strictEqual(long.quarters[0].sub, 'Jan–Mar 26'); assert.ok(long.total > 30);
  assert.deepStrictEqual(q('2027-01-01', '2027-12-31').quarters, []);
});
test('quarter request = the monthly report covering exactly those months', () => {
  const t = '2026-10-03';
  assert.deepStrictEqual(P.requestFor('quarter', '2025-07-01', '2026-06-30', t), { path: 'Reports/ProfitAndLoss', fromDate: '2026-06-01', toDate: '2026-06-30', periods: '11', timeframe: 'MONTH' });
  assert.deepStrictEqual(P.requestFor('quarter', '2026-01-01', '2026-12-31', t), { path: 'Reports/ProfitAndLoss', fromDate: '2026-10-01', toDate: '2026-10-31', periods: '9', timeframe: 'MONTH' });
  assert.deepStrictEqual(P.requestFor('quarter', '2026-10-01', '2026-12-31', t), { path: 'Reports/ProfitAndLoss', fromDate: '2026-10-01', toDate: '2026-10-31' }, 'one month so far, no comparison periods');
  assert.strictEqual(P.requestFor('quarter', '2027-01-01', '2027-12-31', t), null);
  assert.deepStrictEqual(P.requestFor('quarter', '2025-07-01', '2026-06-30', t), P.requestFor('month', '2025-07-01', '2026-06-30', t), 'a full FY asks Xero the same thing as By month, so the cached report is shared');
});
test('months add up into quarters; nothing is lost; rows, summaries and profit lines all aggregate', () => {
  const hdr = ['31 Dec 2025', '30 Nov 2025', '31 Oct 2025', '30 Sep 2025', '31 Aug 2025', '31 Jul 2025']; // newest first, as Xero sends them
  const rep = P.parseReport(mk(hdr, [['Sales', [60, 50, 40, 30, 20, 10]]], [['COGS', [6, 5, 4, 3, 2, 1]]], [['Rent', [1, 1, 1, 1, 1, 1]]]));
  const qs = P.quarterRange('2025-07-01', '2025-12-31', '2026-01-15').quarters;
  const q = P.toQuarters(rep, qs);
  assert.deepStrictEqual(q.columns.map((c) => c.label), ['Q1 FY26', 'Q2 FY26']);
  assert.deepStrictEqual(q.sections[0].rows[0].values, [60, 150], 'Sales: Jul–Sep = 10+20+30, Oct–Dec = 40+50+60');
  assert.deepStrictEqual(q.sections[0].summary.values, [60, 150]);
  const h0 = P.headline(q, 0), h1 = P.headline(q, 1); assert.deepStrictEqual([h0.income, h0.cost, h0.grossProfit, h0.netProfit], [60, 6, 54, 51]); assert.deepStrictEqual([h1.income, h1.netProfit], [150, 150 - 15 - 3]);
  assert.strictEqual(P.headline(q, 'sum').income, 210); assert.strictEqual(P.headline(rep, 'sum').income, 210, 'the quarter total equals the monthly total');
  assert.strictEqual(P.headline(q, 'sum').netProfit, P.headline(rep, 'sum').netProfit);
});
test('a part-finished quarter is flagged and still totals correctly', () => {
  const rep = P.parseReport(mk(['31 Oct 2026', '30 Sep 2026', '31 Aug 2026', '31 Jul 2026'], [['Sales', [40, 30, 20, 10]]], [['C', [0, 0, 0, 0]]], [['R', [0, 0, 0, 0]]]));
  const qs = P.quarterRange('2026-07-01', '2026-12-31', '2026-10-20').quarters;
  const q = P.toQuarters(rep, qs); assert.deepStrictEqual(q.columns.map((c) => [c.sub, c.partial]), [['Jul–Sep 26', false], ['Oct–Dec 26', true]]); assert.deepStrictEqual(q.sections[0].rows[0].values, [60, 40]);
});
console.log(`\n${n} passing${process.exitCode ? ' — with failures' : ''}`);
