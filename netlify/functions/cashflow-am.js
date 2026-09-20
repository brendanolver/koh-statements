const { cashflowCacheStore } = require('./lib/blob-store');

// Apparel Magic data for the Cashflow forecast: open wholesale sales orders
// (confirmed future wholesale business — customer, value, delivery date) and,
// best-effort, open purchase orders (stock/factory commitments).
//
// Patterns reused from the other WNDRR apps (wndrrtuesday / demandplanning):
//  - AM token in env (AM_TOKEN here), list endpoints paged with
//    pagination[page_size] (10..1000) + pagination[last_id] cursor
//  - orders?is_open=1 embeds order_items (qty_open, amount_open, date_due) —
//    and AM's date/customer filters don't work, so filtering is done here
//  - customer 1068 is WNDRR's own online-store customer: its orders are
//    Shopify stock allocation, not wholesale, so they're excluded (this is the
//    Shopify <-> AM de-duplication rule)
// An open order's `amount_open` is the *unshipped* balance, ex-GST; shipped
// parts are invoiced (and reach Xero AR), so counting only amount_open is what
// keeps an order and its later invoice from being counted twice.
const AM_BASE = 'https://kohindustries.app.apparelmagic.com/api';
const ONLINE_STORE_CUSTOMER_ID = '1068';
const PAGE_SIZE = 100;          // ~2.6MB per page of open orders (embedded items)
const TIME_BUDGET_MS = 8000;    // one invocation only does a slice of the crawl
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_PAGES = 40;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

async function amGet(endpoint, params) {
  const token = (process.env.AM_TOKEN || '').trim();
  const qs = new URLSearchParams({ ...params, token, time: String(Date.now()) });
  const resp = await fetch(`${AM_BASE}/${endpoint}/?${qs}`);
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* handled below */ }
  if (!resp.ok || !data) throw new Error(`Apparel Magic ${endpoint} returned ${resp.status}${data ? '' : ' (not JSON)'}`);
  return data;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const isoOrNull = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null);

// Reduces one raw AM order (with embedded items) to what the forecast needs.
// Returns null for orders that must not count as wholesale receipts.
function compactOrder(o) {
  if (String(o.customer_id) === ONLINE_STORE_CUSTOMER_ID) return null; // Shopify channel
  if (String(o.is_quote) === '1' || o.void === '1' || o.void === 1) return null;
  const items = Array.isArray(o.order_items) ? o.order_items : [];
  const byDue = new Map();
  for (const it of items) {
    if (num(it.qty_open) <= 0) continue;
    const due = isoOrNull(it.date_due_internal) || isoOrNull(o.date_due_internal) || isoOrNull(o.date_internal);
    if (!due) continue;
    byDue.set(due, (byDue.get(due) || 0) + num(it.amount_open));
  }
  if (!byDue.size) return null;
  const sub = num(o.amount_subtotal);
  return {
    id: String(o.order_id),
    cid: String(o.customer_id),
    cn: String(o.customer_name || '').trim(),
    po: o.customer_po || '',
    cur: o.currency_name || 'AUD',
    // GST on this order as a fraction of its ex-GST value (0 for export / NZ).
    gst: sub > 0 ? Math.round((num(o.amount_tax_total) / sub) * 1000) / 1000 : 0,
    ordered: isoOrNull(o.date_internal),
    lines: [...byDue.entries()].map(([d, v]) => ({ d, v: Math.round(v * 100) / 100 })).sort((a, b) => (a.d < b.d ? -1 : 1)),
  };
}

// Purchase orders. Field names confirmed against the live AM account: an open PO
// has amount_open / qty_open > 0 and a receiving_status other than "Received";
// date_ex_factory is when the goods leave the factory (when the factory is
// normally paid) and date_due is the warehouse arrival date. amount_* fields are
// in the home currency (AUD); foreign_amount_* are in the PO's own currency.
// qty_in_transit / qty_received are kept so we can tell goods that are already
// shipped (and so already billed in Xero) from goods not yet shipped.
function compactPurchaseOrder(p) {
  const id = p.purchase_order_id;
  if (id === undefined || id === null || id === '') return null;
  const amountOpen = num(p.amount_open);
  if (!(amountOpen > 0) || !(num(p.qty_open) > 0)) return null;
  if (String(p.receiving_status || '').toLowerCase() === 'received') return null;
  return {
    id: String(id),
    vendor: String(p.vendor_name || 'Supplier').trim(),
    po: p.vendor_po || '',
    cur: p.currency_name || 'AUD',
    amount: Math.round(amountOpen * 100) / 100,
    foreign: num(p.foreign_amount_open),
    rate: num(p.currency_rate),
    qty: num(p.qty), qtyOpen: num(p.qty_open), qtyRecv: num(p.qty_received), qtyTransit: num(p.qty_in_transit),
    due: isoOrNull(p.date_ex_factory_internal) || isoOrNull(p.date_due_internal) || isoOrNull(p.date_internal),
    arrive: isoOrNull(p.date_due_internal),
    ordered: isoOrNull(p.date_internal),
    status: p.receiving_status || '',
  };
}

async function crawl(kind, cache, timeLeft) {
  const endpoint = kind === 'purchase_orders' ? 'purchase_orders' : 'orders';
  const params = { 'pagination[page_size]': String(kind === 'purchase_orders' ? 100 : PAGE_SIZE) };
  // orders accept is_open=1; purchase_orders may not (AM answers "field does not exist"), in
  // which case we page everything and keep only the open ones when mapping.
  if (kind === 'orders' || !cache.noOpenFilter) params.is_open = '1';
  let pages = 0;
  while (!cache.done && pages < MAX_PAGES && timeLeft() > 3500) {
    const p = { ...params };
    if (cache.cursor) p['pagination[last_id]'] = cache.cursor;
    let data = await amGet(endpoint, p);
    if (data.meta && data.meta.errors && data.meta.errors.length && kind === 'purchase_orders' && params.is_open) {
      cache.noOpenFilter = true; delete params.is_open; delete p.is_open;
      data = await amGet(endpoint, p);
    }
    if (data.meta && data.meta.errors && data.meta.errors.length) {
      cache.error = data.meta.errors.join('; ').slice(0, 300);
      cache.done = true;
      break;
    }
    const rows = data.response || [];
    pages++;
    if (kind === 'purchase_orders') {
      if (!cache.sampleKeys && rows[0]) cache.sampleKeys = Object.keys(rows[0]).sort();
      for (const r of rows) { const c = compactPurchaseOrder(r); if (c) cache.items.push(c); }
    } else {
      for (const r of rows) { const c = compactOrder(r); if (c) cache.items.push(c); }
    }
    cache.scanned = (cache.scanned || 0) + rows.length;
    const meta = data.meta && data.meta.pagination;
    cache.total = meta ? meta.total_records : cache.total;
    if (!meta || rows.length < params['pagination[page_size]'] || !meta.last_id) cache.done = true;
    else cache.cursor = meta.last_id;
  }
  return pages;
}

exports.handler = async (event) => {
  const t0 = Date.now();
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - t0);
  try {
    if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });
    if (!(process.env.AM_TOKEN || '').trim()) return json(503, { code: 'not_configured', error: 'AM_TOKEN is not set.' });

    const qs = event.queryStringParameters || {};
    const kind = qs.resource === 'purchase_orders' ? 'purchase_orders' : 'orders';
    const store = cashflowCacheStore();
    const key = `am-${kind}`;
    let cache = await store.get(key, { type: 'json', consistency: 'strong' });
    const stale = !cache || qs.refresh === '1' && cache.done || (cache.done && Date.now() - cache.fetchedAt > CACHE_TTL_MS);
    if (stale) cache = { fetchedAt: Date.now(), done: false, cursor: null, items: [], scanned: 0 };

    if (!cache.done) {
      try {
        await crawl(kind, cache, timeLeft);
      } catch (err) {
        // Keep whatever was read so far; the page can retry the next slice.
        await store.setJSON(key, cache);
        return json(502, { code: 'am_error', error: err.message, scanned: cache.scanned });
      }
      if (cache.done) cache.fetchedAt = Date.now();
      await store.setJSON(key, cache);
    }

    return json(200, {
      resource: kind,
      done: cache.done,
      fetchedAt: cache.fetchedAt,
      progress: { scanned: cache.scanned || 0, total: cache.total || null },
      items: cache.done ? cache.items : [],
      error: cache.error || null,
      sampleKeys: cache.sampleKeys || null,
    });
  } catch (err) {
    return json(500, { code: 'server_error', error: err.message });
  }
};

exports._compactOrder = compactOrder;
exports._compactPurchaseOrder = compactPurchaseOrder;
