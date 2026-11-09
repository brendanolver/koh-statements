// Run with:  node tests/cashflow-dashboard.test.js
// What the redesigned Cash Flow dashboard needs from the engine: BAS as its own line (estimated without double
// counting a real ATO bill), manual adjustments, stale bills, collections timed from each customer's own history,
// online forecast from last year's bank deposits, the green / amber / red outlook, and the breakdown.
const assert = require('assert');
const CFE = require('../cashflow-engine.js');
const { addDays, monthKey, addMonths } = CFE.util;

let n = 0;
const test = (name, fn) => { try { fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };
const near = (a, b, tol = 0.01, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);

const TODAY = '2026-11-09';
// out: 0 keeps operating-cost growth out of the way unless a test is about it
const quiet = { scenarios: { base: { out: 0 }, worst: { out: 0 }, best: { out: 0 } } };
const base = (over = {}) => ({ today: TODAY, cashToday: 100000, ar: [], ap: [], amOrders: [], amPOs: null, termsByCustomer: {}, shopify: null, history: null, overrides: {}, settings: quiet, ...over });
const items = (r, line, scn = 'base') => r.scenarios[scn].items.filter((i) => i.line === line);
const total = (r, line, scn = 'base') => items(r, line, scn).reduce((a, i) => a + i.amount, 0);

console.log('Defaults');
test('thresholds and assumptions start where the brief says: $30k minimum, $100k comfortable, +5% costs, 180-day stale bills', () => {
  const d = CFE.DEFAULT_SETTINGS;
  assert.deepStrictEqual([d.minCash, d.cashThreshold, d.staleBillDays, d.basPayDay, d.debtorDaysOverride], [30000, 100000, 180, 25, null]);
  assert.deepStrictEqual([d.scenarios.worst.out, d.scenarios.base.out, d.scenarios.best.out], [10, 5, 0]);
  assert.deepStrictEqual([d.scenarios.base.online, d.scenarios.base.wholesale], [0, 0], 'no assumed sales growth until you set one');
  const m = CFE.mergeSettings({ minCash: 45000, cashThreshold: 120000, debtorDaysOverride: 40, scenarios: { base: { out: 8 } } });
  assert.deepStrictEqual([m.minCash, m.cashThreshold, m.debtorDaysOverride, m.scenarios.base.out], [45000, 120000, 40, 8]);
});

console.log('Stale bills');
test('a bill overdue by more than 180 days is left out and listed; a payment date brings it back; a recent overdue bill is still paid in 7 days', () => {
  const old = { id: 'OLD', contact: 'FACTORY', number: 'INV-OLD', amountDueAud: 50000, currency: 'AUD', dueDate: '2025-05-15' };
  const recent = { id: 'REC', contact: 'FACTORY', number: 'INV-REC', amountDueAud: 20000, currency: 'AUD', dueDate: addDays(TODAY, -30) };
  let r = CFE.buildForecast(base({ ap: [old, recent] }));
  assert.deepStrictEqual(items(r, 'stock').map((i) => i.meta.doc), ['INV-REC']);
  assert.strictEqual(items(r, 'stock')[0].date, addDays(TODAY, 7));
  const ex = r.scenarios.base.notes.excluded.find((e) => /stale/.test(e.kind));
  assert.ok(ex && ex.amount === 50000 && ex.doc === 'INV-OLD' && /180/.test(ex.kind));
  r = CFE.buildForecast(base({ ap: [old, recent], payDates: { 'ap:OLD': addDays(TODAY, 20) } }));
  assert.deepStrictEqual(items(r, 'stock').map((i) => i.meta.doc).sort(), ['INV-OLD', 'INV-REC']);
  r = CFE.buildForecast(base({ ap: [old], settings: { ...quiet, staleBillDays: 1000 } }));
  assert.strictEqual(items(r, 'stock').length, 1, 'the cut-off is a setting');
});

console.log('Collections from each customer\'s own history');
const arInv = (o) => ({ id: 'A', number: 'INV-1', contact: 'ACME', amountDue: 10000, currency: 'AUD', rate: null, invoiceDate: addDays(TODAY, -10), dueDate: addDays(TODAY, 20), online: false, ...o });
test('a customer with 3+ paid invoices is expected to pay their own average days after the invoice date', () => {
  const r = CFE.buildForecast(base({ ar: [arInv()], payDaysByCustomer: { ACME: { n: 8, days: 45 } } }));
  const it = items(r, 'wholesale')[0];
  assert.strictEqual(it.date, addDays(TODAY, -10 + 45));
  assert.ok(/45 days/.test(it.meta.basis));
});
test('with fewer than 3 paid invoices, or no history, the customer\'s terms (+ the usual lateness) are used as before', () => {
  for (const hist of [{ ACME: { n: 2, days: 80 } }, {}, undefined]) {
    const r = CFE.buildForecast(base({ ar: [arInv()], payDaysByCustomer: hist }));
    assert.strictEqual(items(r, 'wholesale')[0].date, addDays(addDays(TODAY, 20), CFE.DEFAULT_SETTINGS.arLateDays));
    assert.strictEqual(items(r, 'wholesale')[0].meta.basis, 'terms');
  }
});
test('the debtor-days setting overrides everyone, history included', () => {
  const r = CFE.buildForecast(base({ ar: [arInv()], payDaysByCustomer: { ACME: { n: 8, days: 45 } }, settings: { ...quiet, debtorDaysOverride: 60 } }));
  assert.strictEqual(items(r, 'wholesale')[0].date, addDays(TODAY, -10 + 60));
  assert.ok(/setting/.test(items(r, 'wholesale')[0].meta.basis));
});
test('an invoice already past its expected date is not assumed paid immediately — it is collected 21 days from today', () => {
  const r = CFE.buildForecast(base({ ar: [arInv({ invoiceDate: addDays(TODAY, -70), dueDate: addDays(TODAY, -40) })], payDaysByCustomer: { ACME: { n: 8, days: 45 } } }));
  assert.strictEqual(items(r, 'wholesale')[0].date, addDays(TODAY, CFE.DEFAULT_SETTINGS.overdueCollectDays));
});
test('the Worst case still delays the payment (history date + delay days)', () => {
  const r = CFE.buildForecast(base({ ar: [arInv()], payDaysByCustomer: { ACME: { n: 8, days: 45 } }, settings: { scenarios: { base: { out: 0 }, worst: { out: 0 }, best: { out: 0 } } } }));
  assert.strictEqual(items(r, 'wholesale', 'worst')[0].date, addDays(TODAY, -10 + 45 + CFE.DEFAULT_SETTINGS.scenarios.worst.delay));
  assert.strictEqual(items(r, 'wholesale', 'base')[0].date, addDays(TODAY, -10 + 45));
});
test('partially paid invoices only forecast what is still owing (the amount due, not the total)', () => {
  const r = CFE.buildForecast(base({ ar: [arInv({ amountDue: 2500 })] }));
  near(total(r, 'wholesale'), 2500);
});

console.log('Online sales from last year\'s bank deposits');
// last year's deposits: $1,000 a day, except a Black Friday week (+4 days of $10,000) 364 days before 26–29 Nov 2026
const lyDaily = () => { const d = {}; for (let i = -400; i < 0; i++) d[addDays(TODAY, i)] = 1000; for (let k = 0; k < 4; k++) d[addDays('2026-11-26', k - 364)] = 10000; return d; };
test('each future day is last year\'s same day (364 days earlier, a 7-day average) — Black Friday stays a spike, no fee or GST taken off', () => {
  const r = CFE.buildForecast(base({ onlineLy: { daily: lyDaily(), from: addDays(TODAY, -400) } }));
  const on = items(r, 'online');
  const byDate = Object.fromEntries(on.map((i) => [i.date, i.amount]));
  near(byDate['2026-11-20'], 1000, 0.001, 'an ordinary day');
  assert.ok(byDate['2026-11-27'] > 5000, `Black Friday week should spike, got ${byDate['2026-11-27']}`);
  assert.ok(on.every((i) => i.source === 'Xero' && i.status === 'assumption' && /net/.test(i.meta.method)), 'labelled an estimate, already net of fees');
  assert.strictEqual(r.scenarios.base.notes.onlineMethod.method, 'last year deposits');
});
test('growth % applies on top of last year (+20% means 1.2x), through the Base online setting', () => {
  const flat = {}; for (let i = -400; i < 0; i++) flat[addDays(TODAY, i)] = 1000;
  const r = CFE.buildForecast(base({ onlineLy: { daily: flat, from: addDays(TODAY, -400) }, settings: { ...quiet, scenarios: { base: { online: 20, out: 0 }, worst: { out: 0 }, best: { out: 0 } } } }));
  near(items(r, 'online').find((i) => i.date === '2026-12-05').amount, 1200, 0.001);
  assert.ok(/\+20%/.test(items(r, 'online')[0].label));
});
test('the far end of a 12-month horizon (last-year dates that have not happened yet) uses the recent daily average', () => {
  // from the 1st of a month the 12-month horizon is 364 days, so its last days point at last-year dates that haven't happened yet
  const T = '2026-11-01';
  const daily = {}; for (let i = -400; i < 0; i++) daily[addDays(T, i)] = 1000;
  const r = CFE.buildForecast({ ...base({ onlineLy: { daily, from: addDays(T, -400) } }), today: T });
  assert.ok(r.scenarios.base.notes.onlineMethod.fallbackDays > 0, 'some days fall back');
  assert.ok(r.scenarios.base.notes.onlineMethod.lyDays > 300, 'most days use last year');
  near(items(r, 'online').slice(-1)[0].amount, 1000, 0.001);
});
test('without a full year of deposits it falls back to the recent run-rate; Shopify, when connected, still comes first', () => {
  const short = { daily: lyDaily(), from: addDays(TODAY, -100) };
  let r = CFE.buildForecast(base({ onlineLy: short, history: { onlineReceiptsPerWeek: 7000 } }));
  assert.ok(items(r, 'online').every((i) => i.label === 'Recent receipts run-rate'));
  r = CFE.buildForecast(base({ onlineLy: { daily: lyDaily(), from: addDays(TODAY, -400) }, shopify: { daily: Object.fromEntries(Array.from({ length: 430 }, (_, i) => [addDays(TODAY, -i - 1), [2000, 10]])) }, history: { conversion: 1 } }));
  assert.ok(items(r, 'online').every((i) => i.source === 'Shopify'));
});

console.log('BAS');
// (BAS = the sample history; `bas` is the same object handed to the engine)
const BAS = { gstMonthlyAvg: 57000, paygMonthly: 10000, recMonthAvg: 300000, recByMonth: { '2026-10': 330000, '2026-11': 100000 }, billMonths: ['2026-11'] };
const bas = BAS;
test('the month that already has an ATO bill gets no estimate; later months do, on the BAS pay day, as ONE item with GST and PAYG inside', () => {
  const r = CFE.buildForecast(base({ bas }));
  const b = items(r, 'bas');
  assert.ok(!b.some((i) => i.date.startsWith('2026-11')), 'November was already paid (4 Nov) — nothing more for November');
  assert.deepStrictEqual(b.slice(0, 3).map((i) => i.date), ['2026-12-25', '2027-01-25', '2027-02-25']);
  assert.ok(b.every((i) => i.source === 'Estimate' && i.status === 'assumption' && Number.isFinite(i.meta.gst) && Number.isFinite(i.meta.payg)));
  near(b[0].amount, b[0].meta.gst + b[0].meta.payg, 0.001);
  assert.strictEqual(b.length, 11, 'Dec 2026 … Oct 2027');
});
test('GST follows last month\'s sales: a quiet month is scaled down (floor 0.5), a big one up (cap 1.8)', () => {
  // December's BAS is for November: 100,000 received so far, no more forecast (no online/wholesale items) -> 100/300 -> floored at 0.5
  const r = CFE.buildForecast(base({ bas }));
  const dec = items(r, 'bas').find((i) => i.date === '2026-12-25');
  near(dec.meta.scale, 0.5, 1e-9);
  near(dec.meta.gst, 57000 * 0.5, 0.01);
  const big = CFE.buildForecast(base({ bas: { ...BAS, recByMonth: { '2026-11': 900000 } } }));
  near(items(big, 'bas').find((i) => i.date === '2026-12-25').meta.scale, 1.8, 1e-9);
  const mid = CFE.buildForecast(base({ bas: { ...BAS, recByMonth: { '2026-11': 330000 } } }));
  near(items(mid, 'bas').find((i) => i.date === '2026-12-25').meta.scale, 1.1, 1e-9);
});
test('with a monthly GST ratio, GST = that share of LAST month\'s sales receipts (and the 12-month-average method is not used)', () => {
  const r = CFE.buildForecast(base({ bas: { ...BAS, gstRatio: 0.07, recByMonth: { '2026-11': 500000 } } }));
  const dec = items(r, 'bas').find((i) => i.date === '2026-12-25');
  near(dec.meta.gst, 0.07 * 500000, 0.01);
  assert.strictEqual(dec.meta.scale, null);
  assert.ok(/7\.0% of Nov sales receipts of 500,000/.test(dec.meta.method), dec.meta.method);
  near(dec.amount, 35000 + 10000, 0.01);
});
test('the ratio makes a big sales month followed by a big BAS (Black Friday online → a bigger December BAS than November\'s would be)', () => {
  const flat = {}; for (let i = -400; i < 0; i++) flat[addDays(TODAY, i)] = 2000;
  const bf = { ...flat }; for (let k = 0; k < 30; k++) bf[addDays(`2026-11-${String(1 + k).padStart(2, '0')}`, -364)] = 30000;
  const a = CFE.buildForecast(base({ bas: { ...BAS, gstRatio: 0.07, recByMonth: { '2026-11': 60000 } }, onlineLy: { daily: flat, from: addDays(TODAY, -400) } }));
  const b = CFE.buildForecast(base({ bas: { ...BAS, gstRatio: 0.07, recByMonth: { '2026-11': 60000 } }, onlineLy: { daily: bf, from: addDays(TODAY, -400) } }));
  const dec = (r) => items(r, 'bas').find((i) => i.date === '2026-12-25').meta.gst;
  assert.ok(dec(b) > dec(a) * 1.5, `${dec(b)} vs ${dec(a)}`);
});
test('no receipts known for last month: the ratio is skipped and the average method covers it', () => {
  const r = CFE.buildForecast(base({ bas: { ...BAS, gstRatio: 0.07, recByMonth: {} } }));
  const dec = items(r, 'bas').find((i) => i.date === '2026-12-25');
  assert.ok(dec.meta.scale !== null && /12-month average/.test(dec.meta.method));
});
test('forecast sales feed the next month\'s GST (more online in December -> a bigger January BAS)', () => {
  const flat = {}; for (let i = -400; i < 0; i++) flat[addDays(TODAY, i)] = 2000;
  const spike = { ...flat }; for (let k = 0; k < 31; k++) spike[addDays(`2026-12-${String(1 + k).padStart(2, '0')}`, -364)] = 20000;
  const a = CFE.buildForecast(base({ bas: { ...BAS, recByMonth: { '2026-11': 300000 } }, onlineLy: { daily: flat, from: addDays(TODAY, -400) } }));
  const b = CFE.buildForecast(base({ bas: { ...BAS, recByMonth: { '2026-11': 300000 } }, onlineLy: { daily: spike, from: addDays(TODAY, -400) } }));
  const jan = (r) => items(r, 'bas').find((i) => i.date === '2027-01-25').amount;
  assert.ok(jan(b) > jan(a), `${jan(b)} should exceed ${jan(a)}`);
});
test('PAYG grows with operating costs (the Base % on top), GST does not', () => {
  const q = CFE.buildForecast(base({ bas }));
  const g = CFE.buildForecast(base({ bas, settings: { scenarios: { base: { out: 10 }, worst: { out: 0 }, best: { out: 0 } } } }));
  const d = (r) => items(r, 'bas').find((i) => i.date === '2026-12-25').meta;
  near(d(g).payg, d(q).payg * 1.1, 0.01);
  near(d(g).gst, d(q).gst, 0.01);
});
test('an OPEN ATO bill replaces the estimate for its month and is a known (confirmed) BAS item', () => {
  const ato = { id: 'ATO1', contact: 'ATO', number: 'BAS', amountDueAud: 88000, currency: 'AUD', dueDate: '2026-12-21' };
  const r = CFE.buildForecast(base({ bas: { ...BAS, billMonths: [] }, ap: [ato] }));
  const dec = items(r, 'bas').filter((i) => i.date.startsWith('2026-12'));
  assert.strictEqual(dec.length, 1);
  assert.deepStrictEqual([dec[0].amount, dec[0].status, dec[0].date], [88000, 'confirmed', '2026-12-21']);
  assert.ok(items(r, 'bas').some((i) => i.date.startsWith('2026-11')), 'November (no bill recorded yet) is still estimated');
});
test('this month\'s BAS day has passed and nothing is recorded yet: assumed imminent (tomorrow), not skipped', () => {
  const r = CFE.buildForecast({ ...base({ bas: { ...BAS, billMonths: [] } }), today: '2026-11-28' });
  const nov = items(r, 'bas').filter((i) => i.date.startsWith('2026-11'));
  assert.deepStrictEqual(nov.map((i) => i.date), ['2026-11-29']);
});
test('no BAS history means no BAS estimate (and no crash); the pay day is a setting', () => {
  assert.strictEqual(items(CFE.buildForecast(base({})), 'bas').length, 0);
  assert.strictEqual(items(CFE.buildForecast(base({ bas: { gstMonthlyAvg: 0, paygMonthly: 0 } })), 'bas').length, 0);
  const r = CFE.buildForecast(base({ bas, settings: { ...quiet, basPayDay: 21 } }));
  assert.strictEqual(items(r, 'bas')[0].date, '2026-12-21');
});
test('a 31st pay day lands on the last day of a short month', () => {
  const r = CFE.buildForecast(base({ bas, settings: { ...quiet, basPayDay: 31 } }));
  assert.ok(items(r, 'bas').some((i) => i.date === '2027-02-28'));
});

console.log('Manual adjustments');
test('a manual receipt / payment lands on its date on its own line, labelled Manual, with its category', () => {
  const r = CFE.buildForecast(base({ adjustments: [
    { id: 'a1', desc: 'Extra stock payment', amount: 40000, date: '2026-12-10', dir: 'out', category: 'Stock' },
    { id: 'a2', desc: 'Lumi drawdown', amount: 150000, date: '2026-12-15', dir: 'in', category: 'Lumi drawdown' },
    { id: 'a3', desc: 'Lumi repayment', amount: 60000, date: '2027-02-20', dir: 'out', category: 'Lumi repayment' },
  ] }));
  const o = items(r, 'manualOut'), i = items(r, 'manualIn');
  assert.deepStrictEqual(o.map((x) => [x.date, x.amount, x.label, x.meta.category, x.source]), [['2026-12-10', 40000, 'Extra stock payment', 'Stock', 'Manual'], ['2027-02-20', 60000, 'Lumi repayment', 'Lumi repayment', 'Manual']]);
  assert.deepStrictEqual(i.map((x) => [x.date, x.amount, x.meta.category]), [['2026-12-15', 150000, 'Lumi drawdown']]);
  const s = r.scenarios.base;
  near(s.balance[s.idx['2026-12-16']] - s.balance[s.idx['2026-12-09']], 150000 - 40000, 0.01, 'balance moves by exactly the adjustments');
});
test('adjustments are added ON TOP: they never reduce an estimate or get replaced by a monthly override', () => {
  const LY = { '2025-12': { wholesale: 0, stock: 0, marketing: 0, otherOut: 50000 } };
  const without = CFE.buildForecast(base({ lastYear: LY }));
  const withAdj = CFE.buildForecast(base({ lastYear: LY, adjustments: [{ id: 'a', desc: 'One-off', amount: 20000, date: '2026-12-10', dir: 'out' }], overrides: { otherOut: { '2026-12': 10000 } } }));
  near(total(without, 'otherOut'), total(withAdj, 'otherOut'), 0.01, 'other cash out estimate is untouched');
  near(withAdj.scenarios.base.flows.manualOut.reduce((a, b) => a + b, 0), 20000, 0.01);
});
test('a past date, a zero or negative amount, a bad direction or a bad date are not counted (a past one is listed)', () => {
  const r = CFE.buildForecast(base({ adjustments: [
    { id: '1', desc: 'Past', amount: 5000, date: TODAY, dir: 'out' },
    { id: '2', desc: 'Zero', amount: 0, date: '2026-12-10', dir: 'out' },
    { id: '3', desc: 'Neg', amount: -5, date: '2026-12-10', dir: 'out' },
    { id: '4', desc: 'Dir', amount: 5, date: '2026-12-10', dir: 'sideways' },
    { id: '5', desc: 'Date', amount: 5, date: '10/12/2026', dir: 'out' },
  ] }));
  assert.strictEqual(items(r, 'manualOut').length + items(r, 'manualIn').length, 0);
  assert.ok(r.scenarios.base.notes.excluded.some((e) => /dated today or earlier/.test(e.kind) && e.label === 'Past'));
});

console.log('Reconciliation');
test('closing cash = opening cash + all cash in - all cash out, including the BAS and manual lines', () => {
  const r = CFE.buildForecast(base({
    bas, ap: [{ id: 'S', contact: 'FACTORY', number: 'F1', amountDueAud: 30000, currency: 'AUD', dueDate: '2026-11-30' }],
    ar: [arInv()], adjustments: [{ id: 'a', desc: 'x', amount: 7000, date: '2026-12-02', dir: 'in' }, { id: 'b', desc: 'y', amount: 9000, date: '2026-12-03', dir: 'out' }],
    onlineLy: { daily: lyDaily(), from: addDays(TODAY, -400) },
  }));
  for (const scn of ['worst', 'base', 'best']) {
    const s = r.scenarios[scn];
    let bal = r.cashToday;
    for (let i = 1; i < s.dates.length; i++) {
      bal += CFE.LINES_IN.reduce((a, l) => a + s.flows[l][i], 0) - CFE.LINES_OUT.reduce((a, l) => a + s.flows[l][i], 0);
      near(s.balance[i], bal, 0.01, `${scn} day ${i}`);
    }
    for (const l of CFE.LINES) near(s.flows[l].reduce((a, b) => a + b, 0), s.items.filter((it) => it.line === l).reduce((a, it) => a + it.amount, 0), 0.01, `${scn}/${l}: flows must equal items`);
  }
});

console.log('Outlook: the warnings and the four headline numbers');
// $150k today; a $140k factory bill on 29 Nov and $20k on 3 Dec; $100k comes in from one customer on 27 Dec
const squeeze = () => CFE.buildForecast(base({
  cashToday: 150000,
  ap: [{ id: 'F1', contact: 'FACTORY', number: 'F1', amountDueAud: 140000, currency: 'AUD', dueDate: '2026-11-29' }, { id: 'F2', contact: 'FACTORY', number: 'F2', amountDueAud: 20000, currency: 'AUD', dueDate: '2026-12-03' }],
  ar: [arInv({ id: 'C', contact: 'BIGCO', number: 'C1', amountDue: 100000, invoiceDate: '2026-10-20', dueDate: '2026-12-20' })],
}));
test('lowest cash in 90 days, the date, the balance 90 days out and the tightest period', () => {
  const o = CFE.outlook(squeeze());
  assert.deepStrictEqual([o.lowest90.value, o.lowest90.date], [-10000, '2026-12-03']);
  assert.strictEqual(o.position90, 90000);
  assert.strictEqual(o.position90Date, '2027-02-07');
  assert.strictEqual(o.tightest.kind, 'week');
  assert.ok(o.tightest.from <= '2026-12-03' && o.tightest.to >= '2026-12-03', JSON.stringify(o.tightest));
  assert.ok(/^Week of /.test(o.tightest.label));
});
test('a tightest point beyond 13 weeks is reported as a calendar month', () => {
  const r = CFE.buildForecast(base({ cashToday: 200000, ap: [{ id: 'F', contact: 'FACTORY', number: 'F', amountDueAud: 190000, currency: 'AUD', dueDate: '2027-04-10' }] }));
  const o = CFE.outlook(r);
  assert.deepStrictEqual([o.tightest.kind, o.tightest.label], ['month', 'April 2027']);
});
test('red: first crossing, how long below the minimum, when it recovers, and the biggest payments behind it', () => {
  const o = CFE.outlook(squeeze());
  assert.strictEqual(o.level, 'red');
  assert.strictEqual(o.red.length, 1);
  assert.deepStrictEqual([o.red[0].from, o.red[0].to, o.red[0].days, o.red[0].recoversOn], ['2026-11-29', '2026-12-26', 28, '2026-12-27']);
  assert.ok(o.messages.length >= 2 && o.messages.length <= 3, 'never a wall of alerts');
  assert.ok(o.messages.every((m) => m.level === 'red'));
  assert.ok(/fall below your \$30,000 minimum on 29 Nov/.test(o.messages[0].text), o.messages[0].text);
  assert.ok(/-\$10,000/.test(o.messages[0].text) && /28 days/.test(o.messages[0].text) && /27 Dec/.test(o.messages[0].text), o.messages[0].text);
  assert.ok(/stock suppliers \$160,000/.test(o.messages[1].text), o.messages[1].text);
});
test('amber: below the comfortable level but above the minimum', () => {
  const r = CFE.buildForecast(base({ cashToday: 150000, ap: [{ id: 'F', contact: 'FACTORY', number: 'F', amountDueAud: 90000, currency: 'AUD', dueDate: '2026-12-01' }] }));
  const o = CFE.outlook(r);
  assert.strictEqual(o.level, 'amber');
  assert.strictEqual(o.red.length, 0);
  assert.deepStrictEqual([o.amber[0].from, o.amber[0].low.value, o.amber[0].recoversOn], ['2026-12-01', 60000, null]);
  assert.ok(/comfortable level from 1 Dec/.test(o.messages[0].text) && /still above your \$30,000 minimum/.test(o.messages[0].text) && /does not recover/.test(o.messages[0].text), o.messages[0].text);
});
test('green: stays above the comfortable level for the whole forecast', () => {
  const o = CFE.outlook(CFE.buildForecast(base({ cashToday: 500000 })));
  assert.strictEqual(o.level, 'green');
  assert.strictEqual(o.messages.length, 1);
  assert.ok(/stays above your \$100,000 comfortable level/.test(o.messages[0].text));
  assert.deepStrictEqual(o.red.concat(o.amber), []);
});
test('thresholds are adjustable and drive the colours: a $200k minimum makes $150k red', () => {
  const o = CFE.outlook(CFE.buildForecast(base({ cashToday: 150000, settings: { ...quiet, minCash: 200000, cashThreshold: 400000 } })));
  assert.strictEqual(o.level, 'red');
  assert.strictEqual(o.todayLevel, 'red');
  assert.strictEqual(o.levelAt(150000), 'red');
  assert.strictEqual(CFE.outlook(CFE.buildForecast(base({ cashToday: 150000 }))).levelAt(50000), 'amber');
});
test('crossings list each change of level in date order, starting from today\'s level', () => {
  const o = CFE.outlook(squeeze());
  assert.deepStrictEqual(o.crossings.map((c) => [c.date, c.from, c.to]), [['2026-11-29', 'green', 'red'], ['2026-12-27', 'red', 'amber']]);
});
test('a second stretch below the minimum is mentioned once, not repeated as separate alarms', () => {
  const r = CFE.buildForecast(base({
    cashToday: 60000,
    ap: [{ id: 'F1', contact: 'FACTORY', number: 'F1', amountDueAud: 50000, currency: 'AUD', dueDate: '2026-11-20' }, { id: 'F2', contact: 'FACTORY', number: 'F2', amountDueAud: 110000, currency: 'AUD', dueDate: '2027-02-10' }],
    ar: [arInv({ id: 'C', contact: 'BIGCO', number: 'C1', amountDue: 120000, invoiceDate: '2026-11-01', dueDate: '2026-12-10' })],
  }));
  const o = CFE.outlook(r);
  assert.strictEqual(o.red.length, 2);
  assert.strictEqual(o.messages.length, 3);
  assert.ok(/happens again/.test(o.messages[2].text));
});
test('drivers: what left the bank before a date, biggest first, with what came in over the same weeks', () => {
  const r = squeeze();
  const d = CFE.drivers(r, 'base', '2026-12-03', 28);
  assert.deepStrictEqual([d.outflows[0].key, d.outflows[0].amount, d.outflows[0].count], ['stock', 160000, 2]);
  assert.strictEqual(d.inflow, 0);
  assert.strictEqual(d.from, '2026-11-10', 'the window starts tomorrow at the earliest');
});

console.log('Breakdown');
test('groups add up to the totals, split into known and estimated; operating expenses net off card spend', () => {
  const r = CFE.buildForecast(base({
    ap: [{ id: 'F', contact: 'FACTORY', number: 'F', amountDueAud: 30000, currency: 'AUD', dueDate: '2026-12-05' }],
    ar: [arInv({ amountDue: 10000, invoiceDate: '2026-11-01', dueDate: '2026-12-02' })],
    history: { otherOutPerWeek: 7000, marketingPerWeek: 14000 },
    adjustments: [{ id: 'm', desc: 'One-off', amount: 5000, date: '2026-12-08', dir: 'out' }],
  }));
  const b = CFE.breakdown(r, 'base', '2026-11-10', '2026-12-31');
  near(b.totalIn - b.totalOut, b.net, 0.001);
  const stock = b.outflows.find((x) => x.key === 'stock'), wh = b.inflows.find((x) => x.key === 'wholesale'), oth = b.outflows.find((x) => x.key === 'other'), opex = b.outflows.find((x) => x.key === 'opex');
  assert.deepStrictEqual([stock.amount, stock.known, stock.estimated], [30000, 30000, 0]);
  assert.deepStrictEqual([wh.amount, wh.known], [10000, 10000]);
  assert.deepStrictEqual([oth.amount, oth.known], [5000, 5000]);
  assert.strictEqual(opex.known, 0);
  assert.ok(opex.estimated > 0 && opex.amount === opex.estimated);
  const s = r.scenarios.base;
  let balMove = 0; for (let d = '2026-11-10'; d <= '2026-12-31'; d = addDays(d, 1)) balMove += s.inflow[s.idx[d]] - s.outflow[s.idx[d]];
  near(b.net, balMove, 0.01, 'breakdown net = change in cash');
});
test('the groups cover every engine line exactly once', () => {
  const used = [].concat(...CFE.GROUPS.inflows.map((g) => g.lines), ...CFE.GROUPS.outflows.map((g) => g.lines)).sort();
  assert.deepStrictEqual(used, CFE.LINES.slice().sort());
});

console.log(`\n${n} passing${process.exitCode ? ' — with failures' : ''}`);
