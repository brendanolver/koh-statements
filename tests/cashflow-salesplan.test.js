// Run with:  node tests/cashflow-salesplan.test.js
// The Sales forecast card: per month, online and wholesale sales as a % on last year or a dollar amount.
// A typed month REPLACES the general growth % for that month in the base case (it is never stacked on it), Worst / Best sit
// either side of it, invoices and orders already in Xero / Apparel Magic count towards a wholesale month (never added on
// top), and the card can read back last year / forecast / known / typed for every month.
const assert = require('assert');
const CFE = require('../cashflow-engine.js');
const { addDays, monthKey, addMonths } = CFE.util;

let n = 0;
const test = (name, fn) => { try { fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };
const near = (a, b, tol = 0.01, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);

const TODAY = '2026-11-09';
const sc = (o = {}, w = {}, b = {}) => ({ scenarios: { base: { out: 0, ...o }, worst: { out: 0, ...w }, best: { out: 0, ...b } } });
const base = (over = {}) => ({ today: TODAY, cashToday: 100000, ar: [], ap: [], amOrders: [], amPOs: null, termsByCustomer: {}, shopify: null, history: null, overrides: {}, settings: sc(), ...over });
const items = (r, line, scn = 'base') => r.scenarios[scn].items.filter((i) => i.line === line);
const inMonth = (r, line, mk, scn = 'base') => items(r, line, scn).filter((i) => monthKey(i.date) === mk).reduce((a, i) => a + i.amount, 0);

// online: last year was a flat $1,000 a day
const flat = () => { const d = {}; for (let i = -400; i < 0; i++) d[addDays(TODAY, i)] = 1000; return d; };
const online = (over = {}) => base({ onlineLy: { daily: flat(), from: addDays(TODAY, -400) }, ...over });
// wholesale: last year was $200,000 a month (Dec 2025 … Oct 2026)
const lastYear = () => { const o = {}; for (let k = -12; k <= 0; k++) o[addMonths('2026-11', k)] = { wholesale: 200000, stock: 0, marketing: 0, otherOut: 0 }; return o; };

console.log('Typed online %');
test('a typed month is last year x (1 + that %) and other months are untouched', () => {
  const r = CFE.buildForecast(online({ salesPlan: { online: { '2026-12': { pct: 50 } } } }));
  near(inMonth(r, 'online', '2026-12'), 31000 * 1.5, 0.01);
  near(inMonth(r, 'online', '2027-01'), 31000, 0.01);
  const it = items(r, 'online').find((i) => i.date === '2026-12-10');
  assert.ok(/Your forecast \(\+50% on last year\)/.test(it.label) && it.source === 'Your forecast' && it.status === 'assumption', it.label);
});
test('it replaces the general growth % for that month — it is not stacked on it', () => {
  const r = CFE.buildForecast(online({ settings: sc({ online: 20 }), salesPlan: { online: { '2026-12': { pct: 50 } } } }));
  near(inMonth(r, 'online', '2026-12'), 31000 * 1.5, 0.01, 'typed +50% is +50%, not 1.2 x 1.5');
  near(inMonth(r, 'online', '2027-01'), 31000 * 1.2, 0.01, 'months without an entry still use the general +20%');
});
test('Worst and Best fan out around the typed month by the gap their % has from the base %', () => {
  const r = CFE.buildForecast(online({ settings: sc({ online: 0 }, { online: -15 }, { online: 15 }), salesPlan: { online: { '2026-12': { pct: 50 } } } }));
  near(inMonth(r, 'online', '2026-12', 'base'), 31000 * 1.5, 0.01);
  near(inMonth(r, 'online', '2026-12', 'worst'), 31000 * 1.5 * 0.85, 0.01);
  near(inMonth(r, 'online', '2026-12', 'best'), 31000 * 1.5 * 1.15, 0.01);
});
test('a negative % works, and the basis the card shows as "last year" is the no-growth pattern', () => {
  const r = CFE.buildForecast(online({ settings: sc({ online: 40 }), salesPlan: { online: { '2026-12': { pct: -25 } } } }));
  near(inMonth(r, 'online', '2026-12'), 31000 * 0.75, 0.01);
  near(r.scenarios.base.notes.onlineBasis['2026-12'], 31000, 0.01);
});
test('the current month is rest-of-month: a % scales the days left', () => {
  const r = CFE.buildForecast(online({ salesPlan: { online: { '2026-11': { pct: 100 } } } }));
  near(inMonth(r, 'online', '2026-11'), 21 * 1000 * 2, 0.01, '10–30 Nov is 21 days');
});

console.log('Typed online $');
test('the month adds up to exactly the amount, and the daily shape still follows last year', () => {
  const d = flat(); for (let k = 0; k < 4; k++) d[addDays('2026-11-26', k - 364)] = 10000; // a Black Friday week last year
  const r = CFE.buildForecast(base({ onlineLy: { daily: d, from: addDays(TODAY, -400) }, salesPlan: { online: { '2026-11': { amount: 500000 } } } }));
  near(inMonth(r, 'online', '2026-11'), 500000, 0.01);
  const by = Object.fromEntries(items(r, 'online').filter((i) => i.date.startsWith('2026-11')).map((i) => [i.date, i.amount]));
  assert.ok(by['2026-11-27'] > 3 * by['2026-11-15'], 'the spike is kept');
  assert.ok(/for the month/.test(items(r, 'online')[0].label) && items(r, 'online')[0].source === 'Your forecast');
});
test('worst / best sit around a typed amount too (base = the amount exactly)', () => {
  const r = CFE.buildForecast(online({ settings: sc({}, { online: -15 }, { online: 15 }), salesPlan: { online: { '2026-12': { amount: 80000 } } } }));
  near(inMonth(r, 'online', '2026-12', 'base'), 80000, 0.01);
  near(inMonth(r, 'online', '2026-12', 'worst'), 80000 * 0.85, 0.01);
  near(inMonth(r, 'online', '2026-12', 'best'), 80000 * 1.15, 0.01);
});
test('with no online forecast at all, a typed amount is spread evenly over the month; $0 clears the month', () => {
  let r = CFE.buildForecast(base({ salesPlan: { online: { '2026-12': { amount: 62000 } } } }));
  near(inMonth(r, 'online', '2026-12'), 62000, 0.01);
  near(items(r, 'online')[0].amount, 2000, 0.01);
  r = CFE.buildForecast(online({ salesPlan: { online: { '2026-12': { amount: 0 } } } }));
  assert.strictEqual(inMonth(r, 'online', '2026-12'), 0);
  assert.strictEqual(r.scenarios.base.items.filter((i) => i.line === 'online' && i.date.startsWith('2026-12')).length, 0, 'no zero-dollar items left behind');
});
test('an amount wins over a % if both are somehow stored; blank and junk entries are ignored; % is capped at -100', () => {
  assert.deepStrictEqual(CFE.salesPlanEntry({ online: { a: { pct: 10, amount: 500 } } }, 'online', 'a'), { amount: 500 });
  assert.strictEqual(CFE.salesPlanEntry({ online: { a: { pct: '', amount: null } } }, 'online', 'a'), null);
  assert.strictEqual(CFE.salesPlanEntry({ online: { a: { pct: 'x' } } }, 'online', 'a'), null);
  assert.strictEqual(CFE.salesPlanEntry({}, 'online', 'a'), null);
  assert.deepStrictEqual(CFE.salesPlanEntry({ online: { a: { pct: -300 } } }, 'online', 'a'), { pct: -100 });
});

console.log('Typed online % with Shopify connected');
test('it goes to the Shopify forecast as a target on last year and still replaces the general %', () => {
  const daily = Object.fromEntries(Array.from({ length: 430 }, (_, i) => [addDays(TODAY, -i - 1), [2000, 10]]));
  const r = CFE.buildForecast(base({ shopify: { daily }, history: { conversion: 1 }, settings: sc({ online: 20 }), salesPlan: { online: { '2026-12': { pct: 50 } } } }));
  assert.ok(r.shopifyFc.targetInfo['2026-12'].applied);
  near(inMonth(r, 'online', '2026-12'), 31 * 2000 * 1.5, 1, 'typed +50%, not +50% then +20% more');
  near(inMonth(r, 'online', '2027-01'), 31 * 2000 * 1.2, 1, 'other months: trend x the general +20%');
});

console.log('Typed wholesale');
const inv = (o) => ({ id: 'I1', number: 'INV-1', contact: 'ACME', amountDue: 60000, currency: 'AUD', rate: null, invoiceDate: '2026-11-01', dueDate: '2026-12-15', online: false, ...o });
test('a % is last year\'s month x (1 + %); invoices already issued for that month count towards it (never added on top)', () => {
  const r = CFE.buildForecast(base({ lastYear: lastYear(), ar: [inv({ dueDate: '2026-12-01' })], settings: sc({ wholesale: 10 }), salesPlan: { wholesale: { '2026-12': { pct: 25 } } }, payDaysByCustomer: { ACME: { n: 5, days: 36 } } }));
  const known = items(r, 'wholesale').filter((i) => i.source === 'Xero').reduce((a, i) => a + i.amount, 0);
  assert.ok(known > 0);
  near(inMonth(r, 'wholesale', '2026-12'), 200000 * 1.25, 0.01, '+25% typed — the general +10% is not stacked');
  near(inMonth(r, 'wholesale', '2027-01'), 200000 * 1.1, 0.01, 'other months keep the general +10%');
  assert.ok(items(r, 'wholesale').some((i) => /Your forecast \(\+25% on last year\)/.test(i.label) && i.source === 'Your forecast'));
});
test('a $ amount is the month\'s collections, invoices included; it works for a month last year cannot cover', () => {
  const ly = lastYear(); delete ly['2025-12'];
  const r = CFE.buildForecast(base({ lastYear: ly, salesPlan: { wholesale: { '2026-12': { amount: 180000 } } }, ar: [inv({ dueDate: '2026-12-01' })], payDaysByCustomer: { ACME: { n: 5, days: 36 } } }));
  near(inMonth(r, 'wholesale', '2026-12'), 180000, 0.01);
  const noLy = CFE.buildForecast(base({ lastYear: null, salesPlan: { wholesale: { '2027-02': { amount: 90000 } } } }));
  near(inMonth(noLy, 'wholesale', '2027-02'), 90000, 0.01, 'no last year needed for a typed amount');
});
test('if invoices and orders already come to more than the typed figure, the real money stays (and the card can say so)', () => {
  const r = CFE.buildForecast(base({ lastYear: lastYear(), ar: [inv({ amountDue: 300000, dueDate: '2026-12-01' })], payDaysByCustomer: { ACME: { n: 5, days: 36 } }, salesPlan: { wholesale: { '2026-12': { amount: 100000 } } } }));
  near(inMonth(r, 'wholesale', '2026-12'), 300000, 0.01);
  const c = CFE.salesPlanCell(r, 'wholesale', '2026-12');
  assert.ok(c.known >= 299999 && c.forecast >= 299999 && c.entry.amount === 100000);
});
test('confirmed Apparel Magic orders are not inflated by the general % in a month you have typed (base case)', () => {
  const orders = [{ id: 'O1', po: 'PO1', cn: 'SHOP', cur: 'AUD', gst: 0, lines: [{ d: '2026-11-20', v: 50000 }] }];
  const settings = sc({ wholesale: 10 });
  const plain = CFE.buildForecast(base({ lastYear: lastYear(), amOrders: orders, termsByCustomer: { SHOP: 30 }, settings }));
  const typed = CFE.buildForecast(base({ lastYear: lastYear(), amOrders: orders, termsByCustomer: { SHOP: 30 }, settings, salesPlan: { wholesale: { '2026-12': { pct: 0 }, '2027-01': { pct: 0 } } } }));
  const o = (r) => items(r, 'wholesale').filter((i) => i.source === 'Apparel Magic').reduce((a, i) => a + i.amount, 0);
  near(o(plain), 55000, 0.01, 'no typed month: the order carries the general +10%');
  const month = items(typed, 'wholesale').find((i) => i.source === 'Apparel Magic');
  assert.ok(month);
  assert.ok(['2026-12', '2027-01'].includes(monthKey(month.date)), 'the order is collected in a month you typed: ' + month.date);
  near(month.amount, 50000, 0.01);
});
test('a typed wholesale % for a month with no last year is skipped and reported, not guessed', () => {
  const ly = lastYear(); delete ly['2025-12'];
  const r = CFE.buildForecast(base({ lastYear: ly, salesPlan: { wholesale: { '2026-12': { pct: 30 } } } }));
  assert.strictEqual(inMonth(r, 'wholesale', '2026-12'), 0);
  assert.ok(r.scenarios.base.notes.salesPlanSkipped.some((s) => s.line === 'wholesale' && s.month === '2026-12'));
  assert.ok(CFE.salesPlanCell(r, 'wholesale', '2026-12').skipped);
});
test('Worst and Best sit around a typed wholesale month', () => {
  const r = CFE.buildForecast(base({ lastYear: lastYear(), settings: sc({ wholesale: 0 }, { wholesale: -10 }, { wholesale: 5 }), salesPlan: { wholesale: { '2026-12': { pct: 20 } } } }));
  near(inMonth(r, 'wholesale', '2026-12', 'base'), 240000, 0.01);
  near(inMonth(r, 'wholesale', '2026-12', 'worst'), 240000 * 0.9, 0.01);
  near(inMonth(r, 'wholesale', '2026-12', 'best'), 240000 * 1.05, 0.01);
});
test('an older per-month growth % (Advanced detail) still works for months with no typed entry, and the typed entry wins', () => {
  const r = CFE.buildForecast(base({ lastYear: lastYear(), growth: { wholesale: { '2026-12': 40, '2027-01': 40 } }, salesPlan: { wholesale: { '2026-12': { pct: 5 } } } }));
  near(inMonth(r, 'wholesale', '2026-12'), 210000, 0.01);
  near(inMonth(r, 'wholesale', '2027-01'), 280000, 0.01);
});

console.log('What the card reads back');
test('salesPlanCell: last year, forecast, known, typed, and the % the forecast works out to', () => {
  const r = CFE.buildForecast(online({ lastYear: lastYear(), settings: sc({ online: 10, wholesale: 10 }), salesPlan: { online: { '2026-12': { amount: 93000 } } } }));
  const o = CFE.salesPlanCell(r, 'online', '2026-12');
  near(o.basis, 31000, 0.01); near(o.forecast, 93000, 0.01); near(o.forecastPct, 200, 0.001);
  assert.deepStrictEqual(o.entry, { amount: 93000 }); assert.strictEqual(o.editable, true);
  const o2 = CFE.salesPlanCell(r, 'online', '2027-01');
  near(o2.forecast, 31000 * 1.1, 0.01); assert.strictEqual(o2.entry, null); assert.strictEqual(o2.defaultPct, 10);
  const w = CFE.salesPlanCell(r, 'wholesale', '2026-12');
  near(w.basis, 200000, 0.01); near(w.forecast, 220000, 0.01); near(w.forecastPct, 10, 0.001);
  const cur = CFE.salesPlanCell(r, 'wholesale', '2026-11');
  assert.strictEqual(cur.editable, false, 'this month\'s wholesale is known invoices — not editable');
  assert.strictEqual(CFE.salesPlanCell(r, 'online', '2025-01'), null, 'a month outside the forecast');
});

console.log(`\n${n} passing`);
