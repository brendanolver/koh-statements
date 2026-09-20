const { cashflowInputsStore } = require('./lib/blob-store');

// The Cashflow tab's saved manual inputs: monthly overrides per forecast line,
// scenario percentages, thresholds. One JSON document; last save wins. Server
// side (not localStorage) so the forecast assumptions follow across devices,
// same as the app's other saved settings.
const MAX_BYTES = 200 * 1024;
const LINES = ['online', 'wholesale', 'otherIn', 'stock', 'marketing', 'otherOut'];

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

// Keep only the shape the page understands — never store arbitrary blobs.
function sanitise(doc) {
  const out = { overrides: {}, settings: {}, updatedAt: new Date().toISOString() };
  const ov = doc && typeof doc.overrides === 'object' && doc.overrides ? doc.overrides : {};
  for (const line of LINES) {
    const months = ov[line];
    if (!months || typeof months !== 'object') continue;
    for (const [m, v] of Object.entries(months)) {
      const n = Number(v);
      if (/^\d{4}-\d{2}$/.test(m) && Number.isFinite(n)) (out.overrides[line] = out.overrides[line] || {})[m] = Math.round(n * 100) / 100;
    }
  }
  // Expected payment date per bill / PO (id -> YYYY-MM-DD), capped so the document stays small.
  const pd = doc && typeof doc.payDates === 'object' && doc.payDates ? doc.payDates : {};
  const dates = Object.entries(pd).filter(([k, v]) => /^(ap|po):[\w-]{1,80}$/.test(k) && /^\d{4}-\d{2}-\d{2}$/.test(String(v))).slice(0, 500);
  if (dates.length) out.payDates = Object.fromEntries(dates);
  const st = doc && typeof doc.settings === 'object' && doc.settings ? doc.settings : {};
  for (const k of ['defaultTermsDays', 'arLateDays', 'overdueCollectDays', 'apOverduePayDays', 'poTermsDays', 'cashThreshold', 'onlineConversion']) {
    const n = Number(st[k]);
    if (st[k] !== undefined && st[k] !== null && st[k] !== '' && Number.isFinite(n)) out.settings[k] = n;
  }
  if (st.scenarios && typeof st.scenarios === 'object') {
    out.settings.scenarios = {};
    for (const s of ['worst', 'base', 'best']) {
      const src = st.scenarios[s];
      if (!src || typeof src !== 'object') continue;
      out.settings.scenarios[s] = {};
      for (const k of ['online', 'wholesale', 'out', 'delay']) {
        const n = Number(src[k]);
        if (src[k] !== undefined && src[k] !== '' && Number.isFinite(n)) out.settings.scenarios[s][k] = n;
      }
    }
  }
  return out;
}

exports.handler = async (event) => {
  try {
    const store = cashflowInputsStore();
    if (event.httpMethod === 'GET') {
      const doc = (await store.get('inputs', { type: 'json', consistency: 'strong' })) || { overrides: {}, settings: {}, updatedAt: null };
      return json(200, doc);
    }
    if (event.httpMethod === 'POST') {
      if ((event.body || '').length > MAX_BYTES) return json(413, { error: 'Too large' });
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }
      const doc = sanitise(body);
      await store.setJSON('inputs', doc);
      return json(200, { ok: true, updatedAt: doc.updatedAt });
    }
    return json(405, { error: 'GET or POST only' });
  } catch (err) {
    return json(500, { error: err.message });
  }
};

exports._sanitise = sanitise;
