const crypto = require('crypto');

const PAYROLL_BASE = 'https://api.xero.com/payroll.xro/1.0';

// Wages are personal information, so the payroll endpoints are NOT open like
// xero-proxy.js: every request must carry the WAGES_ACCESS_KEY (a Netlify env
// var) in the X-Wages-Key header, checked here on the server. The page's own
// password screen is client-side only and can't protect this.
function checkKey(headers) {
  const expected = (process.env.WAGES_ACCESS_KEY || '').trim();
  if (!expected) return 'not_configured';
  const provided = String((headers && (headers['x-wages-key'] || headers['X-Wages-Key'])) || '');
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b) ? 'ok' : 'bad_key';
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

// One GET against the Payroll AU API. Retries a 429 (Xero's rate limit) a
// couple of times when the wait is short; a longer wait is handed back to the
// caller (status 429 + retryAfter) so it isn't burned inside a function that
// has a hard time limit.
async function payrollGet(connection, path, params) {
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  for (let attempt = 1; ; attempt++) {
    const resp = await fetch(`${PAYROLL_BASE}/${path}${qs}`, {
      headers: {
        Authorization: `Bearer ${connection.access_token}`,
        'Xero-tenant-id': connection.tenant_id,
        Accept: 'application/json',
      },
    });
    const text = await resp.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    const retryAfter = Number(resp.headers.get('retry-after')) || 0;
    if (resp.status === 429 && attempt < 3 && retryAfter > 0 && retryAfter <= 5) {
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    return { status: resp.status, data, retryAfter };
  }
}

const notAuthorised = (status) => status === 401 || status === 403;

// Payroll AU returns dates either as YYYY-MM-DD or as "/Date(ms+0000)/".
function parseXeroDate(v) {
  if (!v) return null;
  const m = /\/Date\((-?\d+)/.exec(String(v));
  const d = m ? new Date(Number(m[1])) : new Date(String(v).length === 10 ? `${v}T00:00:00Z` : v);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  }));
  return results;
}

module.exports = { PAYROLL_BASE, checkKey, json, payrollGet, notAuthorised, parseXeroDate, mapWithConcurrency };
