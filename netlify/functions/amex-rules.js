const { amexRulesStore } = require('./lib/blob-store');

// The Amex Import tab's remembered merchant rules: "when a charge looks like KEY, code it to this account,
// with this tax, against this contact". One small JSON document, last save wins. Server side (not just
// localStorage) so the rules follow across devices.
const MAX_BYTES = 64 * 1024;
const MAX_RULES = 500;
const TAXES = ['GST on Expenses', 'GST Free Expenses', 'BAS Excluded'];

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

// Keep only the shape the page understands — never store arbitrary blobs.
function sanitise(doc) {
  const input = doc && typeof doc.rules === 'object' && doc.rules && !Array.isArray(doc.rules) ? doc.rules : {};
  const rules = {};
  for (const [rawKey, r] of Object.entries(input)) {
    if (Object.keys(rules).length >= MAX_RULES) break;
    const key = String(rawKey).trim().toUpperCase().slice(0, 80);
    if (!key || !r || typeof r !== 'object') continue;
    // Each field is optional and kept only if valid: a rule can be just an account, just a tax, or just a
    // contact name — whatever it leaves out falls back to the app's defaults when it's applied.
    const rule = {};
    const account = String(r.account || '').trim();
    if (/^[A-Za-z0-9\/ .-]{1,12}$/.test(account)) rule.account = account;
    if (TAXES.includes(r.tax)) rule.tax = r.tax;
    const contact = String(r.contact || '').trim().slice(0, 100);
    if (contact) rule.contact = contact;
    if (Object.keys(rule).length) rules[key] = rule;
  }
  return { rules, updatedAt: new Date().toISOString() };
}

exports.handler = async (event) => {
  try {
    const store = amexRulesStore();
    if (event.httpMethod === 'GET') {
      const doc = (await store.get('rules', { type: 'json', consistency: 'strong' })) || { rules: {}, updatedAt: null };
      return json(200, doc);
    }
    if (event.httpMethod === 'POST') {
      if ((event.body || '').length > MAX_BYTES) return json(413, { error: 'Too large' });
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }
      const doc = sanitise(body);
      await store.setJSON('rules', doc);
      return json(200, { ok: true, count: Object.keys(doc.rules).length, updatedAt: doc.updatedAt });
    }
    return json(405, { error: 'GET or POST only' });
  } catch (err) {
    return json(500, { error: err.message });
  }
};

exports._sanitise = sanitise;
