const { commissionEmailsStore } = require('./lib/blob-store');

// Mirrors debtor-status.js exactly: one shared JSON blob, GET returns the
// whole map, POST upserts a single entry — server-side so a saved
// multi-recipient list follows Brendan across browsers/devices instead of
// being stuck in whichever one he typed it into.
exports.handler = async (event) => {
  try {
    const store = commissionEmailsStore();

    if (event.httpMethod === 'GET') {
      const map = (await store.get('email-map', { type: 'json' })) || {};
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(map) };
    }

    if (event.httpMethod === 'POST') {
      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
      }

      const { agentName, email } = body;
      if (!agentName) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing agentName' }) };
      }

      const map = (await store.get('email-map', { type: 'json' })) || {};
      if (email) {
        map[agentName] = email;
      } else {
        delete map[agentName];
      }
      await store.setJSON('email-map', map);

      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'GET or POST only' }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
