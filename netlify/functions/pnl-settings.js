const { pnlSettingsStore } = require('./lib/blob-store');

// The P&L tab's remembered Trading P&L settings: the cost-of-goods % for Online sales and for Wholesale sales.
// One tiny JSON document, last save wins. Server side (not just localStorage) so the percentages follow
// across devices and stay until someone changes them.
const MAX_BYTES = 2 * 1024;

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
function sanitise(doc) {
  const c = doc && typeof doc.cogs === 'object' && doc.cogs ? doc.cogs : {};
  return { cogs: { online: pct(c.online), wholesale: pct(c.wholesale) }, updatedAt: new Date().toISOString() };
}

exports.handler = async (event) => {
  try {
    const store = pnlSettingsStore();
    if (event.httpMethod === 'GET') {
      const doc = (await store.get('settings', { type: 'json', consistency: 'strong' })) || { cogs: { online: '', wholesale: '' }, updatedAt: null };
      return json(200, doc);
    }
    if (event.httpMethod === 'POST') {
      if ((event.body || '').length > MAX_BYTES) return json(413, { error: 'Too large' });
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }
      const doc = sanitise(body);
      await store.setJSON('settings', doc);
      return json(200, { ok: true, updatedAt: doc.updatedAt });
    }
    return json(405, { error: 'GET or POST only' });
  } catch (err) {
    return json(500, { error: err.message });
  }
};

exports._sanitise = sanitise;
