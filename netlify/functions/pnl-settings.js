const { withAuth } = require('./lib/auth');
const { pnlSettingsStore } = require('./lib/blob-store');

// The P&L tab's remembered Trading P&L settings: the cost-of-goods % for Online sales and for Wholesale sales, and Advertising -
// Social Media as a % of Online sales (starts at 35; saved as '' when it has been cleared, meaning "use Xero's actual").
// One tiny JSON document, last save wins. Server side (not just localStorage) so the percentages follow
// across devices and stay until someone changes them.
const MAX_BYTES = 2 * 1024;
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
function sanitise(doc, keepAdvertising) {
  const c = doc && typeof doc.cogs === 'object' && doc.cogs ? doc.cogs : {};
  const advertising = doc && typeof doc === 'object' && 'advertising' in doc ? pct(doc.advertising) : (keepAdvertising !== undefined ? keepAdvertising : DEFAULT_ADVERTISING);
  return { cogs: { online: pct(c.online), wholesale: pct(c.wholesale) }, advertising, updatedAt: new Date().toISOString() };
}

const handler = async (event) => {
  try {
    const store = pnlSettingsStore();
    if (event.httpMethod === 'GET') {
      const doc = (await store.get('settings', { type: 'json', consistency: 'strong' })) || { cogs: { online: '', wholesale: '' }, updatedAt: null };
      if (!('advertising' in doc)) doc.advertising = DEFAULT_ADVERTISING; // nothing saved about it yet
      return json(200, doc);
    }
    if (event.httpMethod === 'POST') {
      if ((event.body || '').length > MAX_BYTES) return json(413, { error: 'Too large' });
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }
      const prev = await store.get('settings', { type: 'json', consistency: 'strong' }).catch(() => null);
      const doc = sanitise(body, prev && 'advertising' in prev ? prev.advertising : undefined);
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
