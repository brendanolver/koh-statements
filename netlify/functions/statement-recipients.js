const { statementRecipientsStore } = require('./lib/blob-store');

// Keyed by customer name, uppercased+trimmed — same convention as
// hidden-customers.js. Lets Brendan set a multi-recipient email list and/or
// a greeting name (and a mobile for texts) once per customer and have it stick (server-side, so it
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

      const { customerName, email, recipientName, mobile } = body;
      const key = normName(customerName);
      if (!key) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing customerName' }) };
      }

      const map = (await store.get('recipient-map', { type: 'json' })) || {};
      // A save only changes the fields it actually sends: the email/name boxes save without a mobile, and saving a
      // mobile (from the SMS dialog) must not wipe the email/name — so anything left out keeps its saved value.
      const prev = map[key] || {};
      const pick = (sent, saved) => (sent === undefined ? (saved || '') : String(sent || '').trim());
      const entry = {
        email: pick(email, prev.email),
        recipientName: pick(recipientName, prev.recipientName),
        mobile: pick(mobile, prev.mobile),
      };
      if (entry.email || entry.recipientName || entry.mobile) {
        // keep the entry in its old shape (no mobile key) until a mobile exists
        map[key] = entry.mobile ? entry : { email: entry.email, recipientName: entry.recipientName };
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
