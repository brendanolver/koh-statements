// Run with:  node tests/cashflow-lastyear.test.js
// "Last year as the starting point": from next month on, Wholesale, Stock, Marketing and Other cash out are
// planned as last year's same month x (1 + the Worst / Base / Best %), with anything already known counting
// towards the plan, manual overrides still winning, and the rest of this month left alone.
const assert = require('assert');
const CFE = require('../cashflow-engine.js');
const { addDays } = CFE.util;

let n = 0;
const test = (name, fn) => { try { fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };
const near = (a, b, tol = 0.01, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);

const TODAY = '2026-09-20'; // planned months: Oct 2026 … Aug 2027, from Oct 2025 … Aug 2026
const base = (over = {}) => ({ today: TODAY, cashToday: 100000, ar: [], ap: [], amOrders: [], amPOs: null, termsByCustomer: {}, shopify: null, history: null, overrides: {}, settings: null, ...over });
const row = (o) => ({ wholesale: 0, stock: 0, marketing: 0, otherOut: 0, ...o });
const LY = {
  '2025-10': row({ wholesale: 30000, stock: 50000, marketing: 40000, otherOut: 20000 }),
  '2025-11': row({ wholesale: 60000, stock: 80000, marketing: 90000, otherOut: 25000 }),
};
const items = (r, scn, line, mk) => r.scenarios[scn].items.filter((i) => i.line === line && (!mk || i.date.startsWith(mk)));
const total = (r, scn, line, mk) => items(r, scn, line, mk).reduce((a, i) => a + i.amount, 0);
const lyItems = (r, scn, line, mk) => items(r, scn, line, mk).filter((i) => i.source === 'Last year');

console.log('Last year as the starting point');
test('each planned month is last year\'s same month x (1 + the scenario %): Worst / Base / Best', () => {
  const r = CFE.buildForecast(base({ lastYear: LY }));
  near(total(r, 'base', 'wholesale', '2026-10'), 30000);
  near(total(r, 'worst', 'wholesale', '2026-10'), 30000 * 0.9, 0.01, 'worst wholesale -10%');
  near(total(r, 'best', 'wholesale', '2026-10'), 30000 * 1.05, 0.01, 'best wholesale +5%');
  near(total(r, 'base', 'marketing', '2026-11'), 90000);
  near(total(r, 'worst', 'marketing', '2026-11'), 90000 * 1.05, 0.01, 'worst spend +5%');
  near(total(r, 'best', 'marketing', '2026-11'), 90000 * 0.95, 0.01, 'best spend -5%');
  near(total(r, 'worst', 'otherOut', '2026-10'), 20000 * 1.05);
  near(total(r, 'base', 'stock', '2026-11'), 80000);
});
test('the stock % is its own setting (0 by default) and applies to last year\'s stock payments', () => {
  assert.strictEqual(CFE.mergeSettings(null).scenarios.worst.stock, 0);
  const r = CFE.buildForecast(base({ lastYear: LY, settings: { scenarios: { worst: { stock: -20 }, best: { stock: 10 } } } }));
  near(total(r, 'worst', 'stock', '2026-10'), 50000 * 0.8);
  near(total(r, 'base', 'stock', '2026-10'), 50000);
  near(total(r, 'best', 'stock', '2026-10'), 50000 * 1.1);
});
test('the plan is spread evenly over the month and labelled as last year\'s pattern', () => {
  const r = CFE.buildForecast(base({ lastYear: LY, settings: { scenarios: { base: { out: 10 } } } }));
  const mk = lyItems(r, 'base', 'marketing', '2026-10');
  assert.strictEqual(mk.length, 31);
  near(mk[0].amount, (40000 * 1.1) / 31, 0.01);
  assert.ok(mk.every((i) => i.status === 'assumption' && i.label === "Last year's Oct 25 pattern (+10%)"));
  assert.ok(/Oct 25 marketing x \(1 \+ 10%\)/.test(mk[0].meta.method), mk[0].meta.method);
});
test('anything already known for that line and month counts towards the plan — only the shortfall is added', () => {
  // an invoice due 1 Oct lands on 8 Oct (due + 7 late days): 10,000 of the 30,000 plan is already known
  const known = CFE.buildForecast(base({ lastYear: LY, ar: [{ id: 'a', contact: 'ACME', amountDue: 10000, currency: 'AUD', dueDate: '2026-10-01', online: false }] }));
  near(total(known, 'base', 'wholesale', '2026-10'), 30000);
  near(lyItems(known, 'base', 'wholesale', '2026-10').reduce((a, i) => a + i.amount, 0), 20000);
  // known amounts bigger than the plan are simply kept
  const big = CFE.buildForecast(base({ lastYear: LY, ar: [{ id: 'a', contact: 'ACME', amountDue: 40000, currency: 'AUD', dueDate: '2026-10-01', online: false }] }));
  near(total(big, 'base', 'wholesale', '2026-10'), 40000);
  assert.strictEqual(lyItems(big, 'base', 'wholesale', '2026-10').length, 0);
  // same for supplier bills (stock) and tax bills (other out)
  const bills = CFE.buildForecast(base({ lastYear: LY, ap: [{ id: 'b', number: 'B1', contact: 'FACTORY', amountDueAud: 20000, currency: 'AUD', dueDate: '2026-10-10' }, { id: 't', number: 'T1', contact: 'Australian Taxation Office', amountDueAud: 5000, currency: 'AUD', dueDate: '2026-10-28' }] }));
  near(total(bills, 'base', 'stock', '2026-10'), 50000);
  near(total(bills, 'base', 'otherOut', '2026-10'), 20000);
});
test('the rest of this month keeps the usual logic (run-rate), planned months stand in for it', () => {
  const r = CFE.buildForecast(base({ lastYear: LY, history: { marketingPerWeek: 7000, otherOutPerWeek: 0, stockPerWeek: 0 } }));
  near(total(r, 'base', 'marketing', '2026-09'), 10 * 1000, 0.01, '21–30 Sep: 10 days of the weekly run-rate');
  assert.strictEqual(lyItems(r, 'base', 'marketing', '2026-09').length, 0);
  near(total(r, 'base', 'marketing', '2026-10'), 40000, 0.01, 'Oct is last year\'s Oct, not the run-rate');
});
test('a month last year can\'t cover falls back to the run-rate, and only covered months are reported', () => {
  const r = CFE.buildForecast(base({ lastYear: LY, history: { marketingPerWeek: 7000, otherOutPerWeek: 0, stockPerWeek: 0 } }));
  near(total(r, 'base', 'marketing', '2026-12'), 31 * 1000, 0.01, 'no Dec 2025 in the fixture');
  assert.deepStrictEqual(r.scenarios.base.notes.lastYear.marketing, ['2026-10', '2026-11']);
  assert.deepStrictEqual(Object.keys(r.scenarios.base.notes.lastYear).sort(), ['marketing', 'otherOut', 'stock', 'wholesale']);
});
test('the weekly supplier top-up stands aside in planned months and still runs elsewhere', () => {
  const r = CFE.buildForecast(base({ lastYear: LY, history: { stockPerWeek: 10000 } }));
  assert.ok(items(r, 'base', 'stock', '2026-09').some((i) => i.label === 'Typical supplier payments (not yet billed)'), 'rest of September');
  assert.ok(!items(r, 'base', 'stock', '2026-10').some((i) => i.label === 'Typical supplier payments (not yet billed)'), 'October is planned from last year');
  near(total(r, 'base', 'stock', '2026-10'), 50000);
  assert.ok(items(r, 'base', 'stock', '2026-12').some((i) => i.label === 'Typical supplier payments (not yet billed)'), 'December has no last year, so the average applies');
});
test('each line can be switched off, and so can the whole thing', () => {
  const off = CFE.buildForecast(base({ lastYear: LY, settings: { lyOn: 0 } }));
  assert.strictEqual(off.scenarios.base.items.filter((i) => i.source === 'Last year').length, 0);
  assert.deepStrictEqual(off.scenarios.base.notes.lastYear, {});
  const noMkt = CFE.buildForecast(base({ lastYear: LY, history: { marketingPerWeek: 7000 }, settings: { lyMarketing: 0 } }));
  near(total(noMkt, 'base', 'marketing', '2026-10'), 31 * 1000, 0.01, 'marketing back on the run-rate');
  near(total(noMkt, 'base', 'wholesale', '2026-10'), 30000, 0.01, 'wholesale still from last year');
  assert.strictEqual(CFE.mergeSettings({ lyStock: 0 }).lyStock, 0);
  assert.strictEqual(CFE.mergeSettings(null).lyOn, 1);
});
test('a manual monthly override still wins over the plan; the scenario % applies around it as before', () => {
  const r = CFE.buildForecast(base({ lastYear: LY, overrides: { wholesale: { '2026-10': 5000 }, marketing: { '2026-11': 12000 } } }));
  near(CFE.monthCell(r, 'base', 'wholesale', '2026-10').value, 5000);
  near(CFE.monthCell(r, 'worst', 'wholesale', '2026-10').value, 5000 * 0.9);
  near(CFE.monthCell(r, 'base', 'marketing', '2026-11').value, 12000);
  near(CFE.monthCell(r, 'base', 'marketing', '2026-11').system, 90000, 0.01, 'the plan it replaced is still shown');
  near(CFE.monthCell(r, 'base', 'wholesale', '2026-11').value, 60000, 0.01, 'other months untouched');
});
test('lines that are not planned from last year are untouched: online and other cash in', () => {
  const r = CFE.buildForecast(base({ lastYear: LY }));
  assert.strictEqual(items(r, 'base', 'online').length, 0);
  assert.strictEqual(items(r, 'base', 'otherIn').length, 0);
});
test('without last-year data nothing changes (no items, no notes)', () => {
  const r = CFE.buildForecast(base({ history: { marketingPerWeek: 7000 } }));
  assert.strictEqual(r.scenarios.base.items.filter((i) => i.source === 'Last year').length, 0);
  assert.deepStrictEqual(r.scenarios.base.notes.lastYear, {});
  near(total(r, 'base', 'marketing', '2026-10'), 31 * 1000, 0.01);
});
test('the balance moves by exactly the planned money: flows still equal their items', () => {
  const r = CFE.buildForecast(base({ lastYear: LY }));
  const s = r.scenarios.base;
  const itemSum = (line) => s.items.filter((i) => i.line === line).reduce((a, i) => a + i.amount, 0);
  for (const line of ['wholesale', 'stock', 'marketing', 'otherOut']) near(s.flows[line].reduce((a, v) => a + v, 0), itemSum(line), 0.01, line);
});
test('Oct–Nov plan shows up in the monthly buckets the Year view reads', () => {
  const r = CFE.buildForecast(base({ lastYear: LY }));
  const bk = CFE.buckets(r, 'months12');
  const oct = bk.find((b) => b.month === '2026-10').byScenario.base;
  near(oct.wholesale, 30000); near(oct.stock, 50000); near(oct.marketing, 40000); near(oct.otherOut, 20000);
});

console.log('Growth for a single month');
const GROWTH = { wholesale: { '2026-10': 20 }, marketing: { '2026-11': -50 } };
test('a month\'s own growth % multiplies last year, and the Worst / Base / Best % goes on top of it', () => {
  const r = CFE.buildForecast(base({ lastYear: LY, growth: GROWTH }));
  near(total(r, 'base', 'wholesale', '2026-10'), 30000 * 1.2);
  near(total(r, 'worst', 'wholesale', '2026-10'), 30000 * 1.2 * 0.9, 0.01, 'worst: +20% month, then -10% case');
  near(total(r, 'best', 'wholesale', '2026-10'), 30000 * 1.2 * 1.05, 0.01, 'best: +20% month, then +5% case');
});
test('only the months you set change; a negative growth cuts the month', () => {
  const r = CFE.buildForecast(base({ lastYear: LY, growth: GROWTH }));
  near(total(r, 'base', 'wholesale', '2026-11'), 60000, 0.01, 'Nov wholesale untouched');
  near(total(r, 'base', 'marketing', '2026-11'), 45000, 0.01, 'Nov marketing -50% of 90,000');
  near(total(r, 'base', 'marketing', '2026-10'), 40000, 0.01, 'Oct marketing untouched');
  near(total(r, 'worst', 'marketing', '2026-11'), 45000 * 1.05, 0.01);
});
test('growth counts towards the plan the same way: known invoices still come off the planned amount', () => {
  const r = CFE.buildForecast(base({ lastYear: LY, growth: GROWTH, ar: [{ id: 'a', contact: 'ACME', amountDue: 10000, currency: 'AUD', dueDate: '2026-10-01', online: false }] }));
  near(total(r, 'base', 'wholesale', '2026-10'), 36000);
  near(lyItems(r, 'base', 'wholesale', '2026-10').reduce((a, i) => a + i.amount, 0), 26000);
});
test('the label and the method say what was applied', () => {
  const w = lyItems(CFE.buildForecast(base({ lastYear: LY, growth: GROWTH })), 'worst', 'wholesale', '2026-10')[0];
  assert.strictEqual(w.label, "Last year's Oct 25 pattern (+20% month, −10% case)");
  assert.ok(/Oct 25 wholesale x \(1 \+ 20%\) for the month x \(1 − 10%\) case = 32,400, less 0 already known/.test(w.meta.method), w.meta.method);
  const base0 = lyItems(CFE.buildForecast(base({ lastYear: LY, growth: GROWTH })), 'base', 'wholesale', '2026-10')[0];
  assert.strictEqual(base0.label, "Last year's Oct 25 pattern (+20% month)", 'a 0% case is left out of the label');
});
test('growth on a month or line that isn\'t planned from last year does nothing', () => {
  const r = CFE.buildForecast(base({ lastYear: LY, history: { marketingPerWeek: 7000 }, growth: { wholesale: { '2026-12': 50, '2026-09': 50 }, marketing: { '2026-10': 100 } }, settings: { lyMarketing: 0 } }));
  assert.strictEqual(lyItems(r, 'base', 'wholesale', '2026-12').length, 0, 'no Dec 2025 to grow');
  assert.strictEqual(lyItems(r, 'base', 'wholesale', '2026-09').length, 0, 'this month keeps the usual logic');
  near(total(r, 'base', 'marketing', '2026-10'), 31 * 1000, 0.01, 'marketing is off, so the run-rate stands and the growth is ignored');
});
test('blank, text or non-numeric growth counts as 0; -100% or lower means nothing planned', () => {
  const r = CFE.buildForecast(base({ lastYear: LY, growth: { wholesale: { '2026-10': '', '2026-11': 'abc' }, stock: { '2026-10': -100, '2026-11': -250 } } }));
  near(total(r, 'base', 'wholesale', '2026-10'), 30000); near(total(r, 'base', 'wholesale', '2026-11'), 60000);
  near(total(r, 'base', 'stock', '2026-10'), 0); near(total(r, 'base', 'stock', '2026-11'), 0, 0.01, 'clamped at -100%');
});
test('a typed monthly $ override still beats the plan and its growth', () => {
  const r = CFE.buildForecast(base({ lastYear: LY, growth: GROWTH, overrides: { wholesale: { '2026-10': 5000 } } }));
  near(CFE.monthCell(r, 'base', 'wholesale', '2026-10').value, 5000);
  near(CFE.monthCell(r, 'base', 'wholesale', '2026-10').system, 36000, 0.01, 'the grown plan it replaced is what is shown');
});
test('no growth input behaves exactly as before', () => {
  const a = CFE.buildForecast(base({ lastYear: LY }));
  const b = CFE.buildForecast(base({ lastYear: LY, growth: {} }));
  for (const line of ['wholesale', 'stock', 'marketing', 'otherOut']) near(total(a, 'base', line), total(b, 'base', line), 0.001, line);
});

console.log(`\n${n} passing${process.exitCode ? ' — with failures' : ''}`);
