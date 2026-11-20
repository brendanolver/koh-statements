const { withAuth } = require('./lib/auth');
const { pnlSettingsStore } = require('./lib/blob-store');

// The P&L tab's remembered Trading P&L settings: the cost-of-goods % for Online sales and for Wholesale sales, and Advertising -
// Social Media as a % of Online sales (starts at 35; saved as '' when it has been cleared, meaning "use Xero's actual").
// Also the manual stock counts (a date and the value of the stock on hand that day) used when Xero's opening / closing stock
// isn't kept up to date.
// One tiny JSON document, last save wins. Server side (not just localStorage) so the percentages follow
// across devices and stay until someone changes them.
const MAX_BYTES = 16 * 1024;
const MAX_STOCK_COUNTS = 100;
const DEFAULT_ADVERTISING = 35;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

// A percentage 0–100 (two decimals), or '' for "not set". Anything else is dropped.
function pct(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) / 100 : '';
}

// Keep only the shape the page understands — never store arbitrary blobs.
// `keepAdvertising` is what to use when the body doesn't mention advertising at all (an older open page that only knows about
// the cost-of-goods percentages must not wipe or reset it).
// A stock count: a real YYYY-MM-DD date and a value of 0 or more (cents). Anything else is dropped; one count per date (last wins).
function stockCounts(list) {
  const byDate = new Map();
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !/^\d{4}-\d{2}-\d{2}$/.test(String(c.date)) || Number.isNaN(Date.parse(c.date + 'T00:00:00Z'))) continue;
    if (c.value === '' || c.value === null || c.value === undefined) continue;
    const v = Number(c.value);
    if (Number.isFinite(v) && v >= 0 && v < 1e12) byDate.set(c.date, Math.round(v * 100) / 100);
  }
  return [...byDate].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-MAX_STOCK_COUNTS).map(([date, value]) => ({ date, value }));
}

// `keep` is what to use for anything the body doesn't mention at all ({ advertising, stock }): an older open page that only knows
// about the cost-of-goods percentages must not wipe or reset advertising or the stock counts.
function sanitise(doc, keep) {
  keep = keep || {};
  const c = doc && typeof doc.cogs === 'object' && doc.cogs ? doc.cogs : {};
  const has = (k) => doc && typeof doc === 'object' && k in doc;
  const advertising = has('advertising') ? pct(doc.advertising) : (keep.advertising !== undefined ? keep.advertising : DEFAULT_ADVERTISING);
  const stock = has('stock') ? stockCounts(doc.stock) : (keep.stock || []);
  return { cogs: { online: pct(c.online), wholesale: pct(c.wholesale) }, advertising, stock, updatedAt: new Date().toISOString() };
}

const handler = async (event) => {
  try {
    const store = pnlSettingsStore();
    if (event.httpMethod === 'GET') {
      const doc = (await store.get('settings', { type: 'json', consistency: 'strong' })) || { cogs: { online: '', wholesale: '' }, updatedAt: null };
      if (!('advertising' in doc)) doc.advertising = DEFAULT_ADVERTISING; // nothing saved about it yet
      if (!Array.isArray(doc.stock)) doc.stock = [];
      return json(200, doc);
    }
    if (event.httpMethod === 'POST') {
      if ((event.body || '').length > MAX_BYTES) return json(413, { error: 'Too large' });
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }
      const prev = await store.get('settings', { type: 'json', consistency: 'strong' }).catch(() => null);
      const doc = sanitise(body, { advertising: prev && 'advertising' in prev ? prev.advertising : undefined, stock: prev && Array.isArray(prev.stock) ? prev.stock : [] });
      await store.setJSON('settings', doc);
      return json(200, { ok: true, updatedAt: doc.updatedAt });
    }
    return json(405, { error: 'GET or POST only' });
  } catch (err) {
    return json(500, { error: err.message });
  }
};

exports._sanitise = sanitise;

// Signed-in people only, and only with one of these sections ticked (see lib/auth.js).
exports.handler = withAuth(['pnl'], handler);
