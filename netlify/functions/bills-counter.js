const { billsCounterStore } = require('./lib/blob-store');

// Same shared-blob pattern as debtor-status.js / commission-emails.js, just
// a single number instead of a map — the running placeholder-invoice-number
// sequence (INV-001, INV-002, ...) needs to survive across sessions/devices
// so two different upload batches never reuse the same placeholder number.
exports.handler = async (event) => {
  try {
    const store = billsCounterStore();

    if (event.httpMethod === 'GET') {
      const value = (await store.get('seq', { type: 'json' })) || 0;
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) };
    }

    if (event.httpMethod === 'POST') {
      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
      }

      const { value } = body;
      if (typeof value !== 'number' || value < 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'value must be a non-negative number' }) };
      }

      // Never let a slow/stale request overwrite a value another tab has
      // already advanced past — only ever move the counter forward.
      const current = (await store.get('seq', { type: 'json' })) || 0;
      const next = Math.max(current, value);
      await store.setJSON('seq', next);

      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: next }) };
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'GET or POST only' }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
