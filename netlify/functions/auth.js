// Sign in / sign out / who am I / set or reset a password from an emailed link. The only function that is open to people who are not
// signed in (it has to be); everything it does is rate limited and says the same thing whether or not an email has a login.
//
//   GET  ?action=me                       → { configured, enforced, modules, user }   (user is null when not signed in)
//   GET  ?action=check-link&token=…       → { valid, name, email }                    (the setup page greeting)
//   POST { action:'login', email, password, remember }
//   POST { action:'logout' }
//   POST { action:'request-link', email } → always { ok:true } — emails a set-up / reset link if that address has a login
//   POST { action:'set-password', token, password }   → sets the password from a link and signs the person in
//   POST { action:'change-password', current, password }   (signed in)
const A = require('./lib/auth');

const GENERIC = { ok: true, message: 'If that email address has a login, a link is on its way.' };
const FIFTEEN = 15 * 60 * 1000, HOUR = 3600 * 1000;

async function me(event) {
  const user = await A.currentUser(event);
  return A.json(200, { configured: !!A.sessionSecret(), enforced: A.enforcing(), modules: A.MODULES, user: user ? A.publicUser(user) : null });
}

async function login(event, b) {
  if (!A.sessionSecret()) return A.json(503, { error: 'Sign-in is not set up yet (SESSION_SECRET is missing in Netlify).', code: 'not_configured' });
  const email = A.normEmail(b.email), pw = typeof b.password === 'string' ? b.password : '';
  const ip = A.clientIp(event), bucket = `login:${email}:${ip}`, ipBucket = `login-ip:${ip}`;
  const [byEmail, byIp] = await Promise.all([A.rateCount(bucket, FIFTEEN), A.rateCount(ipBucket, FIFTEEN)]);
  if (byEmail.n >= 8 || byIp.n >= 40) {
    const wait = Math.max(60, Math.ceil((Math.min(byEmail.first, byIp.first) + FIFTEEN - Date.now()) / 1000));
    return A.json(429, { error: 'Too many attempts. Wait a few minutes and try again.', retryAfter: wait }, { 'Retry-After': String(wait) });
  }
  const doc = await A.loadDoc(false);
  const user = doc.users.find((u) => u.email === email && !u.disabled);
  let ok = false;
  if (user && user.pw) ok = await A.verifyPassword(pw, user.pw); else await A.burnTime(pw);
  if (!ok) {
    await Promise.all([A.rateHit(bucket, FIFTEEN), A.rateHit(ipBucket, FIFTEEN)]);
    return A.json(401, { error: 'Incorrect email or password.', code: 'bad_login' });
  }
  await A.rateReset(bucket);
  return A.json(200, { user: A.publicUser(user) }, { 'Set-Cookie': A.sessionCookie(event, user, !!b.remember) });
}

async function requestLink(event, b) {
  const email = A.normEmail(b.email);
  if (!A.validEmail(email)) return A.json(200, GENERIC);
  const ip = A.clientIp(event);
  const [byEmail, byIp] = await Promise.all([A.rateHit(`link:${email}`, HOUR), A.rateHit(`link-ip:${ip}`, HOUR)]);
  if (byEmail.n > 5 || byIp.n > 20) return A.json(200, GENERIC); // over the limit: quietly send nothing
  const doc = await A.loadDoc(true);
  let user = doc.users.find((u) => u.email === email);
  // The very first Admin — and a way back in if every Admin is ever locked out — is the bootstrap address, proven by its mailbox.
  if (email === A.bootstrapEmail() && A.activeAdmins(doc).length === 0 && (!user || user.role !== 'admin' || user.disabled || !user.pw)) {
    if (!user) {
      user = { id: A.newUserId(), name: email === 'brendan@kohindustries.com' ? 'Brendan Olver' : email.split('@')[0], email, role: 'admin', modules: [], disabled: false, pw: null, sv: 1, createdAt: new Date().toISOString(), createdBy: 'bootstrap' };
      doc.users.push(user);
    } else { user.role = 'admin'; user.disabled = false; }
  }
  if (!user || user.disabled) return A.json(200, GENERIC);
  const token = A.issueLink(user, A.RESET_HOURS);
  await A.saveDoc(doc);
  await A.sendLinkEmail({ to: user.email, name: user.name, link: A.linkFor(event, token), kind: user.pw ? 'reset' : 'invite', hours: A.RESET_HOURS });
  return A.json(200, GENERIC);
}

async function checkLink(event, token) {
  const ip = A.clientIp(event);
  const hit = await A.rateHit(`check-ip:${ip}`, FIFTEEN);
  if (hit.n > 60) return A.json(429, { error: 'Too many attempts.' });
  const found = await A.findByLink(token);
  if (!found) return A.json(200, { valid: false });
  return A.json(200, { valid: true, name: found.user.name, email: found.user.email, hasPassword: !!found.user.pw });
}

async function setPassword(event, b) {
  if (!A.sessionSecret()) return A.json(503, { error: 'Sign-in is not set up yet (SESSION_SECRET is missing in Netlify).', code: 'not_configured' });
  const ip = A.clientIp(event);
  const hit = await A.rateHit(`setpw-ip:${ip}`, FIFTEEN);
  if (hit.n > 30) return A.json(429, { error: 'Too many attempts. Wait a few minutes and try again.' });
  const found = await A.findByLink(b.token);
  if (!found) return A.json(400, { error: 'This link has expired or has already been used. Ask for a new one.', code: 'bad_link' });
  const problem = A.passwordProblem(b.password, found.user.email);
  if (problem) return A.json(400, { error: problem, code: 'weak_password' });
  const u = found.user;
  u.pw = await A.hashPassword(b.password);
  u.setup = null;
  u.sv = (u.sv || 1) + 1; // any older session of theirs stops working
  await A.saveDoc(found.doc);
  return A.json(200, { user: A.publicUser(u) }, { 'Set-Cookie': A.sessionCookie(event, u, true) });
}

async function changePassword(event, b) {
  const user = event.user;
  if (!(await A.verifyPassword(typeof b.current === 'string' ? b.current : '', user.pw))) return A.json(400, { error: 'Your current password is not right.', code: 'bad_current' });
  const problem = A.passwordProblem(b.password, user.email);
  if (problem) return A.json(400, { error: problem, code: 'weak_password' });
  const doc = await A.loadDoc(true);
  const u = doc.users.find((x) => x.id === user.id);
  u.pw = await A.hashPassword(b.password);
  u.sv = (u.sv || 1) + 1;
  await A.saveDoc(doc);
  return A.json(200, { ok: true }, { 'Set-Cookie': A.sessionCookie(event, u, true) });
}

exports.handler = async (event) => {
  try {
    const method = String(event.httpMethod || 'GET').toUpperCase();
    if (method === 'GET') {
      const q = event.queryStringParameters || {};
      if (q.action === 'check-link') return await checkLink(event, q.token);
      return await me(event);
    }
    if (method !== 'POST') return A.json(405, { error: 'GET or POST only' });
    let b;
    try { b = JSON.parse(event.body || '{}'); } catch (e) { return A.json(400, { error: 'Invalid JSON body' }); }
    if (!b || typeof b !== 'object') return A.json(400, { error: 'Invalid JSON body' });
    const origin = A.hdr(event, 'origin');
    if (origin) { let ok = false; try { ok = new URL(origin).host === (A.hdr(event, 'x-forwarded-host') || A.hdr(event, 'host')); } catch (e) { ok = false; } if (!ok) return A.json(403, { error: 'Request blocked.', code: 'origin' }); }
    switch (b.action) {
      case 'login': return await login(event, b);
      case 'logout': return A.json(200, { ok: true }, { 'Set-Cookie': A.clearCookie(event) });
      case 'request-link': return await requestLink(event, b);
      case 'set-password': return await setPassword(event, b);
      case 'change-password': return await A.withAuth('user', (ev) => changePassword(ev, b), { alwaysEnforce: true })(event);
      default: return A.json(400, { error: 'Unknown action' });
    }
  } catch (err) {
    return A.json(500, { error: err.message });
  }
};
