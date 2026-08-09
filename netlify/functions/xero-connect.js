const crypto = require('crypto');
const { xeroTokenStore } = require('./lib/blob-store');

const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
// accounting.invoices.read isn't a real Xero scope — Invoices/Bills/Credit
// Notes live under accounting.transactions. Corrected here, and upgraded to
// the non-.read variants for write access (Bills Import pushing bills and
// contacts directly instead of a manual CSV import).
// accounting.settings.read added after a live 401 on GET TaxRates —
// TaxRates/Currencies/Organisation live under settings, not transactions.
const SCOPES = 'offline_access accounting.contacts accounting.transactions accounting.settings.read';

exports.handler = async (event) => {
  try {
    const clientId = (process.env.XERO_CLIENT_ID || '').trim();
    const redirectUri = (process.env.XERO_REDIRECT_URI || '').trim();
    if (!clientId || !redirectUri) {
      return { statusCode: 500, body: 'XERO_CLIENT_ID / XERO_REDIRECT_URI not configured' };
    }

    const state = crypto.randomBytes(24).toString('hex');
    const store = xeroTokenStore();
    await store.set('pending-state', state, { metadata: { createdAt: Date.now() } });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPES,
      state,
    });

    return {
      statusCode: 302,
      headers: { Location: `${XERO_AUTHORIZE_URL}?${params.toString()}` },
      body: '',
    };
  } catch (err) {
    return { statusCode: 500, body: `Failed to start Xero connect: ${err.message}` };
  }
};
