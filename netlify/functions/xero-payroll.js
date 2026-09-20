const { getValidConnection } = require('./lib/xero-auth');
const { checkKey, json, payrollGet, notAuthorised, mapWithConcurrency } = require('./lib/payroll');

const DETAIL_CONCURRENCY = 5; // Xero allows 5 concurrent calls per org

// Only the few fields the Wages tab needs are ever returned — the raw Xero
// employee record (tax file number, bank accounts, address, date of birth…)
// never leaves this function. Access is gated by WAGES_ACCESS_KEY (see
// lib/payroll.js).

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
