const { hiddenCustomersStore } = require('./lib/blob-store');

// Keyed by customer name, uppercased+trimmed — the one identifier AM and
// Xero are both keyed by consistently in this app (see buildDebtorsList's
// own AM/Xero name join). A contactId would only cover the Debtors side;
// the Statements-tab search picker works off AM's raw customer list, which
// has no Xero ContactID until a statement is actually built for it.
function normName(name) {
  return String(name || '').trim().toUpperCase();
}

exports.handler = async (event) => {
  try {
    const store = hiddenCustomersStore();

    if (event.httpMethod === 'GET') {
      const map = (await store.get('hidden-map', { type: 'json' })) || {};
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(map) };
    }

    if (event.httpMethod === 'POST') {
      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
      }

      const { name, hidden, reason } = body;
      const key = normName(name);
      if (!key) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing name' }) };
      }

      const map = (await store.get('hidden-map', { type: 'json' })) || {};
      if (hidden) {
        map[key] = { reason: (reason || '').trim(), hiddenAt: new Date().toISOString() };
      } else {
        delete map[key];
      }
      await store.setJSON('hidden-map', map);

      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'GET or POST only' }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
