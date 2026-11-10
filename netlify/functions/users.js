// The Settings tab's people list. Admin only — and enforced even before AUTH_ENFORCE is switched on, because this is where passwords
// and access are handed out. Passwords and link secrets never leave the server (the list carries only a "has a password" flag).
//
//   GET                                   → { users:[…], modules:[…], me }
//   POST { action:'add', name, email, role, modules, sendLink }
//   POST { action:'update', id, name?, email?, role?, modules?, disabled? }
//   POST { action:'send-link', id }       → emails a fresh set-up link (also returned, so it can be copied if email isn't working)
//   POST { action:'set-password', id, password }
//   POST { action:'delete', id }
// Safeguards: the last working Admin can't be demoted, disabled or deleted.
const A = require('./lib/auth');

const strip = (t, n) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, n);

function listResponse(doc, me, extra) {
  const users = doc.users.slice().sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'admin' ? -1 : 1)).map(A.publicUser);
  return A.json(200, { users, modules: A.MODULES, me: me.id, ...(extra || {}) });
}
// Would this change leave nobody able to administer? (Admin = role admin, not disabled, has a password.)
function leavesNoAdmin(doc, id, after) {
  const others = doc.users.filter((u) => u.id !== id && u.role === 'admin' && !u.disabled && u.pw);
  if (others.length) return false;
  return !(after && after.role === 'admin' && !after.disabled && after.hasPw);
}

exports.handler = A.withAuth('admin', async (event) => {
  try {
    const me = event.user;
    if (event.httpMethod === 'GET') return listResponse(await A.loadDoc(true), me);
    if (event.httpMethod !== 'POST') return A.json(405, { error: 'GET or POST only' });
    let b;
    try { b = JSON.parse(event.body || '{}'); } catch (e) { return A.json(400, { error: 'Invalid JSON body' }); }
    const doc = await A.loadDoc(true);
    const find = () => doc.users.find((u) => u.id === b.id);

    if (b.action === 'add') {
      const name = strip(b.name, 80), email = A.normEmail(b.email);
      if (!name) return A.json(400, { error: 'Give them a name.' });
      if (!A.validEmail(email)) return A.json(400, { error: 'That email address does not look right.' });
      if (doc.users.some((u) => u.email === email)) return A.json(400, { error: 'Someone with that email already has a login.' });
      const user = { id: A.newUserId(), name, email, role: b.role === 'admin' ? 'admin' : 'user', modules: A.cleanModules(b.modules), disabled: false, pw: null, sv: 1, createdAt: new Date().toISOString(), createdBy: me.email };
      doc.users.push(user);
      let link = null, emailed = null, emailError = null;
      if (b.sendLink !== false) {
        const token = A.issueLink(user, A.INVITE_HOURS);
        link = A.linkFor(event, token);
        await A.saveDoc(doc);
        const r = await A.sendLinkEmail({ to: user.email, name: user.name, link, kind: 'invite', hours: A.INVITE_HOURS });
        emailed = r.ok; emailError = r.ok ? null : r.error;
      } else await A.saveDoc(doc);
      return listResponse(doc, me, { added: A.publicUser(user), link, emailed, emailError });
    }

    const user = find();
    if (!user) return A.json(404, { error: 'That person was not found.' });

    if (b.action === 'update') {
      const next = { ...user };
      if (b.name !== undefined) { next.name = strip(b.name, 80); if (!next.name) return A.json(400, { error: 'Give them a name.' }); }
      if (b.email !== undefined) {
        next.email = A.normEmail(b.email);
        if (!A.validEmail(next.email)) return A.json(400, { error: 'That email address does not look right.' });
        if (doc.users.some((u) => u.id !== user.id && u.email === next.email)) return A.json(400, { error: 'Someone with that email already has a login.' });
      }
      if (b.role !== undefined) next.role = b.role === 'admin' ? 'admin' : 'user';
      if (b.modules !== undefined) next.modules = A.cleanModules(b.modules);
      if (b.disabled !== undefined) next.disabled = !!b.disabled;
      if (leavesNoAdmin(doc, user.id, { role: next.role, disabled: next.disabled, hasPw: !!next.pw })) return A.json(400, { error: 'There has to be at least one working Admin — make someone else an Admin first.' });
      if (next.disabled && !user.disabled) next.sv = (user.sv || 1) + 1; // ends any session they have open
      if (next.email !== user.email) { next.setup = null; }
      Object.assign(user, next);
      await A.saveDoc(doc);
      return listResponse(doc, me);
    }

    if (b.action === 'send-link') {
      if (user.disabled) return A.json(400, { error: 'They are switched off — switch them back on first.' });
      const token = A.issueLink(user, A.INVITE_HOURS);
      const link = A.linkFor(event, token);
      await A.saveDoc(doc);
      const r = await A.sendLinkEmail({ to: user.email, name: user.name, link, kind: user.pw ? 'reset' : 'invite', hours: A.INVITE_HOURS });
      return listResponse(doc, me, { link, emailed: r.ok, emailError: r.ok ? null : r.error, linkFor: user.id });
    }

    if (b.action === 'set-password') {
      const problem = A.passwordProblem(b.password, user.email);
      if (problem) return A.json(400, { error: problem });
      user.pw = await A.hashPassword(b.password);
      user.setup = null;
      user.sv = (user.sv || 1) + 1; // signs them out everywhere else
      await A.saveDoc(doc);
      return listResponse(doc, me);
    }

    if (b.action === 'delete') {
      if (leavesNoAdmin(doc, user.id, null)) return A.json(400, { error: 'There has to be at least one working Admin.' });
      doc.users = doc.users.filter((u) => u.id !== user.id);
      await A.saveDoc(doc);
      return listResponse(doc, me);
    }

    return A.json(400, { error: 'Unknown action' });
  } catch (err) {
    return A.json(500, { error: err.message });
  }
}, { alwaysEnforce: true });
