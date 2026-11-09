const SMS = require('./lib/sms');
const { smsLogStore } = require('./lib/blob-store');

// Sends one overdue-chase text through Kudosity (formerly Transmit SMS) and remembers that it went.
//
//   GET   → the log: { "CUSTOMER NAME": { at, to, count, history:[{at,to,body,id,parts}] } }  (the page shows "Texted 9 Nov")
//   POST  → { customerName, to, message, country, test }  sends one text.
//
// Needs, in Netlify → Site configuration → Environment variables:
//   KUDOSITY_API_KEY, KUDOSITY_API_SECRET   – Kudosity → Settings → API settings (the key is shown there; the secret is one you set)
//   KUDOSITY_SENDER   (optional)            – your Kudosity virtual mobile number (e.g. 61491570156) so customers can reply
//   SMS_REPLY_EMAIL   (optional)            – where customer replies are forwarded (default brendan@kohindustries.com)
//   SMS_DAILY_LIMIT   (optional)            – the most texts this function will send in 24 hours (default 60)
//
// The daily limit is the safety net: this endpoint is not behind a login (nor are the app's other functions), and a
// text costs real money, so even a stranger who found the address could only ever send that many a day.

const KUDOSITY_URL = 'https://api.transmitsms.com/send-sms.json';
const TEST_KEY = '__TEST__';            // test texts are logged here so they count towards the daily limit too
const DOUBLE_CLICK_MS = 60 * 1000;      // the same customer can't be texted twice inside a minute
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_KEPT = 10;

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const normName = (name) => String(name || '').trim().toUpperCase();

function sentInLast24h(log, now) {
  let n = 0;
  for (const entry of Object.values(log)) for (const h of (entry && entry.history) || []) if (now - Date.parse(h.at) < DAY_MS) n++;
  return n;
}

// Kudosity's own wording is terse ("RECIPIENTS_ERROR"); say what it means for the person clicking Send.
function friendlyError(error) {
  const code = (error && error.code) || 'UNKNOWN';
  const desc = (error && error.description) || '';
  if (/AUTH/i.test(code)) return 'Kudosity rejected the API key / secret — check KUDOSITY_API_KEY and KUDOSITY_API_SECRET in Netlify.';
  if (code === 'LEDGER_ERROR') return `Kudosity says there is a payment or credit problem${desc ? ` (${desc})` : ''} — check the account balance.`;
  if (code === 'RECIPIENTS_ERROR') return 'Kudosity could not use that mobile number.';
  return `Kudosity: ${code}${desc ? ` — ${desc}` : ''}`;
}

exports.handler = async (event) => {
  try {
    const store = smsLogStore();

    if (event.httpMethod === 'GET') {
      const log = (await store.get('log', { type: 'json' })) || {};
      delete log[TEST_KEY];
      return json(200, log);
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'GET or POST only' });

    const apiKey = (process.env.KUDOSITY_API_KEY || '').trim();
    const apiSecret = (process.env.KUDOSITY_API_SECRET || '').trim();
    if (!apiKey || !apiSecret) {
      return json(503, { code: 'not_configured', error: 'Texting is not set up yet — add KUDOSITY_API_KEY and KUDOSITY_API_SECRET in the Netlify environment variables.' });
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }
    const { customerName, to, message, country, test } = body;

    const num = SMS.normaliseMobile(to, country);
    if (!num.ok) return json(400, { error: num.note });
    const check = SMS.validateMessage(message);
    if (!check.ok) return json(400, { error: check.reason });
    const text = String(message).trim();

    const key = test ? TEST_KEY : normName(customerName);
    if (!key) return json(400, { error: 'Missing customerName' });

    const log = (await store.get('log', { type: 'json' })) || {};
    const now = Date.now();
    if (!test && log[key] && log[key].at && now - Date.parse(log[key].at) < DOUBLE_CLICK_MS) {
      return json(409, { error: 'That customer was texted a moment ago — not sending it twice.' });
    }
    const limit = Number(process.env.SMS_DAILY_LIMIT) > 0 ? Number(process.env.SMS_DAILY_LIMIT) : 60;
    if (sentInLast24h(log, now) >= limit) {
      return json(429, { error: `Daily text limit reached (${limit} in 24 hours). Raise SMS_DAILY_LIMIT in Netlify if you really need more.` });
    }

    // Kudosity's standard API: a form post, API key + secret as the Basic login, the number without the "+".
    const form = new URLSearchParams({ message: text, to: num.digits });
    const sender = (process.env.KUDOSITY_SENDER || '').trim();
    if (sender) form.set('from', sender.replace(/^\+/, ''));
    form.set('replies_to_email', (process.env.SMS_REPLY_EMAIL || 'brendan@kohindustries.com').trim());

    const res = await fetch(KUDOSITY_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
    });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* not JSON — handled below */ }
    if (!data) return json(502, { error: `Kudosity sent back something unexpected (HTTP ${res.status}).` });
    if (!(data.error && data.error.code === 'SUCCESS')) {
      return json(502, { error: friendlyError(data.error) });   // 502 = the SMS service said no (not a problem with the app)
    }

    const at = new Date(now).toISOString();
    const prev = log[key] || {};
    log[key] = {
      at,
      to: num.e164,
      count: (prev.count || 0) + 1,
      history: [...(prev.history || []), { at, to: num.e164, body: text, id: data.message_id, parts: data.sms }].slice(-HISTORY_KEPT),
    };
    await store.setJSON('log', log);

    return json(200, { ok: true, to: num.display, messageId: data.message_id, parts: data.sms, cost: data.cost, at, test: !!test });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
