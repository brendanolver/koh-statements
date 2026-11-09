// Run with:  node tests/cashflow-inputs.test.js
// The Cashflow tab's saved inputs: the "plan from last year" switches and the Stock % per scenario are kept,
// anything else is dropped, against an in-memory blob store.
const assert = require('assert');
const mem = {};
const storePath = require.resolve('../netlify/functions/lib/blob-store');
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: { cashflowInputsStore: () => ({
  get: async (k) => (mem[k] === undefined ? null : JSON.parse(mem[k])),
  setJSON: async (k, v) => { mem[k] = JSON.stringify(v); },
}) } };
const fn = require('../netlify/functions/cashflow-inputs');
let n = 0;
async function test(name, f) { try { await f(); n++; console.log('  ok  ' + name); } catch (e) { process.exitCode = 1; console.log('FAIL  ' + name + '\n      ' + e.message); } }
const call = async (httpMethod, body) => { const r = await fn.handler({ httpMethod, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.statusCode, body: JSON.parse(r.body) }; };

(async () => {
  await test('the plan-from-last-year switches (1 / 0) and each scenario\'s Stock % are saved and read back', async () => {
    const settings = { lyOn: 0, lyWholesale: 1, lyStock: 0, lyMarketing: 1, lyOtherOut: 1, scenarios: { worst: { online: -15, wholesale: -10, stock: -5, out: 5, delay: 14 }, base: { stock: 0 }, best: { stock: 3 } } };
    assert.strictEqual((await call('POST', { settings })).status, 200);
    const got = (await call('GET')).body.settings;
    assert.deepStrictEqual([got.lyOn, got.lyWholesale, got.lyStock, got.lyMarketing, got.lyOtherOut], [0, 1, 0, 1, 1], 'a switched-off 0 is kept, not dropped');
    assert.deepStrictEqual(got.scenarios.worst, { online: -15, wholesale: -10, stock: -5, out: 5, delay: 14 });
    assert.strictEqual(got.scenarios.best.stock, 3);
  });
  await test('unknown settings and non-numbers are dropped', async () => {
    const s = fn._sanitise({ settings: { lyOn: 'maybe', lyStock: '', evil: 1, cashThreshold: 5000, scenarios: { worst: { stock: 'x', bogus: 9 } } } }).settings;
    assert.strictEqual(s.lyOn, undefined); assert.strictEqual(s.lyStock, undefined); assert.strictEqual(s.evil, undefined);
    assert.strictEqual(s.cashThreshold, 5000);
    assert.deepStrictEqual(s.scenarios.worst, {});
  });
  await test('monthly growth % is kept per line and month; bad lines, months and values are dropped', async () => {
    const growth = { wholesale: { '2026-12': 25, '2027-01': '-10.456', 'oct': 5, '2027-02': '', '2027-03': 'x', '2027-04': 5000 }, marketing: { '2026-11': -100 }, online: { '2026-12': 5 }, stock: 'nope' };
    assert.strictEqual((await call('POST', { growth })).status, 200);
    const got = (await call('GET')).body.growth;
    assert.deepStrictEqual(got, { wholesale: { '2026-12': 25, '2027-01': -10.46 }, marketing: { '2026-11': -100 } });
    assert.strictEqual(fn._sanitise({ growth: {} }).growth, undefined, 'nothing set → nothing stored');
    assert.strictEqual(fn._sanitise({}).growth, undefined);
  });
  await test('the dashboard assumptions are saved: thresholds, stale-bill days, BAS pay day, debtor days, Lumi limit', async () => {
    const settings = { minCash: 45000, cashThreshold: 120000, staleBillDays: 90, basPayDay: 21, debtorDaysOverride: 42, lumiLimit: 500000, lumiLoanBalance: 390715.15, scenarios: { base: { online: 20, wholesale: 5, out: 5 } } };
    assert.strictEqual((await call('POST', { settings })).status, 200);
    const got = (await call('GET')).body.settings;
    assert.deepStrictEqual([got.minCash, got.cashThreshold, got.staleBillDays, got.basPayDay, got.debtorDaysOverride, got.lumiLimit, got.lumiLoanBalance], [45000, 120000, 90, 21, 42, 500000, 390715.15]);
    assert.deepStrictEqual(got.scenarios.base, { online: 20, wholesale: 5, out: 5 });
    const blank = fn._sanitise({ settings: { debtorDaysOverride: '', minCash: 'lots' } }).settings;
    assert.strictEqual(blank.debtorDaysOverride, undefined, 'a blank override means "use each customer\'s own history"');
    assert.strictEqual(blank.minCash, undefined);
  });
  await test('manual adjustments are kept (amount > 0, real date, in/out, description) and tidied; bad ones are dropped', async () => {
    const adjustments = [
      { id: 'a1', desc: '  Extra stock payment ', amount: '40000', date: '2026-12-10', dir: 'out', category: 'Stock' },
      { id: 'a2', desc: 'Lumi drawdown', amount: 150000.456, date: '2026-12-15', dir: 'in', category: 'Lumi drawdown' },
      { id: 'bad id!', desc: 'No category', amount: 5, date: '2027-01-01', dir: 'out' },
      { id: 'b1', desc: 'zero', amount: 0, date: '2026-12-10', dir: 'out' },
      { id: 'b2', desc: 'negative', amount: -5, date: '2026-12-10', dir: 'out' },
      { id: 'b3', desc: 'bad date', amount: 5, date: '10/12/2026', dir: 'out' },
      { id: 'b4', desc: 'bad dir', amount: 5, date: '2026-12-10', dir: 'up' },
      { id: 'b5', desc: '   ', amount: 5, date: '2026-12-10', dir: 'out' },
      null, 'text', 42,
    ];
    assert.strictEqual((await call('POST', { adjustments })).status, 200);
    const got = (await call('GET')).body.adjustments;
    assert.deepStrictEqual(got, [
      { id: 'a1', desc: 'Extra stock payment', amount: 40000, date: '2026-12-10', dir: 'out', category: 'Stock' },
      { id: 'a2', desc: 'Lumi drawdown', amount: 150000.46, date: '2026-12-15', dir: 'in', category: 'Lumi drawdown' },
      { id: 'adj-3', desc: 'No category', amount: 5, date: '2027-01-01', dir: 'out', category: '' },
    ]);
    assert.strictEqual(fn._sanitise({}).adjustments, undefined, 'none set → nothing stored');
    assert.strictEqual(fn._sanitise({ adjustments: 'nope' }).adjustments, undefined);
  });
  await test('at most 100 adjustments, long descriptions and categories are cut', async () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ id: 'x' + i, desc: 'd'.repeat(200), amount: 1, date: '2026-12-10', dir: 'out', category: 'c'.repeat(100) }));
    const got = fn._sanitise({ adjustments: many }).adjustments;
    assert.strictEqual(got.length, 100);
    assert.deepStrictEqual([got[0].desc.length, got[0].category.length], [80, 40]);
  });
  await test('the sales forecast (online / wholesale, per month: a % OR an amount) is kept; junk is dropped; an amount wins over a %', async () => {
    const salesPlan = {
      online: { '2026-12': { pct: 150 }, '2027-01': { amount: '120000.456' }, '2027-02': { pct: -25.556 }, '2027-03': { pct: 'x' }, '2027-04': { pct: 5000 }, '2027-05': { pct: -150 }, 'dec': { pct: 5 }, '2027-06': { pct: '', amount: '' }, '2027-07': { pct: 10, amount: 500 }, '2027-08': { amount: -5 }, '2027-09': { amount: true }, '2027-10': 'text' },
      wholesale: { '2026-12': { amount: 0 }, '2027-01': { pct: 0 } },
      stock: { '2026-12': { pct: 5 } },
      marketing: 'nope',
    };
    assert.strictEqual((await call('POST', { salesPlan })).status, 200);
    const got = (await call('GET')).body.salesPlan;
    assert.deepStrictEqual(got, {
      online: { '2026-12': { pct: 150 }, '2027-01': { amount: 120000.46 }, '2027-02': { pct: -25.56 }, '2027-07': { amount: 500 } },
      wholesale: { '2026-12': { amount: 0 }, '2027-01': { pct: 0 } },
    });
    assert.strictEqual(fn._sanitise({ salesPlan: {} }).salesPlan, undefined, 'nothing set → nothing stored');
    assert.strictEqual(fn._sanitise({}).salesPlan, undefined);
    assert.strictEqual(fn._sanitise({ salesPlan: 'nope' }).salesPlan, undefined);
  });
  console.log(`\n${n} passing${process.exitCode ? ' — with failures' : ''}`);
})();
