// Run with:  node tests/customer-notes.test.js
// The customer-notes function (Brendan's own notes about an account), with a pretend blob store.
const assert = require('assert');
const store = { notes: undefined };
const fake = { get: async (k) => (store[k] === undefined ? null : JSON.parse(JSON.stringify(store[k]))), setJSON: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
const blobPath = require.resolve('../netlify/functions/lib/blob-store.js');
require.cache[blobPath] = { id: blobPath, filename: blobPath, loaded: true, exports: { customerNotesStore: () => fake } };
const notes = require('../netlify/functions/customer-notes.js').handler;
const post = (b) => notes({ httpMethod: 'POST', body: JSON.stringify(b) });
const get = async () => JSON.parse((await notes({ httpMethod: 'GET' })).body);
let n = 0;
const test = async (name, fn) => { store.notes = undefined; try { await fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };

(async () => {
  await test('a note is saved under the customer (any capitalisation), oldest first, with a time and an id', async () => {
    const a = await post({ customerName: 'Acme Pty Ltd ', text: 'Promised payment Friday', promise: '2026-11-13' });
    assert.strictEqual(a.statusCode, 200);
    await post({ customerName: 'ACME PTY LTD', text: ' Usually pays late but always pays ' });
    const all = await get();
    assert.deepStrictEqual(Object.keys(all), ['ACME PTY LTD']);
    assert.deepStrictEqual(all['ACME PTY LTD'].map((x) => [x.text, x.promise]), [['Promised payment Friday', '2026-11-13'], ['Usually pays late but always pays', '']]);
    assert.ok(all['ACME PTY LTD'].every((x) => x.id && Date.parse(x.at) > Date.now() - 5000));
    assert.notStrictEqual(all['ACME PTY LTD'][0].id, all['ACME PTY LTD'][1].id);
    assert.strictEqual(JSON.parse(a.body).note.text, 'Promised payment Friday');
  });
  await test('notes are kept per customer', async () => {
    await post({ customerName: 'A', text: 'one' });
    await post({ customerName: 'B', text: 'two' });
    const all = await get();
    assert.deepStrictEqual([all.A.length, all.B.length], [1, 1]);
  });
  await test('a note can be deleted; the customer disappears when their last note goes; unknown ids are a 404', async () => {
    const { note } = JSON.parse((await post({ customerName: 'A', text: 'one' })).body);
    await post({ customerName: 'A', text: 'two' });
    assert.strictEqual((await post({ customerName: 'A', deleteId: note.id })).statusCode, 200);
    assert.deepStrictEqual((await get()).A.map((x) => x.text), ['two']);
    assert.strictEqual((await post({ customerName: 'A', deleteId: 'nope' })).statusCode, 404);
    const last = (await get()).A[0];
    await post({ customerName: 'A', deleteId: last.id });
    assert.strictEqual((await get()).A, undefined);
  });
  await test('bad input is refused: empty or over-long note, impossible dates, missing customer', async () => {
    for (const [b, re] of [
      [{ customerName: 'A', text: '   ' }, /empty/i],
      [{ customerName: 'A', text: 'x'.repeat(301) }, /300/],
      [{ customerName: 'A', text: 'ok', promise: '2026-02-31' }, /real date/],
      [{ customerName: 'A', text: 'ok', promise: 'Friday' }, /real date/],
      [{ customerName: 'A', text: 'ok', promise: '13/11/2026' }, /real date/],
      [{ customerName: '', text: 'ok' }, /customerName/],
    ]) {
      const r = await post(b);
      assert.strictEqual(r.statusCode, 400, JSON.stringify(b).slice(0, 50));
      assert.ok(re.test(JSON.parse(r.body).error), r.body);
    }
    assert.deepStrictEqual(await get(), {});
    assert.strictEqual((await post({ customerName: 'A', text: 'x'.repeat(300) })).statusCode, 200, '300 characters is fine');
  });
  await test('50 notes per customer is the most', async () => {
    for (let i = 0; i < 50; i++) assert.strictEqual((await post({ customerName: 'A', text: 'n' + i })).statusCode, 200);
    const r = await post({ customerName: 'A', text: 'one too many' });
    assert.strictEqual(r.statusCode, 400);
    assert.ok(/50 notes/.test(JSON.parse(r.body).error));
  });
  await test('only GET and POST; bad JSON is a 400', async () => {
    assert.strictEqual((await notes({ httpMethod: 'PUT' })).statusCode, 405);
    assert.strictEqual((await notes({ httpMethod: 'POST', body: '{nope' })).statusCode, 400);
  });
  console.log(`\n${n} passing${process.exitCode ? ' — with failures' : ''}`);
})();
