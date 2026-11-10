const { withAuth } = require('./lib/auth');
const { getValidConnection } = require('./lib/xero-auth');

const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';
const ALLOWED = ['Contacts', 'Invoices', 'CreditNotes', 'TaxRates', 'Accounts', 'BankTransactions', 'Reports'];

const handler = async (event) => {
  try {
    let connection;
    try {
      connection = await getValidConnection();
    } catch (err) {
      return { statusCode: err.statusCode || 500, body: JSON.stringify({ error: err.message }) };
    }

    const params = { ...(event.queryStringParameters || {}) };
    const path = params.path;
    if (!path || !ALLOWED.some((a) => path === a || path.startsWith(a + '/'))) {
      return { statusCode: 400, body: JSON.stringify({ error: 'invalid path' }) };
    }
    delete params.path;

    const qs = new URLSearchParams(params).toString();
    const url = `${XERO_API_BASE}/${path}${qs ? `?${qs}` : ''}`;

    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${connection.access_token}`,
        'Xero-tenant-id': connection.tenant_id,
        Accept: 'application/json',
      },
    });
    const text = await resp.text();
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Retry-After',
    };
    // Xero's 429 rate-limit response has an empty body — the wait time is
    // only in this header, so hand it to the client.
    const retryAfter = resp.headers.get('retry-after');
    if (retryAfter) headers['Retry-After'] = retryAfter;
    return { statusCode: resp.status, headers, body: text };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Who may read what from Xero through this proxy: Reports are for the P&L and Cashflow tabs, raw bank transactions for Cashflow /
// Drawings / Amex Import, and everything else (contacts, invoices, accounts…) for any section that works from Xero.
const XERO_SECTIONS = ['debtors', 'statements', 'bills', 'commission', 'cashflow', 'drawings', 'pnl', 'amex'];
const xeroAccess = (event) => {
  const p = String((event.queryStringParameters || {}).path || '');
  if (p === 'Reports' || p.startsWith('Reports/')) return ['pnl', 'cashflow'];
  if (p === 'BankTransactions' || p.startsWith('BankTransactions/')) return ['cashflow', 'drawings', 'amex'];
  return XERO_SECTIONS;
};

// Signed-in people only, and only with one of these sections ticked (see lib/auth.js).
exports.handler = withAuth(xeroAccess, handler);
