const { getStore } = require('@netlify/blobs');

const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';
const ALLOWED = ['Contacts', 'Invoices'];
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

function basicAuthHeader(clientId, clientSecret) {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

async function refreshConnection(store, connection) {
  const clientId = (process.env.XERO_CLIENT_ID || '').trim();
  const clientSecret = (process.env.XERO_CLIENT_SECRET || '').trim();

  const res = await fetch(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(clientId, clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: connection.refresh_token }).toString(),
  });
  const tokens = await res.json();
  if (!res.ok) {
    throw new Error(tokens.error_description || tokens.error || `Xero refresh failed (${res.status})`);
  }

  const updated = {
    ...connection,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
  };
  await store.setJSON('connection', updated);
  return updated;
}

exports.handler = async (event) => {
  try {
    const store = getStore('xero-tokens');
    let connection = await store.get('connection', { type: 'json' });
    if (!connection) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Xero is not connected. Visit /.netlify/functions/xero-connect first.' }) };
    }

    if (connection.expires_at - Date.now() < REFRESH_BUFFER_MS) {
      try {
        connection = await refreshConnection(store, connection);
      } catch (err) {
        return { statusCode: 502, body: JSON.stringify({ error: `Token refresh failed: ${err.message}` }) };
      }
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
