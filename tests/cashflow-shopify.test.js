// Run with:  node tests/cashflow-shopify.test.js
// Fake Shopify with a *busy* week (thousands of orders on Black-Friday-style days) and a tiny
// time budget, to prove the backfill always makes progress and never double-counts.
process.env.CASHFLOW_SHOPIFY_BUDGET_MS = '3000';
process.env.SHOPIFY_ACCESS_TOKEN = 't';
const assert = require('assert');
const Module = require('module'); const orig = Module._load;
const mem = {};
Module._load = function (r, p, ...a) { if (r === './lib/blob-store') return { cashflowCacheStore: () => ({ get: async (k) => (mem[k] ? JSON.parse(mem[k]) : null), setJSON: async (k, v) => { mem[k] = JSON.stringify(v); } }) }; return orig.call(this, r, p, ...a); };
const fn = require('../netlify/functions/cashflow-shopify.js');
const DAY = 86400000, iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(new Date());
// 8 orders/day normally; 2,500 orders/day for 5 days ~90 days ago (one "peak" week), $10 each
const perDay = (i) => (i >= 88 && i <= 92 ? 2500 : 8);
const ORDERS = [];
for (let i = 0; i < 440; i++) { const d = iso(Date.parse(today + 'T00:00:00Z') - i * DAY); for (let k = 0; k < perDay(i); k++) ORDERS.push({ created_at: `${d}T${String(k % 20).padStart(2, '0')}:00:00+11:00`, cancelled_at: k % 50 === 0 ? 'x' : null, current_total_price: '10.00' }); }
let requests = 0;
global.fetch = async (url) => {
  requests++; await new Promise((r) => setTimeout(r, 25)); // every page takes a moment
  const u = new URL(url); const min = Date.parse(u.searchParams.get('created_at_min')), max = Date.parse(u.searchParams.get('created_at_max'));
  const all = ORDERS.filter((o) => { const t = Date.parse(o.created_at); return t >= min && t <= max; });
  const pg = Number(u.searchParams.get('pg') || 0), per = 250, slice = all.slice(pg * per, (pg + 1) * per), hasNext = (pg + 1) * per < all.length;
  u.searchParams.set('pg', String(pg + 1));
  return { ok: true, status: 200, headers: { get: (h) => (h === 'link' && hasNext ? `<${u}>; rel="next"` : null) }, json: async () => ({ orders: slice }), text: async () => '' };
};
(async () => {
  let n = 0, last, prevThrough = null, stalled = 0;
  do {
    const r = await fn.handler({ httpMethod: 'GET' }); last = JSON.parse(r.body); n++;
    if (last.through === prevThrough) stalled++; else stalled = 0; prevThrough = last.through;
    assert.ok(stalled < 40, 'backfill stalled at ' + last.through);
  } while (!last.done && n < 400);
  assert.ok(last.done, 'backfill finished'); console.log(`  ok  finished in ${n} slices, ${requests} Shopify requests (a peak week of ~12,500 orders included)`);
  const d = last.daily;
  const wrong = Object.entries(d).filter(([day, [sales, cnt]]) => { const i = Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(day + 'T00:00:00Z')) / DAY); const total = perDay(i); const cancelled = Math.ceil(total / 50); const expected = total - cancelled; return cnt !== expected || Math.abs(sales - expected * 10) > 0.01; });
  assert.strictEqual(wrong.length, 0, 'every day exact (resumed windows never double-count, cancelled excluded): ' + JSON.stringify(wrong.slice(0, 3)));
  console.log(`  ok  ${Object.keys(d).length} days, every day's orders and total exact`);
  const before = requests; const r2 = JSON.parse((await fn.handler({ httpMethod: 'GET' })).body);
  assert.ok(r2.done && requests - before < 60, 'steady state only re-reads the last two weeks'); console.log(`  ok  steady state re-read used ${requests - before} requests`);
  console.log('\n3 passing');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
