// Sign-in for the Finance Hub: people, passwords, sessions, and the lock each function puts on itself.
//
//  - People live in ONE blob document ("users"): name, email, role (admin / user), the sections they may use, a salted scrypt
//    password hash, and a one-time setup / reset link (only its hash is stored).
//  - A session is a signed cookie (HttpOnly, SameSite=Lax, Secure on the real site) carrying the user id and a session version.
//    Changing or resetting a password, or disabling someone, bumps that version, so their other sessions stop working.
//  - Every function wraps itself in withAuth(sections, handler): the caller must be signed in and have ticked at least one of the
//    listed sections (an Admin has them all). Until AUTH_ENFORCE=1 is set in Netlify the check only LOGS what it would refuse
//    ("[auth-monitor]"), so the switch-over can be rehearsed on the live site before anything is locked. The users function and
//    password changes are always enforced.
//
// Environment: SESSION_SECRET (32+ random characters, required), AUTH_ENFORCE ("1" to lock the functions),
// AUTH_BOOTSTRAP_EMAIL (who may create the very first Admin; defaults to Brendan's address), RESEND_API_KEY +
// STATEMENTS_FROM_EMAIL (to email setup links — the same ones the statements use).
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const { usersStore, authAttemptsStore } = require('./blob-store');

// The sections of the Finance Hub that can be ticked per person. (Settings is not one of them: it is Admin only.)
const MODULES = [
  { key: 'debtors', label: 'Debtors' },
  { key: 'statements', label: 'Statements' },
  { key: 'bills', label: 'Bills' },
  { key: 'commission', label: 'Commission' },
  { key: 'wages', label: 'Wages' },
  { key: 'cashflow', label: 'Cashflow' },
  { key: 'drawings', label: 'Drawings' },
  { key: 'pnl', label: 'P&L' },
  { key: 'amex', label: 'Amex Import' },
];
const MODULE_KEYS = MODULES.map((m) => m.key);

const COOKIE = 'kfh_session';
const LONG_SESSION_DAYS = 30;
const SHORT_SESSION_HOURS = 12;
const INVITE_HOURS = 48;
const RESET_HOURS = 1;
const MIN_PASSWORD = 10;
const DEFAULT_BOOTSTRAP_EMAIL = 'brendan@kohindustries.com';

const bootstrapEmail = () => (process.env.AUTH_BOOTSTRAP_EMAIL || DEFAULT_BOOTSTRAP_EMAIL).trim().toLowerCase();
const sessionSecret = () => { const s = (process.env.SESSION_SECRET || '').trim(); return s.length >= 32 ? s : null; };
const enforcing = () => String(process.env.AUTH_ENFORCE || '').trim() === '1';

function json(statusCode, body, headers) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(headers || {}) }, body: JSON.stringify(body) };
}
const hdr = (event, name) => {
  const h = (event && event.headers) || {};
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  return k ? String(h[k]) : '';
};
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEqualHex = (a, b) => { const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex'); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };

// ------------------------------------------------------------------ passwords
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return ['scrypt', 16384, salt.toString('base64'), key.toString('base64')].join('$');
}
async function verifyPassword(pw, stored) {
  try {
    const [alg, n, saltB, keyB] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(keyB, 'base64');
    const got = await scrypt(String(pw), Buffer.from(saltB, 'base64'), want.length, { N: Number(n), r: 8, p: 1 });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch (e) { return false; }
}
let dummyHash = null; // checked when the email is unknown, so a wrong email takes as long as a wrong password
async function burnTime(pw) { if (!dummyHash) dummyHash = await hashPassword('not-a-real-password'); await verifyPassword(pw, dummyHash); }
function passwordProblem(pw, email) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 200) return 'That password is too long.';
  if (email && pw.toLowerCase() === String(email).toLowerCase()) return "The password can't be your email address.";
  if (/^(.)\1+$/.test(pw)) return 'Choose something less repetitive.';
  return null;
}

// ------------------------------------------------------------------- sessions
function signToken(payload, key) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', key).update(body).digest('base64url')}`;
}
function verifyToken(token, key) {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const i = token.indexOf('.');
  if (i < 1) return null;
  const body = token.slice(0, i);
  const want = crypto.createHmac('sha256', key).update(body).digest();
  let got;
  try { got = Buffer.from(token.slice(i + 1), 'base64url'); } catch (e) { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!p || typeof p.exp !== 'number' || p.exp < Math.floor(Date.now() / 1000)) return null;
  return p;
}
const isLocalHost = (event) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(hdr(event, 'host'));
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}
function sessionCookie(event, user, remember) {
  const key = sessionSecret();
  const seconds = remember ? LONG_SESSION_DAYS * 86400 : SHORT_SESSION_HOURS * 3600;
  const token = signToken({ u: user.id, sv: user.sv || 1, exp: Math.floor(Date.now() / 1000) + seconds }, key);
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax;${isLocalHost(event) ? '' : ' Secure;'}${remember ? ` Max-Age=${seconds}` : ''}`.replace(/;$/, '');
}
const clearCookie = (event) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax;${isLocalHost(event) ? '' : ' Secure;'} Max-Age=0`;

// --------------------------------------------------------------------- people
const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const effectiveModules = (u) => (u.role === 'admin' ? MODULE_KEYS.slice() : (u.modules || []).filter((m) => MODULE_KEYS.includes(m)));
const cleanModules = (list) => [...new Set((Array.isArray(list) ? list : []).filter((m) => MODULE_KEYS.includes(m)))];
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, modules: effectiveModules(u), disabled: !!u.disabled, hasPassword: !!u.pw, pendingLink: !!(u.setup && u.setup.exp > Date.now()), createdAt: u.createdAt || null };
}

let cache = { at: 0, doc: null };
async function loadDoc(fresh) {
  if (!fresh && cache.doc && Date.now() - cache.at < 10000) return cache.doc;
  const doc = (await usersStore().get('users', { type: 'json', consistency: 'strong' })) || { users: [], updatedAt: null };
  if (!Array.isArray(doc.users)) doc.users = [];
  cache = { at: Date.now(), doc };
  return doc;
}
async function saveDoc(doc) {
  doc.updatedAt = new Date().toISOString();
  await usersStore().setJSON('users', doc);
  cache = { at: Date.now(), doc };
}
const resetCache = () => { cache = { at: 0, doc: null }; };
const newUserId = () => 'u_' + crypto.randomBytes(8).toString('hex');
const activeAdmins = (doc) => doc.users.filter((u) => u.role === 'admin' && !u.disabled && u.pw);

async function currentUser(event) {
  const key = sessionSecret();
  if (!key) return null;
  const token = parseCookies(hdr(event, 'cookie'))[COOKIE];
  const p = token ? verifyToken(token, key) : null;
  if (!p) return null;
  const doc = await loadDoc(false);
  const u = doc.users.find((x) => x.id === p.u);
  if (!u || u.disabled || !u.pw || (u.sv || 1) !== p.sv) return null;
  return u;
}

// One-time setup / reset links: "<userId>.<random>"; only the random part's hash is kept, and it is single use.
function issueLink(user, hours) {
  const secretPart = crypto.randomBytes(32).toString('base64url');
  user.setup = { hash: sha256(secretPart), exp: Date.now() + hours * 3600 * 1000 };
  return `${user.id}.${secretPart}`;
}
async function findByLink(token) {
  const [uid, sec] = String(token || '').split('.');
  if (!uid || !sec) return null;
  const doc = await loadDoc(true);
  const user = doc.users.find((x) => x.id === uid);
  if (!user || user.disabled || !user.setup || user.setup.exp < Date.now() || !safeEqualHex(user.setup.hash, sha256(sec))) return null;
  return { doc, user };
}
function siteUrl(event) {
  const host = hdr(event, 'x-forwarded-host') || hdr(event, 'host');
  if (host) return `${isLocalHost(event) ? 'http' : 'https'}://${host}`;
  return (process.env.URL || 'https://koh-statements.netlify.app').replace(/\/$/, '');
}
const linkFor = (event, token) => `${siteUrl(event)}/?setup=${encodeURIComponent(token)}`;

async function sendLinkEmail({ to, name, link, kind, hours }) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const from = (process.env.STATEMENTS_FROM_EMAIL || '').trim();
  if (!apiKey || !from) return { ok: false, error: 'Email is not set up (RESEND_API_KEY / STATEMENTS_FROM_EMAIL), so the link was not sent.' };
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const reset = kind === 'reset';
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1a1a1a;max-width:520px">
    <p>Hi ${esc(first)},</p>
    <p>${reset ? 'Use this link to choose a new password for the KOH Finance Hub.' : 'You have been given a login for the KOH Finance Hub. Use this link to choose your password.'}</p>
    <p style="margin:24px 0"><a href="${esc(link)}" style="background:#0f5c4a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block">${reset ? 'Choose a new password' : 'Set up my login'}</a></p>
    <p style="color:#666;font-size:13px">The link works once and expires in ${hours >= 24 ? `${Math.round(hours / 24)} days` : `${hours} hour${hours === 1 ? '' : 's'}`}. If you weren't expecting this, you can ignore it — nothing changes until the link is used.</p></div>`;
  const text = `Hi ${first},\n\n${reset ? 'Choose a new password for the KOH Finance Hub:' : 'Set up your KOH Finance Hub login:'}\n${link}\n\nThe link works once and expires in ${hours >= 24 ? `${Math.round(hours / 24)} days` : `${hours} hour${hours === 1 ? '' : 's'}`}. If you weren't expecting this, ignore it.`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], reply_to: 'brendan@kohindustries.com', subject: reset ? 'Reset your KOH Finance Hub password' : 'Set up your KOH Finance Hub login', html, text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.message || `Email failed (${res.status})` };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---------------------------------------------------------------- rate limits
const rlKey = (k) => 'rl_' + sha256(k).slice(0, 40);
async function rateCount(key, windowMs) {
  try { const rec = await authAttemptsStore().get(rlKey(key), { type: 'json' }); return rec && Date.now() - rec.first <= windowMs ? rec : { n: 0, first: Date.now() }; } catch (e) { return { n: 0, first: Date.now() }; }
}
async function rateHit(key, windowMs) {
  const rec = await rateCount(key, windowMs);
  rec.n += 1;
  try { await authAttemptsStore().setJSON(rlKey(key), rec); } catch (e) { /* counters are best effort */ }
  return rec;
}
async function rateReset(key) { try { await authAttemptsStore().delete(rlKey(key)); } catch (e) { /* ignore */ } }
const clientIp = (event) => (hdr(event, 'x-nf-client-connection-ip') || hdr(event, 'x-forwarded-for').split(',')[0] || 'unknown').trim();

// ----------------------------------------------------------- the lock on a function
function sameOrigin(event) {
  const m = String(event.httpMethod || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  const origin = hdr(event, 'origin');
  if (!origin) return true; // not a browser cross-site request (curl, server to server)
  try { return new URL(origin).host === (hdr(event, 'x-forwarded-host') || hdr(event, 'host')); } catch (e) { return false; }
}
// access: array of section keys (any one is enough), 'admin', or 'user' (just be signed in), or a function(event) returning one of those.
async function authorise(event, access) {
  if (!sessionSecret()) return { reason: 'not_configured', response: json(503, { error: 'Sign-in is not set up yet (SESSION_SECRET is missing in Netlify).', code: 'not_configured' }) };
  const user = await currentUser(event);
  if (!user) return { reason: 'not signed in', response: json(401, { error: 'Please sign in.', code: 'signin' }) };
  if (!sameOrigin(event)) return { reason: 'cross-site request', response: json(403, { error: 'Request blocked.', code: 'origin' }) };
  const need = typeof access === 'function' ? access(event) : access;
  const forbidden = () => ({ reason: `no access (${user.email})`, user, response: json(403, { error: "You don't have access to this section.", code: 'forbidden' }) });
  if (need === 'admin') return user.role === 'admin' ? { user } : forbidden();
  if (Array.isArray(need) && need.length) return need.some((m) => effectiveModules(user).includes(m)) ? { user } : forbidden();
  return { user };
}
const warned = new Set(); // one log line per kind of refusal per server instance, so monitor mode doesn't flood the logs
function withAuth(access, handler, opts) {
  const alwaysEnforce = !!(opts && opts.alwaysEnforce);
  const wrapped = async (event, context) => {
    const r = await authorise(event, access);
    if (r.response) {
      if (enforcing() || alwaysEnforce) return r.response;
      const k = `${event.httpMethod} ${event.path || ''} ${r.reason}`;
      if (!warned.has(k) && warned.size < 200) { warned.add(k); console.warn(`[auth-monitor] ${event.httpMethod} ${event.path || ''} would be refused: ${r.reason}; referer=${hdr(event, 'referer') || '-'} origin=${hdr(event, 'origin') || '-'}`); }
    } else event.user = r.user;
    return handler(event, context);
  };
  wrapped.access = access;
  wrapped.authWrapped = true;
  return wrapped;
}

module.exports = {
  MODULES, MODULE_KEYS, COOKIE, INVITE_HOURS, RESET_HOURS, MIN_PASSWORD,
  json, hdr, bootstrapEmail, sessionSecret, enforcing,
  hashPassword, verifyPassword, burnTime, passwordProblem,
  signToken, verifyToken, sessionCookie, clearCookie, parseCookies,
  normEmail, validEmail, effectiveModules, cleanModules, publicUser, newUserId, activeAdmins,
  loadDoc, saveDoc, resetCache, currentUser, issueLink, findByLink, linkFor, sendLinkEmail,
  rateCount, rateHit, rateReset, clientIp, authorise, withAuth, sha256,
};
