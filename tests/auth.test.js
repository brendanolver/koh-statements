// Run with:  node tests/auth.test.js
// Sign-in for the Finance Hub: passwords, sessions, set-up links, lock-outs, the admin rules, and the lock on every function.
// Runs against an in-memory blob store and a stubbed email service — no real passwords, no real emails.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ---- in-memory blob store (patched in BEFORE lib/auth.js reads it)
const mem = { users: {}, attempts: {} };
const fakeStore = (bucket) => ({
  get: async (k) => (mem[bucket][k] === undefined ? null : JSON.parse(mem[bucket][k])),
  setJSON: async (k, v) => { mem[bucket][k] = JSON.stringify(v); },
  delete: async (k) => { delete mem[bucket][k]; },
});
const bs = require('../netlify/functions/lib/blob-store');
bs.usersStore = () => fakeStore('users');
bs.authAttemptsStore = () => fakeStore('attempts');

const A = require('../netlify/functions/lib/auth');
const authFn = require('../netlify/functions/auth');
const usersFn = require('../netlify/functions/users');

// ---- stubbed email service
let emails = [];
let emailOk = true;
global.fetch = async (url, init) => {
  assert.ok(/api\.resend\.com/.test(url), 'only the email service is called: ' + url);
  const body = JSON.parse(init.body);
  if (!emailOk) return { ok: false, status: 500, json: async () => ({ message: 'boom' }) };
  emails.push(body);
  return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
};
const linkIn = (mail) => { const m = /https?:\/\/[^"\s<]+\?setup=[^"\s<]+/.exec(mail.html); return m ? m[0].replace(/&amp;/g, '&') : null; };
const tokenIn = (mail) => decodeURIComponent(linkIn(mail).split('?setup=')[1]);

const ENV_KEYS = ['SESSION_SECRET', 'AUTH_ENFORCE', 'AUTH_BOOTSTRAP_EMAIL', 'RESEND_API_KEY', 'STATEMENTS_FROM_EMAIL'];
const SECRET = 'test-secret-test-secret-test-secret-1234';
function env(over) { for (const k of ENV_KEYS) delete process.env[k]; Object.assign(process.env, { SESSION_SECRET: SECRET, RESEND_API_KEY: 'rk', STATEMENTS_FROM_EMAIL: 'KOH <no-reply@example.test>' }, over || {}); }
function fresh(over) { mem.users = {}; mem.attempts = {}; A.resetCache(); emails = []; emailOk = true; env(over); }

let n = 0;
async function test(name, f) { try { fresh(); await f(); n++; console.log('  ok  ' + name); } catch (e) { process.exitCode = 1; console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n      ')); } }

const HOST = 'hub.test';
const ev = (method, body, o = {}) => ({ httpMethod: method, path: o.path || '/.netlify/functions/x', headers: { host: HOST, 'x-nf-client-connection-ip': o.ip || '1.2.3.4', ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers || {}) }, queryStringParameters: o.query || null, body: body === undefined ? undefined : JSON.stringify(body) });
const cookieOf = (res) => { const c = res.headers && res.headers['Set-Cookie']; return c ? c.split(';')[0] : null; };
const call = async (fn, e) => { const r = await fn(e); return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, headers: r.headers || {}, cookie: cookieOf(r) }; };
const post = (action, body, o) => call(authFn.handler, ev('POST', { action, ...body }, o));
const adminApi = (cookie, body, method) => call(usersFn.handler, ev(method || 'POST', method === 'GET' ? undefined : body, { cookie }));

// ---- helpers that set people up the way the real flow does
const BOOT = 'brendan@kohindustries.com';
async function bootstrapAdmin(password = 'a-long-admin-pass') {
  await post('request-link', { email: BOOT });
  const token = tokenIn(emails[emails.length - 1]);
  const r = await post('set-password', { token, password });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.cookie;
}
async function addUser(adminCookie, over = {}) {
  const r = await adminApi(adminCookie, { action: 'add', name: 'Sam Staff', email: 'sam@example.test', role: 'user', modules: ['debtors'], ...over });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r;
}
async function activate(addResult, password = 'staff-password-1') {
  const token = decodeURIComponent(addResult.body.link.split('?setup=')[1]);
  const r = await post('set-password', { token, password });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.cookie;
}

(async () => {
  console.log('Passwords and tokens');
  await test('a password hashes with a random salt and only the right one verifies; junk stored values never verify', async () => {
    const h1 = await A.hashPassword('correct horse battery'), h2 = await A.hashPassword('correct horse battery');
    assert.notStrictEqual(h1, h2, 'a fresh salt each time');
    assert.ok(/^scrypt\$16384\$/.test(h1) && !h1.includes('correct horse'));
    assert.ok(await A.verifyPassword('correct horse battery', h1));
    assert.ok(!(await A.verifyPassword('correct horse batterz', h1)));
    for (const bad of [null, '', 'plain', 'scrypt$1$$', 'md5$a$b$c']) assert.ok(!(await A.verifyPassword('x', bad)));
  });
  await test('password rules: 10+ characters, not the email, not one repeated character', async () => {
    assert.ok(A.passwordProblem('short', 'a@b.co'));
    assert.ok(A.passwordProblem('Sam@Example.test', 'sam@example.test'));
    assert.ok(A.passwordProblem('aaaaaaaaaaaa', 'a@b.co'));
    assert.strictEqual(A.passwordProblem('a-fine-passphrase', 'a@b.co'), null);
  });
  await test('session tokens: signed, tamper-proof, expire, and fail under another secret', async () => {
    const t = A.signToken({ u: 'u1', sv: 1, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    assert.strictEqual(A.verifyToken(t, SECRET).u, 'u1');
    assert.strictEqual(A.verifyToken(t, SECRET + 'x'), null);
    const [body, mac] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'u2', sv: 1, exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url') + '.' + mac;
    assert.strictEqual(A.verifyToken(forged, SECRET), null, 'a changed body does not verify');
    assert.strictEqual(A.verifyToken(A.signToken({ u: 'u1', exp: 1 }, SECRET), SECRET), null, 'expired');
    for (const bad of [undefined, '', 'abc', 'a.b', 'x'.repeat(3000)]) assert.strictEqual(A.verifyToken(bad, SECRET), null);
  });
  await test('the session cookie is HttpOnly + SameSite=Lax, Secure on the real site (not on localhost), and only persistent when "remember" is ticked', async () => {
    const u = { id: 'u1', sv: 1 };
    const real = A.sessionCookie({ headers: { host: HOST } }, u, true), short = A.sessionCookie({ headers: { host: HOST } }, u, false), local = A.sessionCookie({ headers: { host: 'localhost:8888' } }, u, true);
    assert.ok(/HttpOnly/.test(real) && /SameSite=Lax/.test(real) && /Secure/.test(real) && /Max-Age=2592000/.test(real), real);
    assert.ok(!/Max-Age/.test(short) && /Secure/.test(short), short);
    assert.ok(!/Secure/.test(local) && /HttpOnly/.test(local), local);
    assert.ok(/Max-Age=0/.test(A.clearCookie({ headers: { host: HOST } })));
  });

  console.log('First Admin and set-up links');
  await test('only the bootstrap address can start the very first Admin; anyone else gets the same reply and nothing is created or sent', async () => {
    const a = await post('request-link', { email: 'stranger@example.test' });
    const b = await post('request-link', { email: BOOT });
    assert.deepStrictEqual(a.body, b.body, 'same reply either way');
    assert.strictEqual(emails.length, 1);
    assert.strictEqual(emails[0].to[0], BOOT);
    const doc = await A.loadDoc(true);
    assert.deepStrictEqual(doc.users.map((u) => [u.email, u.role]), [[BOOT, 'admin']]);
    assert.ok(/chooses?|set up|password/i.test(emails[0].html));
  });
  await test('the link works once: it sets the password, signs the person in, and a second use is refused', async () => {
    await post('request-link', { email: BOOT });
    const token = tokenIn(emails[0]);
    const v = await call(authFn.handler, ev('GET', undefined, { query: { action: 'check-link', token } }));
    assert.deepStrictEqual([v.body.valid, v.body.email], [true, BOOT]);
    const weak = await post('set-password', { token, password: 'short' });
    assert.strictEqual(weak.status, 400);
    const ok = await post('set-password', { token, password: 'a-long-admin-pass' });
    assert.strictEqual(ok.status, 200); assert.ok(ok.cookie);
    const me = await call(authFn.handler, ev('GET', undefined, { cookie: ok.cookie }));
    assert.strictEqual(me.body.user.email, BOOT);
    const again = await post('set-password', { token, password: 'another-long-pass' });
    assert.strictEqual(again.status, 400);
    const stale = await call(authFn.handler, ev('GET', undefined, { query: { action: 'check-link', token } }));
    assert.strictEqual(stale.body.valid, false);
  });
  await test('an expired or forged link is refused; the secret half is stored only as a hash', async () => {
    await post('request-link', { email: BOOT });
    const token = tokenIn(emails[0]);
    const doc = await A.loadDoc(true);
    assert.ok(!JSON.stringify(doc).includes(token.split('.')[1]), 'the link secret is not stored');
    doc.users[0].setup.exp = Date.now() - 1000; await A.saveDoc(doc);
    assert.strictEqual((await post('set-password', { token, password: 'a-long-admin-pass' })).status, 400);
    assert.strictEqual((await post('set-password', { token: token.split('.')[0] + '.forged', password: 'a-long-admin-pass' })).status, 400);
    assert.strictEqual((await post('set-password', { token: 'nonsense', password: 'a-long-admin-pass' })).status, 400);
  });
  await test('the bootstrap address is also the way back in if every Admin is ever switched off or lost', async () => {
    await bootstrapAdmin();
    const doc = await A.loadDoc(true); doc.users[0].disabled = true; await A.saveDoc(doc);
    emails = [];
    await post('request-link', { email: BOOT });
    assert.strictEqual(emails.length, 1, 'a link is sent');
    const r = await post('set-password', { token: tokenIn(emails[0]), password: 'a-new-admin-pass' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await A.loadDoc(true)).users[0].disabled, false);
  });
  await test('requests for links are rate limited quietly (same reply, nothing sent after the limit)', async () => {
    await bootstrapAdmin(); emails = [];
    for (let i = 0; i < 9; i++) await post('request-link', { email: BOOT });
    assert.strictEqual(emails.length, 4, 'five an hour per address in all (one was used by the first set-up above)');
  });

  console.log('Signing in and out');
  await test('login: right password signs in; wrong password and unknown email give the same answer; email is not case sensitive', async () => {
    await bootstrapAdmin('a-long-admin-pass');
    const ok = await post('login', { email: BOOT.toUpperCase(), password: 'a-long-admin-pass', remember: true });
    assert.strictEqual(ok.status, 200); assert.ok(ok.cookie && /Max-Age/.test(ok.headers['Set-Cookie']));
    assert.strictEqual(ok.body.user.role, 'admin'); assert.ok(!JSON.stringify(ok.body).includes('scrypt'));
    const wrong = await post('login', { email: BOOT, password: 'not-the-password' });
    const unknown = await post('login', { email: 'nobody@example.test', password: 'whatever-whatever' });
    assert.deepStrictEqual([wrong.status, unknown.status], [401, 401]);
    assert.deepStrictEqual(wrong.body, unknown.body, 'no hint which part was wrong');
    assert.ok(!wrong.cookie);
  });
  await test('eight wrong passwords lock that email on that connection for a while; a good one resets the count', async () => {
    await bootstrapAdmin('a-long-admin-pass');
    for (let i = 0; i < 7; i++) assert.strictEqual((await post('login', { email: BOOT, password: 'bad-bad-bad-1' })).status, 401);
    assert.strictEqual((await post('login', { email: BOOT, password: 'a-long-admin-pass' })).status, 200, 'seven misses then the right one still works');
    for (let i = 0; i < 8; i++) await post('login', { email: BOOT, password: 'bad-bad-bad-1' });
    const locked = await post('login', { email: BOOT, password: 'a-long-admin-pass' });
    assert.strictEqual(locked.status, 429); assert.ok(Number(locked.headers['Retry-After']) >= 60);
    assert.strictEqual((await post('login', { email: BOOT, password: 'a-long-admin-pass' }, { ip: '9.9.9.9' })).status, 200, 'a different connection is not locked');
  });
  await test('who-am-I: nobody signed in gets user null plus the setup facts; logout clears the cookie', async () => {
    const anon = await call(authFn.handler, ev('GET'));
    assert.deepStrictEqual([anon.body.user, anon.body.configured, anon.body.enforced], [null, true, false]);
    assert.strictEqual(anon.body.modules.length, 9);
    const cookie = await bootstrapAdmin();
    assert.strictEqual((await call(authFn.handler, ev('GET', undefined, { cookie }))).body.user.email, BOOT);
    const out = await post('logout', {});
    assert.ok(/Max-Age=0/.test(out.headers['Set-Cookie']));
    env({ AUTH_ENFORCE: '1', SESSION_SECRET: '' });
    assert.strictEqual((await call(authFn.handler, ev('GET'))).body.configured, false);
  });
  await test('login and set-up are refused while SESSION_SECRET is missing (a clear message, not a crash)', async () => {
    env({ SESSION_SECRET: '' });
    const r = await post('login', { email: BOOT, password: 'x' });
    assert.deepStrictEqual([r.status, r.body.code], [503, 'not_configured']);
  });
  await test('a form posted from another website is refused (origin check)', async () => {
    const r = await call(authFn.handler, ev('POST', { action: 'login', email: BOOT, password: 'x' }, { headers: { origin: 'https://evil.example' } }));
    assert.strictEqual(r.status, 403);
    const ok = await call(authFn.handler, ev('POST', { action: 'login', email: BOOT, password: 'x' }, { headers: { origin: 'https://' + HOST } }));
    assert.strictEqual(ok.status, 401, 'same-site origin is let through to the normal check');
  });
  await test('changing your own password needs the current one, signs out older sessions, and keeps you in', async () => {
    const old = await bootstrapAdmin('a-long-admin-pass');
    assert.strictEqual((await post('change-password', { current: 'wrong-wrong-1', password: 'brand-new-password' }, { cookie: old })).status, 400);
    assert.strictEqual((await post('change-password', { current: 'a-long-admin-pass', password: 'tiny' }, { cookie: old })).status, 400);
    assert.strictEqual((await post('change-password', { password: 'brand-new-password', current: 'a-long-admin-pass' })).status, 401, 'signed-out callers cannot');
    const r = await post('change-password', { current: 'a-long-admin-pass', password: 'brand-new-password' }, { cookie: old });
    assert.strictEqual(r.status, 200); assert.ok(r.cookie);
    assert.strictEqual((await call(authFn.handler, ev('GET', undefined, { cookie: old }))).body.user, null, 'the old session is finished');
    assert.strictEqual((await call(authFn.handler, ev('GET', undefined, { cookie: r.cookie }))).body.user.email, BOOT);
    assert.strictEqual((await post('login', { email: BOOT, password: 'brand-new-password' })).status, 200);
  });

  console.log('The Settings people list (admin only)');
  await test('only an Admin gets in — even before the switch-over — and nothing secret comes back', async () => {
    const admin = await bootstrapAdmin();
    const r = await addUser(admin);
    assert.strictEqual((await adminApi(null, null, 'GET')).status, 401);
    const staff = await activate(r);
    assert.strictEqual((await adminApi(staff, null, 'GET')).status, 403, 'a normal user is turned away');
    const list = await adminApi(admin, null, 'GET');
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(list.body.users.map((u) => u.email).sort(), [BOOT, 'sam@example.test']);
    const raw = JSON.stringify(list.body);
    assert.ok(!/scrypt|setup|hash|"pw"/.test(raw), 'no password or link material in the list');
    assert.strictEqual(list.body.modules.length, 9);
  });
  await test('adding someone: checks the name and email, rejects a duplicate, tidies the sections, and emails a set-up link (also returned for copying)', async () => {
    const admin = await bootstrapAdmin(); emails = [];
    assert.strictEqual((await adminApi(admin, { action: 'add', name: '', email: 'a@b.co' })).status, 400);
    assert.strictEqual((await adminApi(admin, { action: 'add', name: 'X', email: 'not-an-email' })).status, 400);
    const r = await addUser(admin, { modules: ['debtors', 'cashflow', 'nonsense', 'debtors'] });
    assert.deepStrictEqual(r.body.added.modules, ['debtors', 'cashflow']);
    assert.strictEqual(r.body.emailed, true); assert.ok(/\?setup=/.test(r.body.link));
    assert.strictEqual(emails.length, 1); assert.strictEqual(emails[0].to[0], 'sam@example.test');
    assert.strictEqual((await adminApi(admin, { action: 'add', name: 'Sam Two', email: 'SAM@example.test' })).status, 400, 'same email, any case');
    assert.deepStrictEqual([r.body.added.hasPassword, r.body.added.pendingLink], [false, true]);
  });
  await test('if the email can\'t be sent the admin is told, and still gets the link to pass on', async () => {
    const admin = await bootstrapAdmin(); emailOk = false;
    const r = await addUser(admin);
    assert.strictEqual(r.body.emailed, false); assert.ok(r.body.emailError); assert.ok(/\?setup=/.test(r.body.link));
    env({ RESEND_API_KEY: '', STATEMENTS_FROM_EMAIL: '' });
    const r2 = await adminApi(admin, { action: 'send-link', id: r.body.added.id });
    assert.strictEqual(r2.body.emailed, false); assert.ok(/not set up/.test(r2.body.emailError));
  });
  await test('ticking sections changes access straight away; an Admin has every section whatever is ticked', async () => {
    const admin = await bootstrapAdmin();
    const r = await addUser(admin, { modules: ['debtors'] });
    const staff = await activate(r);
    const me = async () => (await call(authFn.handler, ev('GET', undefined, { cookie: staff }))).body.user;
    assert.deepStrictEqual((await me()).modules, ['debtors']);
    await adminApi(admin, { action: 'update', id: r.body.added.id, modules: ['debtors', 'pnl'] });
    A.resetCache();
    assert.deepStrictEqual((await me()).modules, ['debtors', 'pnl']);
    await adminApi(admin, { action: 'update', id: r.body.added.id, role: 'admin' });
    A.resetCache();
    assert.strictEqual((await me()).modules.length, 9);
  });
  await test('switching someone off ends their open session at once and stops them signing in; switching on restores them', async () => {
    const admin = await bootstrapAdmin();
    const r = await addUser(admin); const staff = await activate(r);
    const id = r.body.added.id;
    await adminApi(admin, { action: 'update', id, disabled: true }); A.resetCache();
    assert.strictEqual((await call(authFn.handler, ev('GET', undefined, { cookie: staff }))).body.user, null);
    assert.strictEqual((await post('login', { email: 'sam@example.test', password: 'staff-password-1' })).status, 401);
    await adminApi(admin, { action: 'update', id, disabled: false }); A.resetCache();
    assert.strictEqual((await post('login', { email: 'sam@example.test', password: 'staff-password-1' })).status, 200);
  });
  await test('the last working Admin can\'t be demoted, switched off or deleted — but can once another Admin exists', async () => {
    const admin = await bootstrapAdmin();
    const me = (await A.loadDoc(true)).users[0].id;
    for (const body of [{ action: 'update', id: me, role: 'user' }, { action: 'update', id: me, disabled: true }, { action: 'delete', id: me }]) assert.strictEqual((await adminApi(admin, body)).status, 400);
    const r = await addUser(admin, { role: 'admin', email: 'second@example.test' });
    const second = await activate(r);
    assert.strictEqual((await adminApi(admin, { action: 'update', id: me, role: 'user' })).status, 200);
    assert.strictEqual((await adminApi(second, { action: 'update', id: r.body.added.id, role: 'user' })).status, 400, 'now the second one is the last');
    assert.strictEqual((await adminApi(second, { action: 'delete', id: me })).status, 200);
  });
  await test('a fresh set-up link replaces the old one; an Admin can set a password directly (and that signs the person out elsewhere)', async () => {
    const admin = await bootstrapAdmin();
    const r = await addUser(admin); const id = r.body.added.id;
    const first = decodeURIComponent(r.body.link.split('?setup=')[1]);
    const again = await adminApi(admin, { action: 'send-link', id });
    assert.strictEqual((await post('set-password', { token: first, password: 'staff-password-1' })).status, 400, 'the earlier link no longer works');
    const staff = await activate({ body: { link: again.body.link } }, 'staff-password-1');
    assert.strictEqual((await adminApi(admin, { action: 'set-password', id, password: 'short' })).status, 400);
    assert.strictEqual((await adminApi(admin, { action: 'set-password', id, password: 'set-by-the-boss-1' })).status, 200); A.resetCache();
    assert.strictEqual((await call(authFn.handler, ev('GET', undefined, { cookie: staff }))).body.user, null, 'old session ended');
    assert.strictEqual((await post('login', { email: 'sam@example.test', password: 'set-by-the-boss-1' })).status, 200);
  });
  await test('changing someone\'s email checks it, and a person can be removed', async () => {
    const admin = await bootstrapAdmin(); const r = await addUser(admin); const id = r.body.added.id;
    assert.strictEqual((await adminApi(admin, { action: 'update', id, email: 'bad' })).status, 400);
    assert.strictEqual((await adminApi(admin, { action: 'update', id, email: BOOT })).status, 400, 'taken');
    const u = await adminApi(admin, { action: 'update', id, email: 'sam.new@example.test', name: 'Samuel' });
    assert.ok(u.body.users.some((x) => x.email === 'sam.new@example.test' && x.name === 'Samuel'));
    const d = await adminApi(admin, { action: 'delete', id });
    assert.ok(!d.body.users.some((x) => x.id === id));
    assert.strictEqual((await adminApi(admin, { action: 'update', id: 'nope', name: 'x' })).status, 404);
  });

  console.log('The lock on every function');
  const FN_DIR = path.join(__dirname, '..', 'netlify', 'functions');
  const OPEN_ON_PURPOSE = { 'auth.js': 'sign-in itself', 'debtors-feed.js': 'the WMS feed, protected by its own key', 'xero-callback.js': "Xero's OAuth redirect (checks its own one-time state)" };
  const wrapped = (f) => { delete require.cache[require.resolve(path.join(FN_DIR, f))]; return require(path.join(FN_DIR, f)).handler; };
  await test('every function is locked except the three that must be open — so a new function can\'t be added unlocked by accident', async () => {
    const files = fs.readdirSync(FN_DIR).filter((f) => f.endsWith('.js'));
    const open = files.filter((f) => !wrapped(f).authWrapped);
    assert.deepStrictEqual(open.sort(), Object.keys(OPEN_ON_PURPOSE).sort());
    for (const f of files.filter((x) => !OPEN_ON_PURPOSE[x])) {
      const a = wrapped(f).access;
      assert.ok(typeof a === 'function' || a === 'admin' || (Array.isArray(a) && a.length && a.every((m) => A.MODULE_KEYS.includes(m))), `${f} names real sections: ${JSON.stringify(a)}`);
    }
  });
  await test('each function is tied to the right sections (wages only for Wages, Xero connect only for Admin, and so on)', async () => {
    const acc = (f) => wrapped(f + '.js').access;
    assert.deepStrictEqual(acc('xero-payroll'), ['wages']); assert.deepStrictEqual(acc('xero-payroll-hours'), ['wages']);
    assert.strictEqual(acc('xero-connect'), 'admin'); assert.strictEqual(acc('users'), 'admin');
    assert.deepStrictEqual(acc('cashflow-inputs'), ['cashflow']); assert.deepStrictEqual(acc('pnl-settings'), ['pnl']); assert.deepStrictEqual(acc('amex-rules'), ['amex']);
    assert.deepStrictEqual(acc('bills-counter'), ['bills']); assert.deepStrictEqual(acc('send-commission-report'), ['commission']);
    assert.ok(acc('send-statement').includes('statements') && !acc('send-statement').includes('wages'));
    assert.ok(acc('xero-push').includes('bills') && acc('xero-push').includes('amex') && !acc('xero-push').includes('debtors'));
  });
  await test('the Xero proxy: reports only for P&L / Cashflow, raw bank transactions only for Cashflow / Drawings / Amex, the rest for any Xero section', async () => {
    const a = wrapped('xero-proxy.js').access;
    const q = (p) => a({ queryStringParameters: { path: p } });
    assert.deepStrictEqual(q('Reports/ProfitAndLoss'), ['pnl', 'cashflow']); assert.deepStrictEqual(q('Reports'), ['pnl', 'cashflow']);
    assert.deepStrictEqual(q('BankTransactions'), ['cashflow', 'drawings', 'amex']);
    assert.ok(q('Invoices').includes('debtors') && !q('Invoices').includes('wages')); assert.ok(q('Contacts').includes('bills'));
    assert.ok(q(undefined).every((m) => A.MODULE_KEYS.includes(m)));
  });
  await test('with the lock on: signed-out gets 401, a person without the section gets 403, with it gets through; Admin gets through everywhere', async () => {
    const admin = await bootstrapAdmin();
    const r = await addUser(admin, { modules: ['debtors'] }); const staff = await activate(r);
    env({ AUTH_ENFORCE: '1' }); A.resetCache();
    let ran = 0;
    const locked = (access) => A.withAuth(access, async () => { ran++; return { statusCode: 200, body: '{}' }; });
    const hit = async (fn, cookie, o) => (await fn(ev('GET', undefined, { cookie, ...(o || {}) }))).statusCode;
    assert.strictEqual(await hit(locked(['debtors']), null), 401);
    assert.strictEqual(await hit(locked(['debtors']), staff), 200);
    assert.strictEqual(await hit(locked(['wages']), staff), 403);
    assert.strictEqual(await hit(locked(['wages', 'debtors']), staff), 200, 'any one of the listed sections is enough');
    assert.strictEqual(await hit(locked('admin'), staff), 403);
    for (const a of [['wages'], ['pnl', 'amex'], 'admin', 'user']) assert.strictEqual(await hit(locked(a), admin), 200);
    assert.strictEqual(ran, 2 + 4, 'ran for the two allowed signed-in calls and the four admin calls');
    assert.strictEqual(await hit(locked(() => ['cashflow']), staff), 403, 'access may be worked out per request');
  });
  await test('the lock also refuses a cross-site POST from a signed-in browser', async () => {
    const admin = await bootstrapAdmin(); env({ AUTH_ENFORCE: '1' });
    const f = A.withAuth('user', async () => ({ statusCode: 200, body: '{}' }));
    const r = await f(ev('POST', {}, { cookie: admin, headers: { origin: 'https://evil.example' } }));
    assert.strictEqual(r.statusCode, 403);
    assert.strictEqual((await f(ev('POST', {}, { cookie: admin, headers: { origin: 'https://' + HOST } }))).statusCode, 200);
    assert.strictEqual((await f(ev('POST', {}, { cookie: admin }))).statusCode, 200, 'no Origin header (not a browser form) is fine once signed in');
  });
  await test('before the switch-over (AUTH_ENFORCE not set) nothing is refused — the call is only logged — but users.js is already strict', async () => {
    const f = A.withAuth(['debtors'], async () => ({ statusCode: 200, body: '{"ran":true}' }));
    const orig = console.warn; const logs = []; console.warn = (m) => logs.push(m);
    try {
      assert.strictEqual((await f(ev('GET', undefined, { path: '/.netlify/functions/send-sms' }))).statusCode, 200);
      assert.strictEqual((await f(ev('GET', undefined, { path: '/.netlify/functions/send-sms' }))).statusCode, 200);
    } finally { console.warn = orig; }
    assert.strictEqual(logs.length, 1, 'one log line per kind of refusal'); assert.ok(/auth-monitor/.test(logs[0]) && /send-sms/.test(logs[0]));
    assert.strictEqual((await call(usersFn.handler, ev('GET'))).status, 401, 'people list is closed even in monitor mode');
    env({ SESSION_SECRET: '' });
    assert.strictEqual((await call(usersFn.handler, ev('GET'))).status, 503);
    assert.strictEqual((await f(ev('GET'))).statusCode, 200, 'with no secret set yet the live app keeps working');
  });
  await test('the debtors feed for the WMS still uses its own key and ignores sign-in', async () => {
    const feed = require(path.join(FN_DIR, 'debtors-feed.js'));
    env({ AUTH_ENFORCE: '1' }); delete process.env.DEBTORS_FEED_KEY;
    const r = await feed.handler(ev('GET'));
    assert.strictEqual(r.statusCode, 503, 'answers from its own checks (key not configured), not 401 from sign-in');
  });

  console.log('The page matches the sections');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  await test('the tabs in the page are exactly the ticks in Settings (plus the Admin-only Settings tab) — add a tab without a tick and this fails', async () => {
    const tabs = [...html.matchAll(/<button class="tab-btn" data-tab="(\w+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(tabs.filter((t) => t !== 'settings'), A.MODULE_KEYS);
    assert.strictEqual(tabs[tabs.length - 1], 'settings');
    const appTabs = /const APP_TABS = \[([^\]]*)\]/.exec(html)[1].replace(/['\s]/g, '').split(',');
    assert.deepStrictEqual(appTabs, A.MODULE_KEYS, "the page's own list of sections");
    for (const t of A.MODULE_KEYS) assert.ok(new RegExp(`id="${{ pnl: 'pnl', amex: 'amex' }[t] || t}View"`).test(html), `a view for ${t}`);
  });
  await test('the page never loads a section\'s data for someone without it: init() asks can() first and switchTab refuses closed sections', async () => {
    const init = html.slice(html.indexOf('async function init() {'), html.indexOf('async function init() {') + 2500);
    for (const m of ['debtors', 'statements', 'commission']) assert.ok(init.includes(`can('${m}')`), `init checks ${m}`);
    assert.ok(/function switchTab\(tab\) \{\s*\n\s*if \(tab === 'settings' \? !isAdmin\(\) : !can\(tab\)\) return;/.test(html), 'switchTab guard');
    assert.ok(html.includes("btn.style.display = (t === 'settings' ? isAdmin() : can(t)) ? '' : 'none';"), 'tab buttons are hidden');
  });

  console.log(`\n${n} passing${process.exitCode ? ' — with failures' : ''}`);
})();
