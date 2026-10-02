// Read-only Debtors feed for other apps (the WMS). Same figures as the Debtors
// tab, built server-side. Protected by a shared key (DEBTORS_FEED_KEY) sent as
// "Authorization: Bearer <key>" or "x-feed-key".
//
//   GET /.netlify/functions/debtors-feed            → cached for up to 5 minutes
//   GET /.netlify/functions/debtors-feed?refresh=1  → re-read Xero (at most once a minute)
const crypto = require('crypto');
const { getValidConnection } = require('./lib/xero-auth');
const { debtorsFeedStore, debtorStatusStore, hiddenCustomersStore } = require('./lib/blob-store');
const { todayIso, bucketLabels, buildDebtors, decorate } = require('./lib/debtors');

const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_REFRESH_MS = 60 * 1000;
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

const reply = (statusCode, body, extra) => ({ statusCode, headers: { ...JSON_HEADERS, ...(extra || {}) }, body: JSON.stringify(body) });

function keyOk(event) {
  const expected = process.env.DEBTORS_FEED_KEY || '';
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || '';
  const given = (auth.startsWith('Bearer ') ? auth.slice(7) : h['x-feed-key'] || h['X-Feed-Key'] || '').trim();
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

class XeroRateLimit extends Error {}

async function xeroPages(connection, path, where, key, extra, pageSize) {
  const all = [];
  for (let page = 1; page <= 30; page++) {
    const params = new URLSearchParams({ where, page: String(page), ...(extra || {}) });
    if (pageSize) params.set('pageSize', String(pageSize));
    const resp = await fetch(`${XERO_API_BASE}/${path}?${params}`, {
      headers: { Authorization: `Bearer ${connection.access_token}`, 'Xero-tenant-id': connection.tenant_id, Accept: 'application/json' },
    });
    if (resp.status === 429) throw new XeroRateLimit(`Xero rate limit (retry after ${resp.headers.get('retry-after') || '?'}s)`);
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`Xero ${path} returned an unreadable response (${resp.status})`); }
    if (!resp.ok) throw new Error(data.Detail || data.Message || `Xero ${path} failed (${resp.status})`);
    const rows = data[key] || [];
    all.push(...rows);
    if (rows.length < (pageSize || 100)) break;
  }
  return all;
}

async function refreshFromXero(today) {
  const connection = await getValidConnection();
  const [openInvoices, submittedInvoices, creditNotes] = await Promise.all([
    xeroPages(connection, 'Invoices', 'Type=="ACCREC" && AmountDue>0', 'Invoices', { summaryOnly: 'true' }, 1000),
    xeroPages(connection, 'Invoices', 'Type=="ACCREC" && Status=="SUBMITTED"', 'Invoices', { summaryOnly: 'true' }, 1000),
    xeroPages(connection, 'CreditNotes', 'Type=="ACCRECCREDIT" && Status=="AUTHORISED" && RemainingCredit>0', 'CreditNotes'),
  ]);
  return { today, generatedAt: new Date().toISOString(), rows: buildDebtors({ openInvoices, submittedInvoices, creditNotes, today }) };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') return reply(405, { error: 'GET only' });
    if (!process.env.DEBTORS_FEED_KEY) return reply(503, { error: 'Debtors feed is not configured (DEBTORS_FEED_KEY missing).' });
    if (!keyOk(event)) return reply(401, { error: 'Unauthorized' });

    const store = debtorsFeedStore();
    const cached = await store.get('snapshot', { type: 'json' });
    const age = cached ? Date.now() - Date.parse(cached.generatedAt) : Infinity;
    const wantRefresh = !!(event.queryStringParameters && event.queryStringParameters.refresh);
    const today = todayIso();

    let snap = cached;
    let stale = false;
    const fresh = cached && cached.today === today && age < CACHE_TTL_MS;
    if (!fresh || (wantRefresh && age >= MIN_REFRESH_MS)) {
      try {
        snap = await refreshFromXero(today);
        await store.setJSON('snapshot', snap);
      } catch (err) {
        if (!cached) {
          const limited = err instanceof XeroRateLimit;
          return reply(limited ? 503 : 502, { error: err.message }, limited ? { 'Retry-After': '60' } : undefined);
        }
        stale = true; // serve the last good snapshot rather than nothing
      }
    }

    const [statusMap, hiddenMap] = await Promise.all([
      debtorStatusStore().get('status-map', { type: 'json' }),
      hiddenCustomersStore().get('hidden-map', { type: 'json' }),
    ]);
    const { debtors, stats, hiddenCount } = decorate(snap.rows, statusMap, hiddenMap);
    return reply(200, {
      asAt: snap.today,
      generatedAt: snap.generatedAt,
      stale,
      bucketLabels: bucketLabels(snap.today),
      stats,
      hiddenCount,
      debtors,
    });
  } catch (err) {
    return reply(500, { error: err.message });
  }
};
