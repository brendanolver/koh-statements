const { debtorStatusStore } = require('./lib/blob-store');

const VALID_STATUSES = new Set(['stop', 'clear', null]);

exports.handler = async (event) => {
  try {
    const store = debtorStatusStore();

    if (event.httpMethod === 'GET') {
      const map = (await store.get('status-map', { type: 'json' })) || {};
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(map) };
    }

    if (event.httpMethod === 'POST') {
      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
      }

      const { contactId, status } = body;
      if (!contactId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing contactId' }) };
      }
      if (!VALID_STATUSES.has(status)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'status must be "stop", "clear", or null' }) };
      }

      const map = (await store.get('status-map', { type: 'json' })) || {};
      if (status === null) {
        delete map[contactId];
      } else {
        map[contactId] = status;
      }
      await store.setJSON('status-map', map);

      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'GET or POST only' }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
