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
  console.log(`\n${n} passing${process.exitCode ? ' — with failures' : ''}`);
})();
