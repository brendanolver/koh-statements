const crypto = require('crypto');
const { getValidConnection } = require('./lib/xero-auth');

const PAYROLL_BASE = 'https://api.xero.com/payroll.xro/1.0';
const DETAIL_CONCURRENCY = 5; // Xero allows 5 concurrent calls per org

// Wages are personal information, so unlike xero-proxy.js this endpoint is
// NOT open: every request must carry the WAGES_ACCESS_KEY (a Netlify env
// var) in the X-Wages-Key header, checked here on the server. The page's own
// password screen is client-side only and can't protect this. Only the few
// fields the Wages tab needs are ever returned — the raw Xero employee record
// (tax file number, bank accounts, address, date of birth…) never leaves this
// function.
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
    if (resp.status === 429 && attempt < 3) {
      const wait = Math.min(8, Number(resp.headers.get('retry-after')) || 4);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    return { status: resp.status, data };
  }
}

function notAuthorised(status) {
  return status === 401 || status === 403;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Works out one employee's ordinary pay from their pay template.
//  - ENTEREARNINGSRATE: hourly rate typed straight into the pay template
//  - ANNUALSALARY:      salaried — the client turns it into an hourly rate
//  - USEEARNINGSRATE:   rate lives on the earnings rate (Pay Items); only a
//                       plain rate-per-unit one can be used as an hourly rate
function resolvePay(emp, earningsRates) {
  const lines = (emp.PayTemplate && emp.PayTemplate.EarningsLines) || [];
  if (!lines.length) return { basis: null, note: 'No earnings on their pay template' };
  const line = lines.find((l) => l.EarningsRateID === emp.OrdinaryEarningsRateID) || lines[0];
  if (line.CalculationType === 'ANNUALSALARY') {
    const annualSalary = num(line.AnnualSalary);
    return annualSalary ? { basis: 'salary', annualSalary } : { basis: null, note: 'Salary not set' };
  }
  if (line.CalculationType === 'ENTEREARNINGSRATE') {
    const hourlyRate = num(line.RatePerUnit);
    return hourlyRate ? { basis: 'hourly', hourlyRate } : { basis: null, note: 'Hourly rate not set' };
  }
  if (line.CalculationType === 'USEEARNINGSRATE') {
    const er = earningsRates.get(line.EarningsRateID);
    if (er && er.RateType === 'RATEPERUNIT' && num(er.RatePerUnit)) {
      return { basis: 'hourly', hourlyRate: num(er.RatePerUnit) };
    }
    return { basis: null, note: er ? `Rate comes from earnings rate "${er.Name}" (not a fixed hourly rate)` : 'Earnings rate not found' };
  }
  return { basis: null, note: 'Unrecognised pay type' };
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

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });

    const keyState = checkKey(event.headers);
    if (keyState === 'not_configured') {
      return json(503, { code: 'not_configured', error: 'WAGES_ACCESS_KEY is not set in Netlify environment variables.' });
    }
    if (keyState !== 'ok') return json(401, { code: 'bad_key', error: 'Incorrect access key.' });

    let connection;
    try {
      connection = await getValidConnection();
    } catch (err) {
      return json(err.statusCode || 500, { code: 'xero_not_connected', error: err.message });
    }

    // 1. Active employees (the list has names + status, but no pay template).
    const active = [];
    for (let page = 1; page <= 10; page++) {
      const { status, data } = await payrollGet(connection, 'Employees', { where: 'Status=="ACTIVE"', page: String(page) });
      if (notAuthorised(status)) {
        return json(403, { code: 'payroll_not_authorised', error: 'Xero has not been connected with payroll access yet.' });
      }
      if (status !== 200 || !data) return json(502, { code: 'xero_error', error: `Xero employees request failed (${status})` });
      const rows = data.Employees || [];
      active.push(...rows);
      if (rows.length < 100) break;
    }

    // 2. Each employee's detail carries the pay template.
    const details = await mapWithConcurrency(active, DETAIL_CONCURRENCY, async (e) => {
      const { status, data } = await payrollGet(connection, `Employees/${e.EmployeeID}`);
      if (status !== 200 || !data || !data.Employees || !data.Employees[0]) return { summary: e, detail: null };
      return { summary: e, detail: data.Employees[0] };
    });

    // 3. Pay items, only needed when someone's rate lives on an earnings rate.
    const earningsRates = new Map();
    const needsPayItems = details.some(({ detail }) => detail && ((detail.PayTemplate && detail.PayTemplate.EarningsLines) || []).some((l) => l.CalculationType === 'USEEARNINGSRATE'));
    if (needsPayItems) {
      const { status, data } = await payrollGet(connection, 'PayItems');
      if (status === 200 && data && data.PayItems) {
        for (const er of data.PayItems.EarningsRates || []) earningsRates.set(er.EarningsRateID, er);
      }
    }

    const employees = details.map(({ summary, detail }) => {
      const name = [summary.FirstName, summary.LastName].filter(Boolean).join(' ').trim() || 'Unnamed';
      const base = { id: summary.EmployeeID, name };
      if (!detail) return { ...base, basis: null, note: 'Could not load pay details from Xero' };
      const emp = { ...summary, ...detail };
      return {
        ...base,
        ...resolvePay(emp, earningsRates),
        employmentBasis: (detail.TaxDeclaration && detail.TaxDeclaration.EmploymentBasis) || null,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    return json(200, { employees });
  } catch (err) {
    return json(500, { code: 'server_error', error: err.message });
  }
};

exports._resolvePay = resolvePay; // exposed for tests
