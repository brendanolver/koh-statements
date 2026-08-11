const { getStore } = require('@netlify/blobs');

// Zero-config auto-detection (reading NETLIFY_BLOBS_CONTEXT) isn't picking up
// in this deploy for reasons unclear — falls back to explicit siteID/token,
// which Netlify's docs describe as always working. SITE_ID is auto-injected
// into every function's environment; NETLIFY_AUTH_TOKEN is a Personal Access
// Token that has to be set manually (Netlify has no way to auto-inject a
// token with API-wide scope into a function for security reasons).
function namedStore(name) {
  const opts = { name };
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (siteID && token) {
    opts.siteID = siteID;
    opts.token = token;
  }
  return getStore(opts);
}

function xeroTokenStore() {
  return namedStore('xero-tokens');
}

function debtorStatusStore() {
  return namedStore('debtor-status');
}

function commissionEmailsStore() {
  return namedStore('commission-emails');
}

function billsCounterStore() {
  return namedStore('bills-counter');
}

function debtorsReportRecipientsStore() {
  return namedStore('debtors-report-recipients');
}

module.exports = { xeroTokenStore, debtorStatusStore, commissionEmailsStore, billsCounterStore, debtorsReportRecipientsStore };
