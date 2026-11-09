const { customerNotesStore } = require('./lib/blob-store');

// Brendan's own notes about a customer's account ("Promised payment Friday", "Customer disputing invoice", "Usually pays
// late but always pays"), kept next to the SMS history. A note may carry a payment-promise date; once that date has
// passed with the account still overdue, the SMS dialog suggests the Final wording (a suggestion only).
//
//   GET   → { "CUSTOMER NAME": [ { id, at, text, promise } … ] }          (oldest first)
//   POST  → { customerName, text, promise? }  adds a note (promise = YYYY-MM-DD, optional)
//   POST  → { customerName, deleteId }        removes one note
//
// Keyed by customer name, uppercased + trimmed — the same convention as statement-recipients.js and send-sms.js.
// The app has one shared login, so notes record when they were written but not who wrote them.

const MAX_TEXT = 300;
const MAX_NOTES = 50;
const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const normName = (name) => String(name || '').trim().toUpperCase();

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;   // rejects 2026-02-31 and the like
}

exports.handler = async (event) => {
  try {
    const store = customerNotesStore();

    if (event.httpMethod === 'GET') {
      return json(200, (await store.get('notes', { type: 'json' })) || {});
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'GET or POST only' });

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }
    const key = normName(body.customerName);
    if (!key) return json(400, { error: 'Missing customerName' });

    const map = (await store.get('notes', { type: 'json' })) || {};
    const list = map[key] || [];

    if (body.deleteId !== undefined) {
      const next = list.filter((n) => n.id !== String(body.deleteId));
      if (next.length === list.length) return json(404, { error: 'No such note' });
      if (next.length) map[key] = next; else delete map[key];
      await store.setJSON('notes', map);
      return json(200, { ok: true });
    }

    const text = String(body.text == null ? '' : body.text).trim();
    if (!text) return json(400, { error: 'The note is empty' });
    if (text.length > MAX_TEXT) return json(400, { error: `Keep the note under ${MAX_TEXT} characters` });
    const promise = body.promise ? String(body.promise) : '';
    if (promise && !validDate(promise)) return json(400, { error: 'The payment promise date is not a real date (use YYYY-MM-DD)' });
    if (list.length >= MAX_NOTES) return json(400, { error: `That customer already has ${MAX_NOTES} notes — delete an old one first` });

    const note = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: new Date().toISOString(), text, promise };
    map[key] = [...list, note];
    await store.setJSON('notes', map);
    return json(200, { ok: true, note });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
