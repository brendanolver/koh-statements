const { cashflowCacheStore } = require('./lib/blob-store');

// Shopify online (DTC) sales history for the Cashflow forecast — daily order
// totals, so the forecast can use recent run-rate + last year's seasonality.
//
// Reused from wndrrtuesday's shopify-client.ts / kpis.ts (same store, same
// token): Shopify Admin REST API, X-Shopify-Access-Token, orders.json with
// status=any, cancelled orders dropped, current_total_price (already net of
// refunds/edits), cursor pagination via the Link header. Tuesday's notes also
// apply: the token needs read_orders + read_all_orders (without the latter
// Shopify silently returns only ~60 days), and a full 2-year pull is slow
// (~78k orders) — so this reads ~14 months in 7-day windows, a slice per
// invocation, saving progress; the page keeps calling until it's done. After
// the first backfill only the last 2 weeks are re-read each time.
//
// Env: SHOPIFY_STORE_URL (e.g. thewndrr.myshopify.com) and SHOPIFY_ACCESS_TOKEN
// (SHOPIFY_ADMIN_TOKEN, the demandplanning app's name for it, also accepted).
const API_VERSION = '2024-07';
// 56 days of trend + the same 56 days a year earlier (364 back) = 420, plus margin.
const HISTORY_DAYS = 430;
const WINDOW_DAYS = 7;
const REREAD_DAYS = 14;
const TIME_BUDGET_MS = Number(process.env.CASHFLOW_SHOPIFY_BUDGET_MS) || 8000;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

const DAY = 86400000;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const todayInMelbourne = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(new Date());

function config() {
  const store = (process.env.SHOPIFY_STORE_URL || 'thewndrr.myshopify.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = (process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN || '').trim();
  return token ? { store, token } : null;
}

async function shopifyGet(cfg, urlOrPath) {
  const url = urlOrPath.startsWith('http') ? urlOrPath : `https://${cfg.store}/admin/api/${API_VERSION}${urlOrPath}`;
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': cfg.token, 'Content-Type': 'application/json' } });
    if (resp.status === 429 && attempt < 3) {
      const wait = Number(resp.headers.get('retry-after')) || 2;
      await new Promise((r) => setTimeout(r, Math.min(wait, 5) * 1000));
      continue;
    }
    if (!resp.ok) {
      const body = await resp.text();
      const err = new Error(`Shopify ${resp.status}: ${body.slice(0, 200)}`);
      err.status = resp.status;
      throw err;
    }
    return resp;
  }
}

const nextLink = (header) => {
  for (const part of String(header || '').split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
};

// Reads every non-cancelled order created in [fromIso-1d, toIso+1d] (a day of margin each
// side so shop-timezone midnight never drops an order), adding the ones whose local date
// falls inside [fromIso, toIso] into `part.daily`. A busy week (Black Friday: thousands of
// orders) can't be read inside one time slice, so progress is kept in `part` (including
// Shopify's next-page link) and the next invocation carries on from that page instead of
// restarting the window. Returns true once the window is fully read.
async function readWindow(cfg, fromIso, toIso, part, timeLeft) {
  let url = part.next;
  if (!url) {
    const params = new URLSearchParams({
      status: 'any', limit: '250', fields: 'id,created_at,cancelled_at,current_total_price',
      created_at_min: `${addDays(fromIso, -1)}T00:00:00Z`, created_at_max: `${addDays(toIso, 1)}T23:59:59Z`,
    });
    url = `/orders.json?${params}`;
  }
  for (;;) {
    const resp = await shopifyGet(cfg, url);
    const body = await resp.json();
    for (const o of body.orders || []) {
      if (o.cancelled_at) continue;
      const day = String(o.created_at).slice(0, 10);
      if (day < fromIso || day > toIso) continue;
      const e = part.daily[day] || (part.daily[day] = [0, 0]);
      e[0] = Math.round((e[0] + (Number(o.current_total_price) || 0)) * 100) / 100;
      e[1] += 1;
    }
    const next = nextLink(resp.headers.get('link'));
    if (!next) { part.next = null; return true; }
    part.next = next;
    if (timeLeft() < 1500) return false;
    url = next;
  }
}

exports.handler = async (event) => {
  const t0 = Date.now();
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - t0);
  try {
    if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });
    const cfg = config();
    if (!cfg) return json(200, { configured: false, note: 'Set SHOPIFY_ACCESS_TOKEN (and SHOPIFY_STORE_URL) in Netlify to enable Shopify-based online forecasting.' });

    const today = todayInMelbourne();
    const from = addDays(today, -HISTORY_DAYS);
    const store = cashflowCacheStore();
    let cache = await store.get('shopify-daily', { type: 'json', consistency: 'strong' });
    if (!cache || cache.from !== from && cache.from > from) cache = { from, through: null, daily: {}, partial: null };

    // Where to (re)start: the beginning on a first run, else 14 days before
    // what's already covered (recent orders get edited / refunded / cancelled).
    // Mid-backfill: carry straight on (or resume the half-read window). Only once the whole
    // history is in do we start each run 14 days back to pick up edits / refunds / cancels.
    let cursor = cache.partial ? cache.partial.from : cache.through ? (cache.complete ? addDays(cache.through, -(REREAD_DAYS - 1)) : addDays(cache.through, 1)) : from;
    if (cursor < from) cursor = from;
    let windows = 0;
    try {
      while (cursor <= today && timeLeft() > 2500 && windows < 8) {
        const winEnd = addDays(cursor, WINDOW_DAYS - 1) > today ? today : addDays(cursor, WINDOW_DAYS - 1);
        // Resume a half-read window if that's what the last slice left behind.
        const part = cache.partial && cache.partial.from === cursor && cache.partial.to === winEnd ? cache.partial : { from: cursor, to: winEnd, daily: {}, next: null };
        const finished = await readWindow(cfg, cursor, winEnd, part, timeLeft);
        if (!finished) { cache.partial = part; break; }
        for (let d = cursor; d <= winEnd; d = addDays(d, 1)) delete cache.daily[d];
        Object.assign(cache.daily, part.daily);
        cache.partial = null;
        cache.through = winEnd;
        cursor = addDays(winEnd, 1);
        windows++;
      }
    } catch (err) {
      await store.setJSON('shopify-daily', cache);
      const code = err.status === 401 || err.status === 403 ? 'shopify_not_authorised' : 'shopify_error';
      return json(200, { configured: true, error: { code, message: err.message }, done: false, through: cache.through, from });
    }
    if (cache.through && cache.through >= today) cache.complete = true;
    await store.setJSON('shopify-daily', cache);

    const done = !!cache.through && cache.through >= today;
    // Without read_all_orders Shopify returns only ~60 days — flag thin history
    // so the forecast doesn't pretend to have seasonality it doesn't have.
    const days = Object.keys(cache.daily).sort();
    return json(200, {
      configured: true, done, from, through: cache.through, today,
      firstDataDay: days[0] || null, dayCount: days.length,
      progress: { through: cache.through, target: today },
      daily: done ? cache.daily : {},
    });
  } catch (err) {
    return json(500, { code: 'server_error', error: err.message });
  }
};

exports._addDays = addDays;
