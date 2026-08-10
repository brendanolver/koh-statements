const { getValidConnection } = require('./lib/xero-auth');

const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';
const ALLOWED = ['Contacts', 'Invoices', 'CreditNotes', 'TaxRates', 'Accounts'];

exports.handler = async (event) => {
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
    return {
      statusCode: resp.status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: text,
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
