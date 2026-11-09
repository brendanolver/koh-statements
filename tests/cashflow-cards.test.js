// Run with:  node tests/cashflow-cards.test.js
// Two assumptions about the money going out:
//   1. Advertising is ~37% of ONLINE SALES EX GST (online deposits include GST, so ex-GST sales = deposits / 1.1).
//   2. BAS (and the Australia Post-type spend inside Other cash out) is paid with Amex 1003, all advertising with Amex 1000, so
//      that money leaves the bank on the Amex statement due dates, not when it is spent.
const assert = require('assert');
const CFE = require('../cashflow-engine.js');
const { addDays, monthKey, addMonths } = CFE.util;

let n = 0;
const test = (name, fn) => { try { fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };
const near = (a, b, tol = 0.01, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);

const TODAY = '2026-11-09';
// everything else out of the way: no growth anywhere, last-year marketing pattern available to prove it is NOT used
const sc = (o = {}, w = {}, b = {}) => ({ scenarios: { base: { out: 0, ...o }, worst: { out: 0, ...w }, best: { out: 0, ...b } } });
const base = (over = {}) => ({ today: TODAY, cashToday: 100000, ar: [], ap: [], amOrders: [], amPOs: null, termsByCustomer: {}, shopify: null, history: null, overrides: {}, settings: sc(), ...over });
const items = (r, line, scn = 'base') => r.scenarios[scn].items.filter((i) => i.line === line);
const inMonth = (r, line, mk, scn = 'base') => items(r, line, scn).filter((i) => monthKey(i.date) === mk).reduce((a, i) => a + i.amount, 0);
const flat = () => { const d = {}; for (let i = -400; i < 0; i++) d[addDays(TODAY, i)] = 1100; return d; }; // $1,100 a day of deposits = $1,000 ex GST
const online = (over = {}) => base({ onlineLy: { daily: flat(), from: addDays(TODAY, -400) }, ...over });
const lastYear = () => { const o = {}; for (let k = -12; k <= 0; k++) o[addMonths('2026-11', k)] = { wholesale: 0, stock: 0, marketing: 40000, otherOut: 0 }; return o; };

console.log('Advertising as a % of online sales ex GST');
test('defaults: 37% of online sales ex GST, advertising on 1000 and BAS on 1003', () => {
  const d = CFE.DEFAULT_SETTINGS;
  assert.deepStrictEqual([d.marketingPctOfOnline, d.onlineGst, d.cardRoute.marketing, d.cardRoute.bas], [37, 10, '1000', '1003']);
});
test('each online day gives advertising of 37% x (deposits / 1.1) — deposits include GST', () => {
  const r = CFE.buildForecast(online({ settings: { ...sc(), marketingPctOfOnline: 37 } }));
  const it = items(r, 'marketing').find((i) => i.date === '2026-12-10');
  near(it.amount, (1100 / 1.1) * 0.37, 1e-6);
  near(inMonth(r, 'marketing', '2026-12'), 31 * 1000 * 0.37, 0.01);
  assert.ok(/37% of online sales ex GST/.test(it.label) && it.source === 'Your assumption' && it.status === 'assumption', it.label);
});
test('it replaces last year\'s marketing pattern and the recent run-rate (never added to them)', () => {
  const r = CFE.buildForecast(online({ lastYear: lastYear(), history: { marketingPerWeek: 70000 }, settings: { ...sc(), marketingPctOfOnline: 37 } }));
  assert.ok(items(r, 'marketing').every((i) => /^Advertising/.test(i.label)), 'only the %-of-sales items');
  near(inMonth(r, 'marketing', '2026-12'), 31 * 1000 * 0.37, 0.01, 'not 40,000 (last year) and not 70,000/week');
  assert.strictEqual(r.scenarios.base.notes.lastYear.marketing, undefined);
});
test('it follows the sales forecast: growth % and a typed amount for a month both carry through', () => {
  const grown = CFE.buildForecast(online({ settings: { ...sc({ online: 50 }), marketingPctOfOnline: 37 } }));
  near(inMonth(grown, 'marketing', '2026-12'), 31 * 1000 * 1.5 * 0.37, 0.01);
  const typed = CFE.buildForecast(online({ settings: { ...sc(), marketingPctOfOnline: 37 }, salesPlan: { online: { '2026-12': { amount: 2200000 } } } }));
  near(inMonth(typed, 'marketing', '2026-12'), (2200000 / 1.1) * 0.37, 0.01);
});
test('worst and best use their own online sales, so their advertising moves with them', () => {
  const r = CFE.buildForecast(online({ settings: { ...sc({}, { online: -20 }, { online: 20 }), marketingPctOfOnline: 37 } }));
  const m = (scn) => inMonth(r, 'marketing', '2026-12', scn);
  near(m('worst'), m('base') * 0.8, 0.01); near(m('best'), m('base') * 1.2, 0.01);
});
test('at 0%, or with no online forecast to take a share of, the old logic (last year / run-rate) stays in charge', () => {
  const off = CFE.buildForecast(online({ lastYear: lastYear(), settings: { ...sc(), marketingPctOfOnline: 0 } }));
  near(inMonth(off, 'marketing', '2026-12'), 40000, 0.01, 'last year\'s December');
  const none = CFE.buildForecast(base({ history: { marketingPerWeek: 7000 }, settings: { ...sc(), marketingPctOfOnline: 37 } }));
  assert.ok(items(none, 'marketing').every((i) => i.label === 'Recent marketing spend'));
  assert.strictEqual(none.scenarios.base.notes.marketingFromSales, undefined);
});
test('the GST allowance is a setting (0 = deposits are treated as ex GST already)', () => {
  const r = CFE.buildForecast(online({ settings: { ...sc(), marketingPctOfOnline: 37, onlineGst: 0 } }));
  near(inMonth(r, 'marketing', '2026-12'), 31 * 1100 * 0.37, 0.01);
});

console.log('Which Amex pays for what');
const cardsInput = (over = {}) => online({
  settings: { ...sc(), marketingPctOfOnline: 37, cardRoute: { marketing: '1000', bas: '1003' } },
  cards: [
    { id: 'A', name: 'Amex Platinum Bus', last4: '1003', owed: 0, recentCharges: [] },
    { id: 'B', name: 'Amex Platinum #001', last4: '1000', owed: 0, recentCharges: [] },
  ],
  cardShares: { marketing: { A: 0.5, B: 0.5 } }, ...over,
});
const futureStatements = (r, cardId) => items(r, 'cards').filter((i) => i.meta.card === cardId);
test('advertising pinned to 1000 is charged to that card only — whatever the last 13 weeks of spend split showed', () => {
  const r = CFE.buildForecast(cardsInput());
  assert.strictEqual(futureStatements(r, 'A').length, 0, 'nothing of the advertising goes on 1003');
  assert.ok(futureStatements(r, 'B').length >= 11);
  near(items(r, 'cardCredit').reduce((a, i) => a + i.amount, 0), -items(r, 'marketing').reduce((a, i) => a + i.amount, 0), 0.5, 'all of it is on the card');
});
test('1000 closes on the 5th and is due on the 29th of the same month: a charge on 10 Dec waits for the statement that closes 5 Jan, due 29 Jan', () => {
  const r = CFE.buildForecast(cardsInput({ online: undefined }));
  const st = futureStatements(r, 'B').find((i) => i.meta.due === '2027-01-29');
  assert.ok(st, 'a statement due 29 Jan exists');
  assert.ok(/closing 5 Jan/.test(st.meta.doc) || /5 Jan/.test(st.meta.doc), st.meta.doc);
});
test('"As history" keeps the split of the last 13 weeks; "bank" takes advertising off the cards; a card that does not exist falls back to history', () => {
  const auto = CFE.buildForecast(cardsInput({ settings: { ...sc(), marketingPctOfOnline: 37, cardRoute: { marketing: 'auto', bas: 'auto' } } }));
  assert.ok(futureStatements(auto, 'A').length > 0 && futureStatements(auto, 'B').length > 0, '50 / 50');
  const bank = CFE.buildForecast(cardsInput({ settings: { ...sc(), marketingPctOfOnline: 37, cardRoute: { marketing: 'bank', bas: 'auto' } } }));
  assert.strictEqual(items(bank, 'cards').filter((i) => i.status === 'assumption').length, 0);
  assert.strictEqual(items(bank, 'cardCredit').length, 0);
  const ghost = CFE.buildForecast(cardsInput({ settings: { ...sc(), marketingPctOfOnline: 37, cardRoute: { marketing: '9999', bas: 'auto' } } }));
  assert.ok(futureStatements(ghost, 'A').length > 0 && futureStatements(ghost, 'B').length > 0, 'falls back to the history split');
});

const BAS = { gstMonthlyAvg: 57000, paygMonthly: 10000, recMonthAvg: 300000, recByMonth: { '2026-10': 330000, '2026-11': 100000 }, billMonths: ['2026-11'] };
test('BAS on 1003 leaves the bank on the statement due date, not the day it is paid: charged 25 Dec, statement closes 25 Dec, due 19 Jan', () => {
  const noCard = CFE.buildForecast(base({ bas: BAS, cards: cardsInput().cards, settings: { ...sc(), marketingPctOfOnline: 0, cardRoute: { marketing: 'auto', bas: 'bank' } } }));
  const onCard = CFE.buildForecast(base({ bas: BAS, cards: cardsInput().cards, settings: { ...sc(), marketingPctOfOnline: 0, cardRoute: { marketing: 'auto', bas: '1003' } } }));
  const dec = items(onCard, 'bas').find((i) => i.date === '2026-12-25');
  assert.ok(dec && dec.amount > 30000, 'a December BAS estimate exists: ' + (dec && dec.amount));
  const s0 = noCard.scenarios.base, s1 = onCard.scenarios.base;
  const at = (s, d) => s.balance[s.idx[d]];
  assert.ok(at(s0, '2026-12-26') < at(s0, '2026-12-24') - dec.amount + 1, 'bank pays it on the 25th when it is not on the card');
  near(at(s1, '2026-12-26'), at(s1, '2026-12-24'), 0.01, 'on the card the bank is untouched on the 25th');
  const st = items(onCard, 'cards').find((i) => i.meta.card === 'A' && i.meta.due === '2027-01-19');
  assert.ok(st && st.amount >= dec.amount - 0.01, 'the statement due 19 Jan carries the BAS');
  assert.ok(at(s1, '2027-01-20') < at(s1, '2027-01-18') - dec.amount + 1, 'and the bank pays it then');
  near(items(onCard, 'basCredit').reduce((a, i) => a + i.amount, 0), -items(onCard, 'bas').reduce((a, i) => a + i.amount, 0), 0.5, 'every BAS dollar is charged to the card');
});
test('BAS paid on the 26th misses the 25th close and waits for the next statement — 54 days instead of 25', () => {
  const r = CFE.buildForecast(base({ bas: BAS, cards: cardsInput().cards, settings: { ...sc(), marketingPctOfOnline: 0, basPayDay: 26, cardRoute: { marketing: 'auto', bas: '1003' } } }));
  const dec = items(r, 'bas').find((i) => i.date === '2026-12-26');
  assert.ok(dec);
  const st = items(r, 'cards').find((i) => i.meta.card === 'A' && i.meta.due === '2027-02-19');
  assert.ok(st && st.amount >= dec.amount - 0.01, 'due 19 Feb, nearly two months later');
});
test('the BAS group shows BAS net of what is on the card (no double count in operating expenses), and the Amex group gets the statement', () => {
  const r = CFE.buildForecast(base({ bas: BAS, cards: cardsInput().cards, settings: { ...sc(), marketingPctOfOnline: 0, cardRoute: { marketing: 'auto', bas: '1003' } } }));
  const dec = CFE.breakdown(r, 'base', '2026-12-01', '2026-12-31'), jan = CFE.breakdown(r, 'base', '2027-01-01', '2027-01-31');
  const g = (b, k) => b.outflows.find((x) => x.key === k).amount;
  near(g(dec, 'bas'), 0, 0.01, 'BAS charged in December costs the bank nothing in December');
  near(g(dec, 'opex'), 0, 0.01, 'and the credit is not netted against operating expenses');
  assert.ok(g(jan, 'cards') > 30000, 'the January Amex payments carry it');
  assert.ok(CFE.GROUPS.outflows.find((x) => x.key === 'bas').lines.includes('basCredit'));
});
test('a known ATO bill (BAS paid by card too) is moved to the card the same way', () => {
  const bill = { id: 'ATO1', contact: 'ATO', number: 'BAS-1', amountDueAud: 60000, currency: 'AUD', dueDate: '2026-11-21' };
  const r = CFE.buildForecast(base({ ap: [bill], cards: cardsInput().cards, settings: { ...sc(), marketingPctOfOnline: 0, cardRoute: { marketing: 'auto', bas: '1003' } } }));
  near(items(r, 'basCredit').filter((i) => i.date <= '2026-11-30').reduce((a, i) => a + i.amount, 0), -60000, 0.01);
});

console.log('How much the cards carry');
test('each card\'s highest and average balance owing is reported (what the Amex is carrying for the business)', () => {
  const r = CFE.buildForecast(cardsInput());
  const o = r.scenarios.base.notes.cardOwed;
  assert.ok(o['1000'] && o['1003']);
  assert.ok(o['1000'].peak > 15000 && o['1000'].average > 8000 && /^\d{4}-\d{2}-\d{2}$/.test(o['1000'].peakDate), JSON.stringify(o['1000']));
  assert.ok(o['1000'].peak > o['1003'].peak, 'advertising makes 1000 the heavier card');
});

console.log('Settings');
test('card routes and the advertising % merge over the defaults; junk is ignored', () => {
  const s = CFE.mergeSettings({ marketingPctOfOnline: 30, cardRoute: { marketing: 'bank', bas: '1000', otherOut: 'auto', evil: 'x' } });
  assert.deepStrictEqual([s.marketingPctOfOnline, s.cardRoute.marketing, s.cardRoute.bas, s.cardRoute.otherOut, s.cardRoute.evil], [30, 'bank', '1000', 'auto', undefined]);
  const j = CFE.mergeSettings({ marketingPctOfOnline: '', cardRoute: { marketing: 'bad value', bas: 5 } });
  assert.deepStrictEqual([j.marketingPctOfOnline, j.cardRoute.marketing, j.cardRoute.bas], [37, '1000', '1003']);
  assert.strictEqual(CFE.mergeSettings({ marketingPctOfOnline: 0 }).marketingPctOfOnline, 0, '0 means off and is kept');
});

console.log(`\n${n} passing`);
