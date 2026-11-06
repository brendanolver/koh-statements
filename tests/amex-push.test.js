// Run with:  node tests/amex-push.test.js
// The Amex Import server side: reading what Xero already holds on the card account, creating Spend/Receive
// Money entries (skipping anything already there, reporting per-line errors), and the saved merchant rules.
// Xero and the blob store are faked — nothing here touches the network.
const assert = require('assert');

const mem = {};
const storePath = require.resolve('../netlify/functions/lib/blob-store');
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: { amexRulesStore: () => ({
  get: async (k) => (mem[k] === undefined ? null : JSON.parse(mem[k])),
  setJSON: async (k, v) => { mem[k] = JSON.stringify(v); },
}) } };
const authPath = require.resolve('../netlify/functions/lib/xero-auth');
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { getValidConnection: async () => ({ access_token: 't', tenant_id: 'ten' }) } };
const push = require('../netlify/functions/xero-push');
const rules = require('../netlify/functions/amex-rules');

let n = 0;
async function test(name, f) {
  try { await f(); n++; console.log('  ok  ' + name); } catch (e) { process.exitCode = 1; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

// ── fake Xero ──
const ACCT_ID = '629e8a2e-d587-422c-9001-e0d2bf4f88c5';
let calls, stored, rejectAccountFilter, postStatus, postBodyOverride;
function reset() { calls = []; stored = []; rejectAccountFilter = false; postStatus = 200; postBodyOverride = null; }
const reply = (status, body) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body, headers: { get: () => null } });
global.fetch = async (url, opts) => {
  const u = new URL(url);
  calls.push({ path: u.pathname.replace('/api.xro/2.0', ''), search: u.searchParams, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
  if (u.pathname.endsWith('/Accounts')) {
    const code = /Code=="(.+)"/.exec(u.searchParams.get('where'))[1];
    if (code === '810') return reply(200, { Accounts: [{ AccountID: ACCT_ID, Name: 'American Express® Platinum#001', Type: 'BANK' }] });
    if (code === '400') return reply(200, { Accounts: [{ AccountID: 'x', Name: 'Advertising', Type: 'EXPENSE' }] });
    return reply(200, { Accounts: [] });
  }
  if (u.pathname.endsWith('/BankTransactions') && (!opts || !opts.method || opts.method === 'GET')) {
    const where = u.searchParams.get('where');
    if (rejectAccountFilter && where.includes('BankAccount.AccountID')) return reply(400, { Message: 'Invalid where' });
    return reply(200, { BankTransactions: stored });
  }
  if (u.pathname.endsWith('/BankTransactions') && opts.method === 'POST') {
    if (postBodyOverride) return reply(postStatus, postBodyOverride);
    const body = JSON.parse(opts.body);
    return reply(postStatus, { BankTransactions: body.BankTransactions.map((t, i) => (
      t.LineItems[0].AccountCode === 'BAD' ? { HasErrors: true, ValidationErrors: [{ Message: 'Account code \'BAD\' is not a valid code' }] } : { BankTransactionID: `bt-${i}`, HasErrors: false }
    )) });
  }
  return reply(404, {});
};
const call = async (action, params) => { const r = await push.handler({ httpMethod: 'POST', body: JSON.stringify({ action, params }) }); return { status: r.statusCode, body: JSON.parse(r.body) }; };

const item = (o) => Object.assign({ key: 'AMEX:aaaaaaaaaaaa', type: 'SPEND', date: '2026-11-03', amount: 29.5, contact: 'Woolworths', account: '850', tax: 'BAS Excluded', description: 'WOOLWORTHS 3389 FISHERMANS BN' }, o);
const xeroTxn = (o) => Object.assign({ Type: 'SPEND', Status: 'AUTHORISED', DateString: '2026-11-03T00:00:00', Total: 29.5, Reference: '', IsReconciled: false, BankAccount: { AccountID: ACCT_ID } }, o);

(async () => {
  await test('listBankTransactions: reads the card account for the date range and slims the rows', async () => {
    reset();
    stored = [xeroTxn({ Reference: 'AMEX:aaaaaaaaaaaa' }), xeroTxn({ Type: 'RECEIVE', Total: 12.3 }), xeroTxn({ Status: 'DELETED' }), xeroTxn({ Type: 'SPEND-OVERPAYMENT', Total: 5 })];
    const r = await call('listBankTransactions', { accountCode: '810', from: '2026-10-04', to: '2026-11-03' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.result.accountName, 'American Express® Platinum#001');
    assert.deepStrictEqual(r.body.result.transactions, [
      { date: '2026-11-03', type: 'SPEND', cents: 2950, reference: 'AMEX:aaaaaaaaaaaa', reconciled: false },
      { date: '2026-11-03', type: 'RECEIVE', cents: 1230, reference: '', reconciled: false },
      { date: '2026-11-03', type: 'SPEND', cents: 500, reference: '', reconciled: false },
    ]);
    const get = calls.find((c) => c.path === '/BankTransactions');
    assert.ok(get.search.get('where').includes(`BankAccount.AccountID==Guid("${ACCT_ID}")`));
    assert.ok(get.search.get('where').includes('Date>=DateTime(2026,10,4)&&Date<=DateTime(2026,11,3)'));
  });
  await test('listBankTransactions: if Xero refuses the account filter, reads the dates and filters here', async () => {
    reset(); rejectAccountFilter = true;
    stored = [xeroTxn(), xeroTxn({ BankAccount: { AccountID: 'some-other-account' }, Total: 99 })];
    const r = await call('listBankTransactions', { accountCode: '810', from: '2026-11-01', to: '2026-11-03' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.result.transactions.length, 1);
  });
  await test('listBankTransactions: refuses a non-bank account, an unknown code, or bad dates', async () => {
    reset();
    assert.ok((await call('listBankTransactions', { accountCode: '400', from: '2026-11-01', to: '2026-11-03' })).body.error.includes('not a bank'));
    assert.ok((await call('listBankTransactions', { accountCode: '999', from: '2026-11-01', to: '2026-11-03' })).body.error.includes('No account'));
    assert.ok((await call('listBankTransactions', { accountCode: '810', from: 'nope', to: '2026-11-03' })).body.error.includes('YYYY-MM-DD'));
  });

  await test('createBankTransactions: posts Spend Money on the card account, tax-inclusive, key in Reference', async () => {
    reset();
    const r = await call('createBankTransactions', { accountCode: '810', items: [item(), item({ key: 'AMEX:bbbbbbbbbbbb', type: 'RECEIVE', amount: 12.3, account: '400', tax: 'GST Free Expenses', contact: 'Some Shop' })] });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.result.results.map((x) => [x.key, x.ok, x.id]), [['AMEX:aaaaaaaaaaaa', true, 'bt-0'], ['AMEX:bbbbbbbbbbbb', true, 'bt-1']]);
    const post = calls.find((c) => c.method === 'POST');
    assert.ok(post.search.get('summarizeErrors') === 'false');
    const [a, b] = post.body.BankTransactions;
    assert.deepStrictEqual(a, { Type: 'SPEND', Contact: { Name: 'Woolworths' }, BankAccount: { AccountID: ACCT_ID }, Date: '2026-11-03', Reference: 'AMEX:aaaaaaaaaaaa', Status: 'AUTHORISED', LineAmountTypes: 'Inclusive',
      LineItems: [{ Description: 'WOOLWORTHS 3389 FISHERMANS BN', Quantity: 1, UnitAmount: 29.5, AccountCode: '850', TaxType: 'BASEXCLUDED' }] });
    assert.strictEqual(b.Type, 'RECEIVE'); assert.strictEqual(b.LineItems[0].TaxType, 'EXEMPTEXPENSES'); assert.strictEqual(b.LineItems[0].UnitAmount, 12.3);
  });
  await test('createBankTransactions: anything whose key is already on the account is skipped, not posted twice', async () => {
    reset();
    stored = [xeroTxn({ Reference: 'AMEX:aaaaaaaaaaaa' })];
    const r = await call('createBankTransactions', { accountCode: '810', items: [item(), item({ key: 'AMEX:bbbbbbbbbbbb' })] });
    const [first, second] = r.body.result.results;
    assert.deepStrictEqual([first.ok, first.skipped], [true, 'already in Xero']);
    assert.strictEqual(second.ok, true); assert.strictEqual(second.id, 'bt-0');
    assert.strictEqual(calls.find((c) => c.method === 'POST').body.BankTransactions.length, 1);
    // everything already there → no POST at all
    calls.length = 0;
    const again = await call('createBankTransactions', { accountCode: '810', items: [item()] });
    assert.strictEqual(again.body.result.results[0].skipped, 'already in Xero');
    assert.strictEqual(calls.filter((c) => c.method === 'POST').length, 0);
  });
  await test('createBankTransactions: one bad line fails on its own, the others still go through', async () => {
    reset();
    const r = await call('createBankTransactions', { accountCode: '810', items: [item(), item({ key: 'AMEX:bbbbbbbbbbbb', account: 'BAD' })] });
    const [ok, bad] = r.body.result.results;
    assert.strictEqual(ok.ok, true); assert.strictEqual(bad.ok, false); assert.ok(bad.error.includes('BAD'));
  });
  await test('createBankTransactions: invalid items are rejected before anything is sent', async () => {
    reset();
    const r = await call('createBankTransactions', { accountCode: '810', items: [item({ key: 'nope' }), item({ key: 'AMEX:cccccccccccc', tax: 'Mystery' }), item({ key: 'AMEX:dddddddddddd', amount: 0 }), item({ key: 'AMEX:eeeeeeeeeeee', type: 'TRANSFER' })] });
    assert.deepStrictEqual(r.body.result.results.map((x) => x.ok), [false, false, false, false]);
    assert.ok(r.body.result.results[1].error.includes('Mystery'));
    assert.strictEqual(calls.length, 0);
  });
  await test('createBankTransactions: a permissions failure says to reconnect Xero', async () => {
    reset(); postStatus = 403; postBodyOverride = { Title: 'Forbidden', Detail: 'AuthenticationUnsuccessful' };
    const r = await call('createBankTransactions', { accountCode: '810', items: [item()] });
    assert.strictEqual(r.status, 502); assert.ok(/Reconnect Xero/.test(r.body.error));
  });
  await test('createBankTransactions: more than 50 per call is refused', async () => {
    reset();
    const r = await call('createBankTransactions', { accountCode: '810', items: Array.from({ length: 51 }, () => item()) });
    assert.strictEqual(r.status, 502); assert.ok(r.body.error.includes('50'));
  });

  // ── saved rules ──
  const rcall = async (httpMethod, body) => { const r = await rules.handler({ httpMethod, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.statusCode, body: JSON.parse(r.body) }; };
  await test('rules: nothing saved yet → empty; saved rules come back, keys upper-cased', async () => {
    assert.deepStrictEqual((await rcall('GET')).body.rules, {});
    await rcall('POST', { rules: { woolworths: { account: '480', tax: 'GST on Expenses', contact: 'Woolworths' }, 'FACEBK': { account: '401', tax: 'GST Free Expenses' } } });
    assert.deepStrictEqual((await rcall('GET')).body.rules, { WOOLWORTHS: { account: '480', tax: 'GST on Expenses', contact: 'Woolworths' }, FACEBK: { account: '401', tax: 'GST Free Expenses' } });
  });
  await test('rules: each field is optional and kept only if valid; empty rules and extras are never stored', async () => {
    const s = rules._sanitise({ rules: { A: { account: '', tax: 'GST on Expenses' }, B: { account: '<script>' }, C: { account: '429', tax: 'Mystery' }, D: 'x', '': { account: '429' }, E: { contact: ' Woolies ' } }, evil: 1 });
    assert.deepStrictEqual(s.rules, { A: { tax: 'GST on Expenses' }, C: { account: '429' }, E: { contact: 'Woolies' } });
    assert.deepStrictEqual(Object.keys(s).sort(), ['rules', 'updatedAt']);
    assert.deepStrictEqual(rules._sanitise(null).rules, {});
  });
  await test('rules: bad bodies and methods are refused', async () => {
    assert.strictEqual((await rules.handler({ httpMethod: 'POST', body: '{nope' })).statusCode, 400);
    assert.strictEqual((await rules.handler({ httpMethod: 'POST', body: 'x'.repeat(70000) })).statusCode, 413);
    assert.strictEqual((await rules.handler({ httpMethod: 'DELETE' })).statusCode, 405);
  });

  console.log(`\n${n} passing${process.exitCode ? ' — with failures' : ''}`);
})();
