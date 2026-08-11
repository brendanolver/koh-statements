const { debtorsReportRecipientsStore } = require('./lib/blob-store');

// One shared staff recipient list, not per-entity like commission-emails.js's
// per-agent map — just a single remembered comma-separated string so Brendan
// doesn't have to retype the same internal addresses every time.
exports.handler = async (event) => {
  try {
    const store = debtorsReportRecipientsStore();

    if (event.httpMethod === 'GET') {
      const emails = (await store.get('emails', { type: 'text' })) || '';
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emails }) };
    }

    if (event.httpMethod === 'POST') {
      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
      }
      await store.set('emails', String(body.emails || ''));
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'GET or POST only' }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
