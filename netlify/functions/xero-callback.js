const { getStore } = require('@netlify/blobs');

const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';

function basicAuthHeader(clientId, clientSecret) {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

exports.handler = async (event) => {
  try {
    const clientId = (process.env.XERO_CLIENT_ID || '').trim();
    const clientSecret = (process.env.XERO_CLIENT_SECRET || '').trim();
    const redirectUri = (process.env.XERO_REDIRECT_URI || '').trim();

    const { code, state, error, error_description: errorDescription } = event.queryStringParameters || {};
    if (error) {
      return { statusCode: 400, body: `Xero returned an error: ${error} — ${errorDescription || ''}` };
    }
    if (!code || !state) {
      return { statusCode: 400, body: 'Missing code or state from Xero callback.' };
    }

    const store = getStore('xero-tokens');
    const pendingState = await store.get('pending-state');
    if (!pendingState || pendingState !== state) {
      return { statusCode: 400, body: 'Invalid or expired state — please try connecting again from /.netlify/functions/xero-connect.' };
    }
    await store.delete('pending-state');

    const tokenRes = await fetch(XERO_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(clientId, clientSecret),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      return { statusCode: 502, body: `Xero token exchange failed: ${tokens.error_description || tokens.error}` };
    }

    const connRes = await fetch(XERO_CONNECTIONS_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const connections = await connRes.json();
    if (!connRes.ok || !connections.length) {
      return { statusCode: 502, body: 'No Xero organisation was authorized. Please try again and select an organisation.' };
    }

    const tenantId = connections[0].tenantId;
    const expiresAt = Date.now() + tokens.expires_in * 1000;

    await store.setJSON('connection', {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
      tenant_id: tenantId,
      tenant_name: connections[0].tenantName || null,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `<p>Connected to Xero organisation: <b>${connections[0].tenantName || tenantId}</b>. You can close this tab.</p>`,
    };
  } catch (err) {
    return { statusCode: 500, body: `Xero callback failed: ${err.message}` };
  }
};
