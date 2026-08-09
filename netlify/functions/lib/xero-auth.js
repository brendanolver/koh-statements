const { xeroTokenStore } = require('./blob-store');

const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
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

// Shared by every function that talks to Xero (xero-proxy.js, xero-push.js)
// so refresh/rotation logic exists in exactly one place. Throws with a
// .statusCode set — callers turn that straight into their JSON error
// response the same way xero-proxy.js already did before this was factored
// out (400 = not connected, 502 = refresh itself failed).
async function getValidConnection() {
  const store = xeroTokenStore();
  let connection = await store.get('connection', { type: 'json' });
  if (!connection) {
    const err = new Error('Xero is not connected. Visit /.netlify/functions/xero-connect first.');
    err.statusCode = 400;
    throw err;
  }
  if (connection.expires_at - Date.now() < REFRESH_BUFFER_MS) {
    try {
      connection = await refreshConnection(store, connection);
    } catch (e) {
      const err = new Error(`Token refresh failed: ${e.message}`);
      err.statusCode = 502;
      throw err;
    }
  }
  return connection;
}

module.exports = { getValidConnection, basicAuthHeader, refreshConnection };
