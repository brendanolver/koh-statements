const { statementRecipientsStore } = require('./lib/blob-store');

// Keyed by customer name, uppercased+trimmed — same convention as
// hidden-customers.js. Lets Brendan set a multi-recipient email list and/or
// a greeting name once per customer and have it stick (server-side, so it
// follows him across devices) instead of resetting to Xero's single
// EmailAddress/FirstName every time the statement is reloaded.
function normName(name) {
  return String(name || '').trim().toUpperCase();
}

exports.handler = async (event) => {
  try {
    const store = statementRecipientsStore();

    if (event.httpMethod === 'GET') {
      const map = (await store.get('recipient-map', { type: 'json' })) || {};
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(map) };
    }

    if (event.httpMethod === 'POST') {
      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
      }

      const { customerName, email, recipientName } = body;
      const key = normName(customerName);
      if (!key) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing customerName' }) };
      }

      const map = (await store.get('recipient-map', { type: 'json' })) || {};
      const trimmedEmail = (email || '').trim();
      const trimmedName = (recipientName || '').trim();
      if (trimmedEmail || trimmedName) {
        map[key] = { email: trimmedEmail, recipientName: trimmedName };
      } else {
        delete map[key];
      }
      await store.setJSON('recipient-map', map);

      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'GET or POST only' }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
