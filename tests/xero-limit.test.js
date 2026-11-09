// Run with:  node tests/xero-limit.test.js
// The page's Xero fetch helper: when Xero says its DAILY limit is used up (a 429 with a Retry-After of hours) the page must say so
// straight away — not wait and retry for minutes per call, which made every tab look stuck — while the 60-calls-a-minute limit
// still waits and retries as before.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const a = html.indexOf('// "Xero\'s daily limit has been reached');
const b = html.indexOf('async function fetchXeroJson(url) {');
assert.ok(a > 0 && b > a, 'helper not found in index.html');
const end = html.indexOf('\n}\n', b) + 3;
const src = html.slice(a, end);

let n = 0;
async function test(name, f) { try { await f(); n++; console.log('  ok  ' + name); } catch (e) { process.exitCode = 1; console.log('FAIL  ' + name + '\n      ' + e.message); } }

// a fake fetch that replays a list of responses, and a setTimeout that records the waits instead of waiting
function load(responses) {
  const calls = [], waits = [];
  let i = 0;
  const fakeFetch = async () => {
    calls.push(1);
    const r = responses[Math.min(i++, responses.length - 1)];
    return { status: r.status, headers: { get: (h) => (h.toLowerCase() === 'retry-after' && r.retryAfter !== undefined ? String(r.retryAfter) : null) }, text: async () => r.body || '' };
  };
  const fakeTimeout = (fn, ms) => { waits.push(ms); fn(); };
  const mod = new Function('fetch', 'setTimeout', `${src}\nreturn { fetchXeroJson, xeroDailyLimitMessage };`)(fakeFetch, fakeTimeout);
  return { ...mod, calls, waits };
}

(async () => {
  await test('the daily limit (Retry-After of hours) is reported at once: one call, no waiting, and the message says when it resets', async () => {
    const t = load([{ status: 429, retryAfter: 62507 }]);
    await assert.rejects(() => t.fetchXeroJson('/x'), (e) => /daily limit/.test(e.message) && /resets around/.test(e.message) && /Nothing is wrong with the app/.test(e.message));
    assert.strictEqual(t.calls.length, 1, 'no retries');
    assert.deepStrictEqual(t.waits, [], 'and no waiting');
  });
  await test('the per-minute limit (a short Retry-After) still waits and retries, then succeeds', async () => {
    const t = load([{ status: 429, retryAfter: 3 }, { status: 429, retryAfter: 3 }, { status: 200, body: '{"ok":true}' }]);
    const { data } = await t.fetchXeroJson('/x');
    assert.deepStrictEqual(data, { ok: true });
    assert.strictEqual(t.calls.length, 3);
    assert.deepStrictEqual(t.waits, [3000, 3000], 'honours Retry-After');
  });
  await test('a per-minute limit that never clears gives up after 4 tries with the 60-a-minute message', async () => {
    const t = load([{ status: 429, retryAfter: 20 }]);
    await assert.rejects(() => t.fetchXeroJson('/x'), (e) => /60 calls\/min/.test(e.message));
    assert.strictEqual(t.calls.length, 4);
  });
  await test('exactly 60 seconds is still the per-minute limit; 61 is treated as the daily one', async () => {
    const t60 = load([{ status: 429, retryAfter: 60 }]);
    await assert.rejects(() => t60.fetchXeroJson('/x'), (e) => /60 calls\/min/.test(e.message));
    const t61 = load([{ status: 429, retryAfter: 61 }]);
    await assert.rejects(() => t61.fetchXeroJson('/x'), (e) => /daily limit/.test(e.message));
    assert.strictEqual(t61.calls.length, 1);
  });
  await test('normal responses, and empty / non-JSON bodies, behave as before', async () => {
    assert.deepStrictEqual((await load([{ status: 200, body: '{"a":1}' }]).fetchXeroJson('/x')).data, { a: 1 });
    const t = load([{ status: 502, body: '<html>timeout</html>' }, { status: 200, body: '{"a":2}' }]);
    assert.deepStrictEqual((await t.fetchXeroJson('/x')).data, { a: 2 });
    assert.deepStrictEqual(t.waits, [3000], 'a non-JSON reply waits 3 s and retries');
  });
  await test('the reset time is worded as "tomorrow" when it is not today', async () => {
    const { xeroDailyLimitMessage } = load([{ status: 200, body: '{}' }]);
    assert.ok(/tomorrow/.test(xeroDailyLimitMessage(40 * 3600)), 'two days away');
    assert.ok(!/tomorrow/.test(xeroDailyLimitMessage(1)), 'a second from now is today');
  });
  console.log(`\n${n} passing${process.exitCode ? ' — with failures' : ''}`);
})();
