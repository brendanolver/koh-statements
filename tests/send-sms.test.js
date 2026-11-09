// Run with:  node tests/send-sms.test.js
// The send-sms function and the saved-mobile side of statement-recipients, with a pretend blob store and a pretend
// Kudosity (global fetch is replaced) — nothing is ever sent for real.
const assert = require('assert');
const path = require('path');

// --- pretend storage: one in-memory object per store name -------------------------------------------------------
const stores = { log: {}, recipients: {} };
const fakeStore = (bucket) => ({
  get: async (k) => (stores[bucket][k] === undefined ? null : JSON.parse(JSON.stringify(stores[bucket][k]))),
  setJSON: async (k, v) => { stores[bucket][k] = JSON.parse(JSON.stringify(v)); },
});
const blobPath = require.resolve('../netlify/functions/lib/blob-store.js');
require.cache[blobPath] = { id: blobPath, filename: blobPath, loaded: true, exports: { smsLogStore: () => fakeStore('log'), statementRecipientsStore: () => fakeStore('recipients') } };
const sendSms = require('../netlify/functions/send-sms.js').handler;
const recipients = require('../netlify/functions/statement-recipients.js').handler;

// --- pretend Kudosity ---------------------------------------------------------------------------------------------
let calls = [];
let reply = () => ({ status: 200, body: { message_id: 1234, recipients: 1, cost: 0.087, sms: 2, error: { code: 'SUCCESS', description: 'OK' } } });
global.fetch = async (url, opts) => { calls.push({ url, opts }); const r = reply(); return { status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) }; };

const post = (handler, body) => handler({ httpMethod: 'POST', body: JSON.stringify(body) });
const get = (handler) => handler({ httpMethod: 'GET' });
const ok = { customerName: 'Acme Pty Ltd', to: '0491 570 156', message: "Hi Sam, it's Brendan.", country: 'Australia' };
const reset = () => { stores.log = {}; stores.recipients = {}; calls = []; delete process.env.SMS_DAILY_LIMIT; delete process.env.KUDOSITY_SENDER; delete process.env.SMS_REPLY_EMAIL; process.env.KUDOSITY_API_KEY = 'key123'; process.env.KUDOSITY_API_SECRET = 'secret456'; reply = () => ({ status: 200, body: { message_id: 1234, recipients: 1, cost: 0.087, sms: 2, error: { code: 'SUCCESS', description: 'OK' } } }); };

let n = 0;
const test = async (name, fn) => { reset(); try { await fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };

(async () => {
  await test('a text goes to Kudosity as a Basic-auth form post, number without the +, replies forwarded to email', async () => {
    const r = await post(sendSms, ok);
    assert.strictEqual(r.statusCode, 200);
    const out = JSON.parse(r.body);
    assert.deepStrictEqual([out.ok, out.to, out.messageId, out.parts], [true, '+61 491 570 156', 1234, 2]);
    assert.strictEqual(calls.length, 1);
    const { url, opts } = calls[0];
    assert.strictEqual(url, 'https://api.transmitsms.com/send-sms.json');
    assert.strictEqual(opts.headers.Authorization, 'Basic ' + Buffer.from('key123:secret456').toString('base64'));
    assert.strictEqual(opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(opts.body);
    assert.strictEqual(form.get('to'), '61491570156');
    assert.strictEqual(form.get('message'), "Hi Sam, it's Brendan.");
    assert.strictEqual(form.get('replies_to_email'), 'brendan@kohindustries.com');
    assert.strictEqual(form.get('from'), null, 'no sender set = Kudosity default');
  });
  await test('a sender NAME (WNDRR) is passed as-is and replies are not requested, since a name cannot receive them', async () => {
    process.env.KUDOSITY_SENDER = 'WNDRR';
    await post(sendSms, ok);
    const form = new URLSearchParams(calls[0].opts.body);
    assert.strictEqual(form.get('from'), 'WNDRR');
    assert.strictEqual(form.get('replies_to_email'), null);
    assert.strictEqual(form.get('to'), '61491570156');
  });
  await test('a sender NUMBER (with or without +) is passed without the +, and replies are forwarded to the email set in Netlify', async () => {
    process.env.KUDOSITY_SENDER = '+61491570006'; process.env.SMS_REPLY_EMAIL = 'ar@example.test';
    await post(sendSms, ok);
    const form = new URLSearchParams(calls[0].opts.body);
    assert.strictEqual(form.get('from'), '61491570006');
    assert.strictEqual(form.get('replies_to_email'), 'ar@example.test');
  });
  await test('a sent text is remembered per customer and served back by GET (test texts are not shown)', async () => {
    await post(sendSms, ok);
    await post(sendSms, { to: '0491 570 157', message: 'TEST: hi', test: true });
    const log = JSON.parse((await get(sendSms)).body);
    assert.deepStrictEqual(Object.keys(log), ['ACME PTY LTD']);
    assert.strictEqual(log['ACME PTY LTD'].to, '+61491570156');
    assert.strictEqual(log['ACME PTY LTD'].count, 1);
    assert.strictEqual(log['ACME PTY LTD'].history[0].body, "Hi Sam, it's Brendan.");
    assert.strictEqual(log['ACME PTY LTD'].history[0].id, 1234);
  });
  await test('the same customer cannot be texted twice inside a minute; a different customer can', async () => {
    assert.strictEqual((await post(sendSms, ok)).statusCode, 200);
    const again = await post(sendSms, ok);
    assert.strictEqual(again.statusCode, 409);
    assert.strictEqual(calls.length, 1, 'the second one never reached Kudosity');
    assert.strictEqual((await post(sendSms, Object.assign({}, ok, { customerName: 'Other Co' }))).statusCode, 200);
    // a minute later it is fine again
    stores.log.log['ACME PTY LTD'].at = new Date(Date.now() - 61000).toISOString();
    assert.strictEqual((await post(sendSms, ok)).statusCode, 200);
    assert.strictEqual(JSON.parse((await get(sendSms)).body)['ACME PTY LTD'].count, 2);
  });
  await test('bad numbers and messages are refused before Kudosity is ever called', async () => {
    for (const [body, re] of [
      [{ ...ok, to: '03 5333 1234' }, /landline/i],
      [{ ...ok, to: 'abc' }, /valid/i],
      [{ ...ok, to: '' }, /No mobile/i],
      [{ ...ok, message: '  ' }, /empty/i],
      [{ ...ok, message: 'a'.repeat(700) }, /too long/i],
      [{ ...ok, customerName: '' }, /customerName/],
    ]) {
      const r = await post(sendSms, body);
      assert.strictEqual(r.statusCode, 400);
      assert.ok(re.test(JSON.parse(r.body).error), JSON.stringify(body).slice(0, 40) + ' → ' + r.body);
    }
    assert.strictEqual(calls.length, 0);
  });
  await test('New Zealand customers: a 02x number is a mobile', async () => {
    const r = await post(sendSms, { ...ok, customerName: 'Kiwi Ltd', to: '021 234 5678', country: 'New Zealand' });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(new URLSearchParams(calls[0].opts.body).get('to'), '64212345678');
  });
  await test('the daily limit stops sending (test texts count too), and can be raised', async () => {
    process.env.SMS_DAILY_LIMIT = '3';
    for (const c of ['A', 'B']) assert.strictEqual((await post(sendSms, { ...ok, customerName: c })).statusCode, 200);
    assert.strictEqual((await post(sendSms, { to: ok.to, message: 'TEST', test: true })).statusCode, 200);
    const blocked = await post(sendSms, { ...ok, customerName: 'C' });
    assert.strictEqual(blocked.statusCode, 429);
    assert.ok(/limit/i.test(JSON.parse(blocked.body).error));
    assert.strictEqual((await post(sendSms, { to: ok.to, message: 'TEST', test: true })).statusCode, 429, 'tests cannot dodge the limit');
    process.env.SMS_DAILY_LIMIT = '4';
    assert.strictEqual((await post(sendSms, { ...ok, customerName: 'C' })).statusCode, 200);
    assert.strictEqual(calls.length, 4);
  });
  await test('texts older than 24 hours no longer count towards the limit', async () => {
    process.env.SMS_DAILY_LIMIT = '1';
    stores.log.log = { 'OLD CO': { at: 'x', history: [{ at: new Date(Date.now() - 25 * 3600e3).toISOString() }] } };
    assert.strictEqual((await post(sendSms, ok)).statusCode, 200);
    assert.strictEqual((await post(sendSms, { ...ok, customerName: 'Another' })).statusCode, 429);
  });
  await test('without the Kudosity key and secret it says so, and sends nothing', async () => {
    delete process.env.KUDOSITY_API_SECRET;
    const r = await post(sendSms, ok);
    assert.strictEqual(r.statusCode, 503);
    const out = JSON.parse(r.body);
    assert.strictEqual(out.code, 'not_configured');
    assert.ok(/KUDOSITY_API_KEY/.test(out.error) && /KUDOSITY_API_SECRET/.test(out.error));
    assert.strictEqual(calls.length, 0);
  });
  await test('when Kudosity says no, the reason is passed on in plain words and nothing is logged', async () => {
    for (const [code, re] of [['AUTH_FAILED', /API key/], ['LEDGER_ERROR', /payment or credit/], ['RECIPIENTS_ERROR', /mobile number/], ['SOMETHING_ELSE', /SOMETHING_ELSE/]]) {
      reply = () => ({ status: 400, body: { error: { code, description: 'because' } } });
      stores.log = {};
      const r = await post(sendSms, ok);
      assert.strictEqual(r.statusCode, 502, code);
      assert.ok(re.test(JSON.parse(r.body).error), code + ' → ' + r.body);
      assert.deepStrictEqual(stores.log, {}, 'a failed text is not recorded as sent');
    }
    reply = () => ({ status: 200, body: '<html>maintenance</html>' });
    assert.strictEqual((await post(sendSms, ok)).statusCode, 502);
  });
  await test('each text records the template, customer id, request id and whether it was edited', async () => {
    await post(sendSms, { ...ok, template: 'final', customerId: 'AM-77', accountNumber: 2382, requestId: 'req-1', edited: true });
    const h = JSON.parse((await get(sendSms)).body)['ACME PTY LTD'].history[0];
    assert.deepStrictEqual(
      { template: h.template, customerId: h.customerId, accountNumber: h.accountNumber, requestId: h.requestId, edited: h.edited, status: h.status, id: h.id, body: h.body, to: h.to },
      { template: 'final', customerId: 'AM-77', accountNumber: '2382', requestId: 'req-1', edited: true, status: 'accepted', id: 1234, body: "Hi Sam, it's Brendan.", to: '+61491570156' });
    assert.ok(Date.parse(h.at) > Date.now() - 5000);
  });
  await test('texts sent without template details still work and record blanks', async () => {
    await post(sendSms, ok);
    const h = JSON.parse((await get(sendSms)).body)['ACME PTY LTD'].history[0];
    assert.deepStrictEqual([h.template, h.customerId, h.requestId, h.edited], ['', '', '', false]);
  });
  await test('an unknown template name is refused before Kudosity is called', async () => {
    const r = await post(sendSms, { ...ok, template: 'aggressive' });
    assert.strictEqual(r.statusCode, 400);
    assert.ok(/template/i.test(JSON.parse(r.body).error));
    assert.strictEqual(calls.length, 0);
    for (const t of ['friendly', 'firm', 'final']) assert.strictEqual((await post(sendSms, { ...ok, customerName: 'Co ' + t, template: t })).statusCode, 200);
  });
  await test('the same click arriving twice (same request id) sends once, records once, and answers with the first result', async () => {
    const first = await post(sendSms, { ...ok, template: 'firm', requestId: 'click-A' });
    assert.strictEqual(first.statusCode, 200);
    // even after the 60-second double-click window has passed (a slow retry), the same request id is not sent again
    stores.log.log['ACME PTY LTD'].at = new Date(Date.now() - 5 * 60000).toISOString();
    const again = await post(sendSms, { ...ok, template: 'firm', requestId: 'click-A' });
    assert.strictEqual(again.statusCode, 200);
    const out = JSON.parse(again.body);
    assert.deepStrictEqual([out.ok, out.duplicate, out.messageId], [true, true, 1234]);
    assert.strictEqual(calls.length, 1, 'Kudosity was only called once');
    const entry = JSON.parse((await get(sendSms)).body)['ACME PTY LTD'];
    assert.strictEqual(entry.history.length, 1);
    assert.strictEqual(entry.count, 1);
    // a genuinely new click (new request id, window passed) does send
    assert.strictEqual((await post(sendSms, { ...ok, requestId: 'click-B' })).statusCode, 200);
    assert.strictEqual(calls.length, 2);
  });
  await test('a failed send does not use up its request id, so the retry really sends', async () => {
    reply = () => ({ status: 400, body: { error: { code: 'RECIPIENTS_ERROR', description: 'x' } } });
    assert.strictEqual((await post(sendSms, { ...ok, requestId: 'retry-me' })).statusCode, 502);
    reply = () => ({ status: 200, body: { message_id: 55, recipients: 1, cost: 0.1, sms: 1, error: { code: 'SUCCESS', description: 'OK' } } });
    const r = await post(sendSms, { ...ok, requestId: 'retry-me' });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(JSON.parse(r.body).duplicate, undefined);
    assert.strictEqual(calls.length, 2);
  });
  await test('the history keeps the latest 20 texts per customer', async () => {
    for (let i = 0; i < 23; i++) {
      stores.log.log = stores.log.log || {};
      if (stores.log.log['ACME PTY LTD']) stores.log.log['ACME PTY LTD'].at = new Date(Date.now() - 10 * 60000).toISOString();
      process.env.SMS_DAILY_LIMIT = '1000';
      assert.strictEqual((await post(sendSms, { ...ok, message: `text ${i}`, requestId: 'r' + i })).statusCode, 200);
    }
    const entry = JSON.parse((await get(sendSms)).body)['ACME PTY LTD'];
    assert.strictEqual(entry.history.length, 20);
    assert.strictEqual(entry.history[0].body, 'text 3');
    assert.strictEqual(entry.history[19].body, 'text 22');
    assert.strictEqual(entry.count, 23, 'the running count still counts every text');
  });
  await test('only GET and POST are accepted', async () => {
    assert.strictEqual((await sendSms({ httpMethod: 'DELETE' })).statusCode, 405);
    assert.strictEqual((await sendSms({ httpMethod: 'POST', body: '{nope' })).statusCode, 400);
  });

  // --- saved mobile in statement-recipients ---------------------------------------------------------------------
  await test('a customer\'s mobile is saved next to the email and greeting name', async () => {
    await post(recipients, { customerName: 'Acme Pty Ltd', email: 'ap@acme.test', recipientName: 'Sam' });
    await post(recipients, { customerName: 'acme pty ltd ', mobile: '+61 491 570 156' });
    assert.deepStrictEqual(JSON.parse((await get(recipients)).body)['ACME PTY LTD'], { email: 'ap@acme.test', recipientName: 'Sam', mobile: '+61 491 570 156' });
  });
  await test('saving the email/name boxes does not wipe a saved mobile, and clearing both keeps the mobile', async () => {
    await post(recipients, { customerName: 'Acme', mobile: '+61 491 570 156' });
    await post(recipients, { customerName: 'Acme', email: 'new@acme.test', recipientName: 'Jo' });
    assert.deepStrictEqual(JSON.parse((await get(recipients)).body).ACME, { email: 'new@acme.test', recipientName: 'Jo', mobile: '+61 491 570 156' });
    await post(recipients, { customerName: 'Acme', email: '', recipientName: '' });
    assert.deepStrictEqual(JSON.parse((await get(recipients)).body).ACME, { email: '', recipientName: '', mobile: '+61 491 570 156' });
  });
  await test('clearing the mobile (and having nothing else saved) removes the entry; old entries keep their shape', async () => {
    await post(recipients, { customerName: 'Solo', mobile: '+61 491 570 156' });
    await post(recipients, { customerName: 'Solo', mobile: '' });
    assert.strictEqual(JSON.parse((await get(recipients)).body).SOLO, undefined);
    await post(recipients, { customerName: 'Plain', email: 'a@b.test', recipientName: 'Al' });
    assert.deepStrictEqual(JSON.parse((await get(recipients)).body).PLAIN, { email: 'a@b.test', recipientName: 'Al' }, 'no mobile key until there is one');
  });

  console.log(`\n${n} passing${process.exitCode ? ' — with failures' : ''}`);
})();
