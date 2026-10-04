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

test('Xero\'s real two-digit-year headings are understood (so columns are ordered by date, not guessed)', () => {
  assert.strictEqual(P.monthOfLabel('30 Sep 26'), '2026-09'); assert.strictEqual(P.monthOfLabel('28 Feb 26'), '2026-02'); assert.strictEqual(P.monthOfLabel('31 Dec 25'), '2025-12');
  const hdr = ['31 Oct 26', '30 Sep 26', '31 Aug 26'];
  const r = P.parseReport(mk(hdr, [['Sales', [3, 2, 1]]], [['C', [0, 0, 0]]], [['R', [0, 0, 0]]]));
  assert.deepStrictEqual(r.columns.map((c) => c.month), ['2026-08', '2026-09', '2026-10']); assert.strictEqual(r.assumedOrder, false, 'headings were read, nothing was assumed');
  assert.deepStrictEqual(r.sections[0].rows[0].values, [1, 2, 3]);
});
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
test('Total view asks Xero for the plain range', () => {
  assert.deepStrictEqual(P.requestFor('total', '2025-07-01', '2026-06-30'), { path: 'Reports/ProfitAndLoss', fromDate: '2025-07-01', toDate: '2026-06-30' });
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
  assert.deepStrictEqual(c.sections.find((s) => s.title === 'Less Cost of Sales').rows[0], { name: 'COGS', id: null, values: [0], priorValues: [30], prior: 30 });
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
test('monthly plan: always anchored on a 31-day month (Xero keeps the base END DAY when stepping back)', () => {
  const R = (fromDate, toDate, periods) => ({ path: 'Reports/ProfitAndLoss', fromDate, toDate, ...(periods ? { periods: String(periods), timeframe: 'MONTH' } : {}) });
  const mons = (a, b) => { const o = []; for (let k = a; k <= b; k = P.monthRange(k + '-01', k + '-28', '2099-01-01').months.length ? (() => { const [y, m] = k.split('-').map(Number); const d = new Date(Date.UTC(y, m, 1)); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); })() : '9999') o.push(k); return o; };
  // last month already has 31 days: anchor on it, one request
  const jan = P.monthlyPlan(mons('2026-01', '2026-10')); assert.deepStrictEqual(jan.map((s) => s.request), [R('2026-10-01', '2026-10-31', 9)]); assert.strictEqual(jan[0].keep.length, 10);
  // last month has 30 days: anchor on the NEXT month (31 days) and drop its column
  const sep = P.monthlyPlan(mons('2025-11', '2026-09')); assert.deepStrictEqual(sep.map((s) => s.request), [R('2026-10-01', '2026-10-31', 11)]); assert.deepStrictEqual([sep[0].keep[0], sep[0].keep[10]], ['2025-11', '2026-09']);
  // a full 12 months ending in a 30-day month: 13 columns would be needed but Xero allows 12, so the oldest month is its own request
  const fy = P.monthlyPlan(mons('2025-07', '2026-06')); assert.deepStrictEqual(fy.map((s) => s.request), [R('2025-07-01', '2025-07-31'), R('2026-07-01', '2026-07-31', 11)]);
  assert.deepStrictEqual(fy.map((s) => s.keep.length), [1, 11]); assert.strictEqual(fy[0].keep[0], '2025-07'); assert.strictEqual(fy[1].keep[0], '2025-08');
  const l12 = P.monthlyPlan(mons('2025-10', '2026-09')); assert.deepStrictEqual(l12.map((s) => s.request), [R('2025-10-01', '2025-10-31'), R('2026-10-01', '2026-10-31', 11)]);
  // February (28 days) -> anchor on March; single months
  assert.deepStrictEqual(P.monthlyPlan(['2026-02']).map((s) => s.request), [R('2026-03-01', '2026-03-31', 1)]); assert.deepStrictEqual(P.monthlyPlan(['2026-09']).map((s) => s.request), [R('2026-10-01', '2026-10-31', 1)]);
  assert.deepStrictEqual(P.monthlyPlan(['2026-10']).map((s) => s.request), [R('2026-10-01', '2026-10-31')]); assert.deepStrictEqual(P.monthlyPlan([]), []);
  // a request never asks for more than Xero's 11 comparison periods
  for (const last of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12']) for (const n of [1, 5, 11, 12]) {
    const ms = []; let k = last; for (let i = 0; i < n; i++) { ms.unshift(k); const [y, m] = k.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); k = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }
    const plan = P.monthlyPlan(ms); assert.ok(plan.every((s) => Number(s.request.periods || 0) <= 11), last + ' n=' + n); assert.deepStrictEqual(plan.flatMap((s) => s.keep), ms, 'every wanted month is covered exactly once, in order');
  }
});
test('monthsFor: By quarter over a full FY wants the same months as By month', () => {
  const t = '2026-10-03';
  assert.deepStrictEqual(P.monthsFor('quarter', '2025-07-01', '2026-06-30', t), P.monthsFor('month', '2025-07-01', '2026-06-30', t));
  assert.deepStrictEqual(P.monthsFor('quarter', '2026-01-01', '2026-12-31', t).slice(-1), ['2026-10']); assert.deepStrictEqual(P.monthsFor('month', '2027-01-01', '2027-12-31', t), []);
});
test('simulated Xero (end day kept when stepping back): the plan reproduces the true monthly figures; the old single-request approach lost the 31sts', () => {
  const dim = (mk) => Number(P.lastDay ? P.lastDay(mk).slice(8) : 30);
  const addM = (mk, n) => { const [y, m] = mk.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); };
  const perDay = (mk) => 1000 + Number(mk.slice(5)) * 10; // income per day in that month
  const truth = (mk) => perDay(mk) * dim(mk);
  const MONN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // what Xero returns for { fromDate, toDate, periods }: base month then k months back, each ending on min(base end day, month length)
  const xero = (req) => {
    const base = req.fromDate.slice(0, 7), endDay = Number(req.toDate.slice(8)), k = Number(req.periods || 0), cols = [];
    for (let i = 0; i <= k; i++) { const mk = addM(base, -i), end = Math.min(endDay, dim(mk)); cols.push({ mk, label: `${String(end).padStart(2, '0')} ${MONN[Number(mk.slice(5)) - 1]} ${mk.slice(0, 4)}`, v: perDay(mk) * end }); }
    return mk2report(cols);
  };
  const mk2report = (cols) => P.parseReport({ Reports: [{ Rows: [{ RowType: 'Header', Cells: [cell(''), ...cols.map((c) => cell(c.label))] }, { RowType: 'Section', Title: 'Income', Rows: [line('Sales', cols.map((c) => c.v)), sum('Total Income', cols.map((c) => c.v))] }] }] });
  const run = (months) => P.monthlyPlan(months).map((step) => P.keepMonths(xero(step.request), step.keep)).reduce((a, b) => (a ? P.mergeColumns(a, b) : b), null);
  const cases = [['2025-07', '2026-06'], ['2025-10', '2026-09'], ['2025-11', '2026-09'], ['2026-01', '2026-10'], ['2026-02', '2026-02'], ['2025-03', '2026-02']];
  for (const [a, b] of cases) {
    const months = []; for (let k = a; k <= b; k = addM(k, 1)) months.push(k);
    const rep = run(months);
    assert.deepStrictEqual(rep.columns.map((c) => c.month), months, `${a}..${b}: columns are exactly the wanted months, oldest first`);
    assert.deepStrictEqual(rep.sections[0].rows[0].values, months.map(truth), `${a}..${b}: every month is the FULL month`);
    assert.strictEqual(P.headline(rep, 'sum').income, months.reduce((s, m) => s + truth(m), 0), 'and the months add up to the true total');
  }
  // the naive request (base = the last month, 30 days) loses the 31st of every 31-day month — the bug this plan fixes
  const naive = xero({ path: 'x', fromDate: '2026-09-01', toDate: '2026-09-30', periods: '11' });
  const naiveSum = naive.sections[0].rows[0].values.reduce((a, b) => a + b, 0), trueSum = P.monthsFor('month', '2025-10-01', '2026-09-30', '2026-10-03').reduce((s, m) => s + truth(m), 0);
  assert.ok(naiveSum < trueSum, `naive ${naiveSum} < true ${trueSum}`);
});
test('keepMonths / mergeColumns: dropping the extra column and joining reports keep every line aligned', () => {
  const rep = P.parseReport(mk(['31 Oct 2026', '30 Sep 2026', '31 Aug 2026'], [['Sales', [3, 2, 1]], ['Only recent', [9, 0, 0]]], [['COGS', [30, 20, 10]]], [['Rent', [5, 5, 5]]]));
  const kept = P.keepMonths(rep, ['2026-08', '2026-09']); assert.deepStrictEqual(kept.columns.map((c) => c.month), ['2026-08', '2026-09']); assert.deepStrictEqual(kept.sections[0].rows[0].values, [1, 2]);
  const single = P.parseReport(mk(['31 Jul 2026'], [['Sales', [7]], ['Old line', [4]]], [['COGS', [70]]], [['Rent', [5]]]));
  const merged = P.mergeColumns(single, kept);
  assert.deepStrictEqual(merged.columns.map((c) => c.month), [null, '2026-08', '2026-09'].map((x, i) => (i === 0 ? single.columns[0].month : x)));
  const inc = merged.sections[0]; const byName = Object.fromEntries(inc.rows.map((r) => [r.name, r.values]));
  assert.deepStrictEqual(byName['Sales'], [7, 1, 2]); assert.deepStrictEqual(byName['Only recent'], [0, 0, 0], 'a line absent from the older column is 0 there'); assert.deepStrictEqual(byName['Old line'], [4, 0, 0], 'a line only in the older column is 0 in the newer ones');
  assert.deepStrictEqual(inc.summary.values.length, 3); assert.strictEqual(merged.sections.find((s) => !s.title && s.rows[0].name === 'Net Profit').rows[0].values.length, 3);
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
test('quarters a year earlier are the same months shifted back 12 (a quarter in progress compares like-for-like)', () => {
  const now = P.quarterRange('2026-01-01', '2026-12-31', '2026-10-20').quarters;
  const prv = P.priorQuarters(now);
  assert.deepStrictEqual(prv.map((q) => q.sub), ['Jan–Mar 25', 'Apr–Jun 25', 'Jul–Sep 25', 'Oct–Dec 25']);
  assert.deepStrictEqual(prv[3].months, ['2025-10'], 'only October of last year, to match October so far');
  assert.deepStrictEqual(P.monthlyPlan(prv.flatMap((q) => q.months)).map((s) => s.request), [{ path: 'Reports/ProfitAndLoss', fromDate: '2025-10-01', toDate: '2025-10-31', periods: '9', timeframe: 'MONTH' }]);
});
test('compare across several columns: every quarter keeps its own previous-year value; totals reconcile', () => {
  const qs = P.quarterRange('2025-07-01', '2026-06-30', '2026-10-03').quarters;
  const monthsNow = qs.flatMap((q) => q.months), monthsPrev = P.priorQuarters(qs).flatMap((q) => q.months);
  const mkMonthly = (months, base) => P.parseReport(mk(months.slice().reverse().map((m) => '28 ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m.slice(5)) - 1] + ' ' + m.slice(0, 4)), [['Sales', months.map((m, i) => base + i).reverse()]], [['COGS', months.map(() => 1).reverse()]], [['Rent', months.map(() => 1).reverse()]]));
  const cur = P.toQuarters(mkMonthly(monthsNow, 100), qs), prv = P.toQuarters(mkMonthly(monthsPrev, 90), P.priorQuarters(qs));
  const c = P.compareReports(cur, prv); const sales = c.sections[0].rows[0];
  assert.deepStrictEqual(sales.values, [303, 312, 321, 330].map((x, i) => 3 * 100 + 9 * i + 3), 'this year per quarter: 3 months of 100+i');
  assert.deepStrictEqual(sales.priorValues, [0, 1, 2, 3].map((i) => 3 * 90 + 9 * i + 3), 'previous year per quarter');
  const tot = (a) => a.reduce((x, y) => x + y, 0);
  assert.strictEqual(tot(sales.values), P.headline(cur, 'sum').income); assert.strictEqual(tot(sales.priorValues), P.headline(prv, 'sum').income);
  assert.strictEqual(c.sections[0].summary.priorValues.length, 4); assert.strictEqual(c.columns.length, 4);
  const net = c.sections.find((s) => !s.title && s.rows[0].name === 'Net Profit').rows[0]; assert.strictEqual(tot(net.priorValues), P.headline(prv, 'sum').netProfit);
});
// ---- trading P&L: separate % of goods cost for Online and Wholesale sales (figures from three real months + a wholesale line) ----
const real3 = () => P.parseReport(mk(['31 Jan 2026', '28 Feb 2026', '31 Mar 2026'],
  [['Sales - Online', [350000, 380000, 1000000]], ['Sales AM - Wholesale AU', [100000, 50000, 200000]], ['Freight Invoiced', [94934, 87527, 198123]]],
  [['Cost of Goods Sold', [593490, 15313, 582382]], ['Freight & Courier', [72556, 56075, 50601]]], [['Wages', [40000, 40000, 40000]], ['Rent', [10000, 10000, 10000]]]));
const rnd = (x) => Math.round(x * 100) / 100;
const COS = (rep) => rep.sections.find((x) => x.title === 'Less Cost of Sales'), GP = (rep) => rep.sections.find((x) => !x.title && x.rows[0].name === 'Gross Profit').rows[0].values;
test('goods lines are recognised (opening/closing stock, cost of goods sold, purchases) — freight and the rest are not', () => {
  for (const ok of ['Opening Stock', 'Closing Stock', 'Cost of Goods Sold', 'Cost of Goods', 'Purchases', 'Purchases - Stock']) assert.strictEqual(P.isGoodsRow(ok), true, ok);
  for (const no of ['Freight & Courier', 'Packaging', 'Stock Adjustments', 'Merchant fees', 'Sales']) assert.strictEqual(P.isGoodsRow(no), false, no);
});
test('income lines are sorted into online, wholesale and other by account name', () => {
  for (const [name, kind] of [['Sales - Online', 'online'], ['Shopify Sales', 'online'], ['Sales AM - Wholesale AU', 'wholesale'], ['Sales AM - Wholesale NZ', 'wholesale'], ['Freight Invoiced', 'other'], ['Sales - Retail', 'other']]) assert.strictEqual(P.incomeKind(name), kind, name);
});
test('goodsInfo: income by channel and the actual goods cost % (of online + wholesale sales) come straight from the report', () => {
  const info = P.goodsInfo(real3());
  assert.deepStrictEqual(info.kindIncome.online, [350000, 380000, 1000000]); assert.deepStrictEqual(info.kindIncome.wholesale, [100000, 50000, 200000]); assert.deepStrictEqual(info.kindIncome.other, [94934, 87527, 198123]);
  assert.deepStrictEqual(info.actual, [593490, 15313, 582382]); assert.strictEqual(info.totalActual, 1191185);
  assert.strictEqual(info.salesTotal, 2080000); assert.strictEqual(info.actualPct, rnd((1191185 / 2080000) * 100));
  assert.strictEqual(P.goodsInfo(P.parseReport({ Reports: [{ Rows: [{ RowType: 'Header', Cells: [cell(''), cell('x')] }] }] })).found, false);
});
test('trading view: each channel gets its own % of its own income; freight and other income stay actual; profit moves by exactly the difference', () => {
  const rep = real3(), before = P.headline(rep, 'sum');
  const tv = P.tradingView(rep, { online: 40, wholesale: 55 }); assert.strictEqual(tv.applied, true);
  const onl = [350000, 380000, 1000000].map((x) => rnd(x * 0.4)), whl = [100000, 50000, 200000].map((x) => rnd(x * 0.55));
  assert.deepStrictEqual(tv.modelledBy.online, onl); assert.deepStrictEqual(tv.modelledBy.wholesale, whl);
  assert.deepStrictEqual(tv.modelled, onl.map((x, i) => rnd(x + whl[i])));
  const cos = COS(tv.report);
  assert.deepStrictEqual(cos.rows.map((r) => r.name), ['Cost of goods – Online (40% of online sales)', 'Cost of goods – Wholesale (55% of wholesale sales)', 'Freight & Courier']);
  assert.deepStrictEqual(cos.rows[0].values, onl); assert.deepStrictEqual(cos.rows[1].values, whl); assert.ok(cos.rows[0].modelled && cos.rows[1].modelled && !cos.rows[2].modelled);
  assert.deepStrictEqual(cos.rows[2].values, [72556, 56075, 50601], 'freight untouched');
  assert.deepStrictEqual(cos.summary.values, [0, 1, 2].map((i) => rnd(onl[i] + whl[i] + [72556, 56075, 50601][i])), 'Total Cost of Sales = modelled goods + actual freight');
  const after = P.headline(tv.report, 'sum');
  assert.strictEqual(after.income, before.income, 'income unchanged'); assert.strictEqual(after.opex, before.opex, 'operating expenses unchanged');
  assert.strictEqual(rnd(after.netProfit - before.netProfit), tv.totalDelta); assert.strictEqual(rnd(after.grossProfit - before.grossProfit), tv.totalDelta);
  assert.strictEqual(tv.totalDelta, rnd(1191185 - tv.totalModelled));
  assert.deepStrictEqual(GP(tv.report), [0, 1, 2].map((i) => rnd([544934, 517527, 1398123][i] - onl[i] - whl[i] - [72556, 56075, 50601][i])), 'gross profit = income - modelled goods - freight');
  assert.strictEqual(tv.blendedPct, rnd((tv.totalModelled / 2080000) * 100));
});
test('trading view smooths the lumps: every month now carries exactly its channel %s', () => {
  const tv = P.tradingView(real3(), { online: 40, wholesale: 55 }), c = COS(tv.report).rows;
  c[0].values.forEach((v, i) => assert.ok(Math.abs((v / tv.info.kindIncome.online[i]) * 100 - 40) < 0.01));
  c[1].values.forEach((v, i) => assert.ok(Math.abs((v / tv.info.kindIncome.wholesale[i]) * 100 - 55) < 0.01));
});
test('trading view needs a valid % for each channel that has income; otherwise the report is returned untouched and says what is missing', () => {
  const rep = real3();
  for (const bad of [null, undefined, '', 'abc', -5, 101]) {
    const tv = P.tradingView(rep, { online: bad, wholesale: 50 }); assert.strictEqual(tv.applied, false); assert.strictEqual(tv.report, rep); assert.deepStrictEqual(tv.missing, ['online']);
  }
  assert.deepStrictEqual(P.tradingView(rep, { online: 40 }).missing, ['wholesale']); assert.deepStrictEqual(P.tradingView(rep, null).missing, ['online', 'wholesale']);
  assert.strictEqual(P.tradingView(rep, { online: 0, wholesale: 100 }).applied, true, '0% and 100% are allowed');
  // a channel with no income in the period needs no %
  const onlineOnly = P.parseReport(mk(['x'], [['Sales - Online', [1000]], ['Freight Invoiced', [50]]], [['Cost of Goods Sold', [700]]], [['Rent', [100]]]));
  const o = P.tradingView(onlineOnly, { online: 40, wholesale: '' }); assert.strictEqual(o.applied, true); assert.deepStrictEqual(o.need, ['online']);
  assert.deepStrictEqual(COS(o.report).rows.map((r) => r.name), ['Cost of goods – Online (40% of online sales)']); assert.strictEqual(P.headline(o.report, 0).netProfit, 1050 - 400 - 100);
  const noGoods = P.parseReport(mk(['x'], [['Sales - Online', [100]]], [['Freight & Courier', [10]]], [['Rent', [5]]])); assert.strictEqual(P.tradingView(noGoods, { online: 40, wholesale: 40 }).applied, false);
  const noSales = P.parseReport(mk(['x'], [['Freight Invoiced', [100]]], [['Cost of Goods Sold', [10]]], [['Rent', [5]]])); const ns = P.tradingView(noSales, { online: 40, wholesale: 40 }); assert.strictEqual(ns.applied, false); assert.ok(ns.noChannels);
});
test('trading view works on a quarter-aggregated report and on a single-column report, and the prior year can use the same %s', () => {
  const months = P.parseReport(mk(['31 Dec 2025', '30 Nov 2025', '31 Oct 2025'], [['Sales - Online', [300, 200, 100]], ['Sales AM - Wholesale AU', [30, 20, 10]]], [['Opening Stock', [10, 0, 0]], ['Cost of Goods Sold', [50, 400, 5]], ['Closing Stock', [-20, 0, 0]]], [['Rent', [1, 1, 1]]]));
  const q = P.toQuarters(months, P.quarterRange('2025-10-01', '2025-12-31', '2026-02-01').quarters);
  const tv = P.tradingView(q, { online: 50, wholesale: 20 }); assert.strictEqual(tv.applied, true); assert.deepStrictEqual(tv.modelled, [300 + 12], '50% of online 600 + 20% of wholesale 60');
  const m = P.tradingView(months, { online: 50, wholesale: 20 }).modelled.reduce((a, b) => a + b, 0); assert.strictEqual(m, tv.modelled[0], 'quarter = sum of the months (the % is linear)');
  const mkOne = (on, wh, cogs) => P.parseReport(mk(['x'], [['Sales - Online', [on]], ['Sales AM - Wholesale AU', [wh]]], [['Cost of Goods Sold', [cogs]], ['Freight', [50]]], [['Rent', [100]]]));
  const s1 = P.tradingView(mkOne(1000, 500, 700), { online: 40, wholesale: 60 }); assert.strictEqual(P.headline(s1.report, 0).netProfit, 1500 - 400 - 300 - 50 - 100);
  const c = P.compareReports(s1.report, P.tradingView(mkOne(800, 400, 500), { online: 40, wholesale: 60 }).report);
  const rows = c.sections.find((x) => x.title === 'Less Cost of Sales').rows;
  assert.ok(rows[0].modelled && rows[1].modelled); assert.deepStrictEqual([rows[0].values[0], rows[0].priorValues[0], rows[1].values[0], rows[1].priorValues[0]], [400, 320, 300, 240]);
});
console.log(`\n${n} passing${process.exitCode ? ' — with failures' : ''}`);
