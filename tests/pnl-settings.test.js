// Run with:  node tests/pnl-settings.test.js
// The P&L tab's remembered Trading P&L percentages: saved, read back, and sanitised, against an in-memory blob store.
const assert = require('assert');
const path = require('path');

const mem = {};
const storePath = require.resolve('../netlify/functions/lib/blob-store');
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: { pnlSettingsStore: () => ({
  get: async (k) => (mem[k] === undefined ? null : JSON.parse(mem[k])),
  setJSON: async (k, v) => { mem[k] = JSON.stringify(v); },
}) } };
const fn = require('../netlify/functions/pnl-settings');

let n = 0;
async function test(name, f) {
  try { await f(); n++; console.log('  ok  ' + name); } catch (e) { process.exitCode = 1; console.log('FAIL  ' + name + '\n      ' + e.message); }
}
const call = async (httpMethod, body) => { const r = await fn.handler({ httpMethod, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.statusCode, body: JSON.parse(r.body) }; };

(async () => {
  await test('nothing saved yet → both percentages empty', async () => {
    const r = await call('GET'); assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.cogs, { online: '', wholesale: '' });
  });
  await test('saved percentages are remembered and come back on the next load', async () => {
    assert.strictEqual((await call('POST', { cogs: { online: '38.5', wholesale: 52 } })).status, 200);
    assert.deepStrictEqual((await call('GET')).body.cogs, { online: 38.5, wholesale: 52 });
  });
  await test('updating one replaces the saved value; clearing one leaves it empty', async () => {
    await call('POST', { cogs: { online: 40, wholesale: 52 } }); assert.deepStrictEqual((await call('GET')).body.cogs, { online: 40, wholesale: 52 });
    await call('POST', { cogs: { online: 40, wholesale: '' } }); assert.deepStrictEqual((await call('GET')).body.cogs, { online: 40, wholesale: '' });
  });
  await test('invalid values are dropped, extra fields never stored', async () => {
    assert.deepStrictEqual(fn._sanitise({ cogs: { online: 'abc', wholesale: 101 }, evil: 1 }).cogs, { online: '', wholesale: '' });
    assert.deepStrictEqual(fn._sanitise({ cogs: { online: -1, wholesale: 0 } }).cogs, { online: '', wholesale: 0 }, '0% is a real value');
    assert.deepStrictEqual(Object.keys(fn._sanitise({ cogs: {}, evil: 1 })).sort(), ['advertising', 'cogs', 'stock', 'updatedAt']);
    assert.deepStrictEqual(fn._sanitise(null).cogs, { online: '', wholesale: '' });
  });
  await test('advertising % (Social Media, of online sales) starts at 35, is remembered, and \'\' means switched off', async () => {
    for (const k of Object.keys(mem)) delete mem[k];
    assert.strictEqual((await call('GET')).body.advertising, 35, 'nothing saved yet: starts at 35');
    await call('POST', { cogs: { online: 40, wholesale: 52 }, advertising: 33.5 });
    assert.strictEqual((await call('GET')).body.advertising, 33.5);
    await call('POST', { cogs: { online: 40, wholesale: 52 }, advertising: '' });
    assert.strictEqual((await call('GET')).body.advertising, '', 'cleared on purpose = use Xero\'s actual, not 35 again');
    await call('POST', { cogs: { online: 41, wholesale: 52 }, advertising: 0 });
    assert.strictEqual((await call('GET')).body.advertising, 0, '0% is a real value');
  });
  await test('a settings document saved before advertising existed reads back as 35', async () => {
    for (const k of Object.keys(mem)) delete mem[k];
    mem.settings = JSON.stringify({ cogs: { online: 38, wholesale: 50 }, updatedAt: 'x' });
    const r = await call('GET'); assert.deepStrictEqual([r.body.cogs, r.body.advertising], [{ online: 38, wholesale: 50 }, 35]);
  });
  await test('an older open page that only sends the cost-of-goods % keeps whatever advertising % is saved (never resets or wipes it)', async () => {
    for (const k of Object.keys(mem)) delete mem[k];
    await call('POST', { cogs: { online: 40, wholesale: 50 }, advertising: 28 });
    await call('POST', { cogs: { online: 41, wholesale: 50 } });
    assert.strictEqual((await call('GET')).body.advertising, 28);
    await call('POST', { cogs: { online: 41, wholesale: 50 }, advertising: '' });
    await call('POST', { cogs: { online: 42, wholesale: 50 } });
    assert.strictEqual((await call('GET')).body.advertising, '', 'a cleared value also survives');
  });
  await test('advertising: invalid values are dropped to \'\' (off), valid ones kept to two decimals', async () => {
    assert.strictEqual(fn._sanitise({ advertising: 'abc' }).advertising, '');
    assert.strictEqual(fn._sanitise({ advertising: 101 }).advertising, '');
    assert.strictEqual(fn._sanitise({ advertising: -1 }).advertising, '');
    assert.strictEqual(fn._sanitise({ advertising: '35.456' }).advertising, 35.46);
    assert.strictEqual(fn._sanitise({}).advertising, 35, 'absent = the default');
  });
  await test('stock counts are saved, come back sorted, and one count per date', async () => {
    await call('POST', { cogs: {}, stock: [{ date: '2026-12-31', value: '150000.456' }, { date: '2026-06-30', value: 100000 }, { date: '2026-06-30', value: 99000 }] });
    assert.deepStrictEqual((await call('GET')).body.stock, [{ date: '2026-06-30', value: 99000 }, { date: '2026-12-31', value: 150000.46 }]);
  });
  await test('bad stock counts are dropped (bad date, blank, negative, not a number)', async () => {
    const out = fn._sanitise({ stock: [{ date: '2026-02-30x', value: 1 }, { date: '2026-13-45', value: 1 }, { date: '2026-01-01', value: '' }, { date: '2026-01-02', value: -1 }, { date: '2026-01-03', value: 'abc' }, { date: '2026-01-04', value: 0 }, null, 'x'] }).stock;
    assert.deepStrictEqual(out, [{ date: '2026-01-04', value: 0 }]);
  });
  await test('saving percentages from a page that does not know about stock never wipes the saved stock counts', async () => {
    await call('POST', { cogs: { online: 41, wholesale: 50 } });
    assert.strictEqual((await call('GET')).body.stock.length, 2);
    await call('POST', { cogs: { online: 41, wholesale: 50 }, stock: [] }); assert.deepStrictEqual((await call('GET')).body.stock, [], 'an explicit empty list does clear them');
  });
  await test('bad bodies and methods are refused', async () => {
    assert.strictEqual((await fn.handler({ httpMethod: 'POST', body: '{nope' })).statusCode, 400);
    assert.strictEqual((await fn.handler({ httpMethod: 'POST', body: 'x'.repeat(20000) })).statusCode, 413);
    assert.strictEqual((await fn.handler({ httpMethod: 'DELETE' })).statusCode, 405);
  });
  console.log(`\n${n} passing${process.exitCode ? ' — with failures' : ''}`);
})();
