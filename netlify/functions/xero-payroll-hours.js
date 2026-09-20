const { getValidConnection } = require('./lib/xero-auth');
const { wagesHoursStore } = require('./lib/blob-store');
const { checkKey, json, payrollGet, notAuthorised, parseXeroDate, mapWithConcurrency } = require('./lib/payroll');

// Average weekly hours per employee over the last 12 months, from posted
// payslips. Xero only exposes hours on individual payslips (no bulk report),
// so a first run means ~1 call per payslip — far more than one request can
// make (Xero allows 60 calls/min; a function has a hard time limit). So each
// invocation does a bounded slice of the work, saves what it read, and reports
// progress; the Wages tab keeps calling until nothing is left. Payslips don't
// change once posted, so after the first backfill only new pay runs are read.
const WINDOW_DAYS = 364;
const TIME_BUDGET_MS = 8000;   // stay well inside the function time limit
const MAX_PAYSLIPS_PER_CALL = 40;
const CONCURRENCY = 4;         // Xero allows 5 concurrent

const HOUR_EARNINGS_TYPES = new Set(['ORDINARYTIMEEARNINGS', 'OVERTIMEEARNINGS']);
const unitsOf = (v) => (Array.isArray(v) ? v.reduce((a, b) => a + (Number(b) || 0), 0) : Number(v) || 0);

// Hours paid on one payslip: ordinary + overtime earnings (allowances, bonuses
// and fixed amounts have "units" that aren't hours, so they're skipped by
// earnings type), plus leave taken. Leave that was cashed out isn't time off,
// so it's excluded.
function payslipHours(slip, earningsRates) {
  let h = 0;
  for (const l of [...(slip.EarningsLines || []), ...(slip.TimesheetEarningsLines || [])]) {
    const er = earningsRates.get(l.EarningsRateID);
    if (er && HOUR_EARNINGS_TYPES.has(er.EarningsType)) h += unitsOf(l.NumberOfUnits);
  }
  for (const l of slip.LeaveEarningsLines || []) {
    if (l.PayOutType !== 'CASHED_OUT') h += unitsOf(l.NumberOfUnits);
  }
  return Math.round(h * 100) / 100;
}

const weeksOf = (run) => {
  const s = parseXeroDate(run.s);
  const e = parseXeroDate(run.e);
  if (!s || !e) return 0;
  return Math.max(0, Math.round((e - s) / 86400000) + 1) / 7;
};

// Weeks with no hours are left out entirely — an employee with a gap (or who
// only started part-way through the year) shouldn't be dragged down by weeks
// they weren't working.
function computeAverages(runs, slips, windowStartMs) {
  const byEmp = {};
  for (const [runId, run] of Object.entries(runs)) {
    const paid = parseXeroDate(run.pd);
    if (!paid || paid.getTime() < windowStartMs) continue;
    const weeks = weeksOf(run);
    for (const [slipId, empId] of run.slips) {
      const rec = slips[slipId];
      if (!rec || !(rec.h > 0) || !(weeks > 0)) continue;
      const a = byEmp[empId] || (byEmp[empId] = { hours: 0, weeks: 0, periods: 0 });
      a.hours += rec.h; a.weeks += weeks; a.periods += 1;
    }
  }
  const out = {};
  for (const [empId, a] of Object.entries(byEmp)) {
    out[empId] = { avgWeeklyHours: Math.round((a.hours / a.weeks) * 100) / 100, weeksCounted: Math.round(a.weeks * 10) / 10, periods: a.periods };
  }
  return out;
}

exports.handler = async (event) => {
  const t0 = Date.now();
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - t0);
  try {
    if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });

    const keyState = checkKey(event.headers);
    if (keyState === 'not_configured') return json(503, { code: 'not_configured', error: 'WAGES_ACCESS_KEY is not set in Netlify environment variables.' });
    if (keyState !== 'ok') return json(401, { code: 'bad_key', error: 'Incorrect access key.' });

    let connection;
    try {
      connection = await getValidConnection();
    } catch (err) {
      return json(err.statusCode || 500, { code: 'xero_not_connected', error: err.message });
    }

    const now = new Date();
    const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - WINDOW_DAYS));
    const y = windowStart.getUTCFullYear(), m = windowStart.getUTCMonth() + 1, d = windowStart.getUTCDate();

    // 1. Posted pay runs paid inside the window (the list has no payslips).
    const listed = [];
    for (let page = 1; page <= 10; page++) {
      const { status, data, retryAfter } = await payrollGet(connection, 'PayRuns', { where: `PayRunStatus=="POSTED" && PaymentDate>=DateTime(${y},${m},${d})`, page: String(page) });
      if (notAuthorised(status)) return json(403, { code: 'payroll_not_authorised', error: 'Xero has not been connected with payroll access yet.' });
      if (status === 429) return json(200, { rateLimited: true, retryAfter: retryAfter || 60, done: false });
      if (status !== 200 || !data) return json(502, { code: 'xero_error', error: `Xero pay runs request failed (${status})` });
      const rows = data.PayRuns || [];
      listed.push(...rows);
      if (rows.length < 100) break;
    }

    const store = wagesHoursStore();
    const runs = (await store.get('runs', { type: 'json', consistency: 'strong' })) || {};
    const slips = (await store.get('slips', { type: 'json', consistency: 'strong' })) || {};
    let rateLimited = false;
    let retryAfter = 0;
    let calls = 1;

    // 2. Pay run details (they carry the payslip ids) for runs not yet cached.
    const newRuns = listed.filter((r) => !runs[r.PayRunID]).slice(0, 10);
    await mapWithConcurrency(newRuns, CONCURRENCY, async (r) => {
      if (timeLeft() < 1500 || rateLimited) return;
      calls++;
      const res = await payrollGet(connection, `PayRuns/${r.PayRunID}`);
      if (res.status === 429) { rateLimited = true; retryAfter = res.retryAfter; return; }
      const run = res.data && res.data.PayRuns && res.data.PayRuns[0];
      if (res.status !== 200 || !run) return;
      runs[r.PayRunID] = {
        s: run.PayRunPeriodStartDate, e: run.PayRunPeriodEndDate, pd: run.PaymentDate,
        slips: (run.Payslips || []).map((p) => [p.PayslipID, p.EmployeeID]),
      };
    });

    // 3. Payslips in the window we haven't read yet.
    const missing = [];
    for (const r of listed) {
      const run = runs[r.PayRunID];
      if (!run) continue;
      for (const [slipId] of run.slips) if (!slips[slipId]) missing.push([slipId, r.PayRunID]);
    }
    let earningsRates = null;
    let payItemsFailed = false;
    if (missing.length && !rateLimited && timeLeft() > 2500) {
      calls++;
      const res = await payrollGet(connection, 'PayItems');
      if (res.status === 429) { rateLimited = true; retryAfter = res.retryAfter; }
      else if (res.status === 200 && res.data && res.data.PayItems) {
        earningsRates = new Map((res.data.PayItems.EarningsRates || []).map((er) => [er.EarningsRateID, er]));
      } else payItemsFailed = true;
    }
    let fetched = 0;
    if (earningsRates) {
      const batch = missing.slice(0, MAX_PAYSLIPS_PER_CALL);
      await mapWithConcurrency(batch, CONCURRENCY, async ([slipId, runId]) => {
        if (timeLeft() < 800 || rateLimited) return;
        calls++;
        const res = await payrollGet(connection, `Payslip/${slipId}`);
        if (res.status === 429) { rateLimited = true; retryAfter = res.retryAfter; return; }
        const slip = res.data && res.data.Payslip;
        if (res.status !== 200 || !slip) return;
        slips[slipId] = { h: payslipHours(slip, earningsRates) };
        fetched++;
      });
    }

    if (fetched || newRuns.length) {
      await store.setJSON('runs', runs);
      await store.setJSON('slips', slips);
    }

    let total = 0, done = 0;
    for (const r of listed) {
      const run = runs[r.PayRunID];
      if (!run) continue;
      for (const [slipId] of run.slips) { total++; if (slips[slipId]) done++; }
    }
    const runsPending = listed.filter((r) => !runs[r.PayRunID]).length;
    const windowStartMs = windowStart.getTime();
    const inWindow = Object.fromEntries(listed.filter((r) => runs[r.PayRunID]).map((r) => [r.PayRunID, runs[r.PayRunID]]));

    return json(200, {
      hours: computeAverages(inWindow, slips, windowStartMs),
      progress: { total, done, runsPending, runsTotal: listed.length },
      done: !runsPending && done >= total && !payItemsFailed,
      rateLimited, retryAfter: rateLimited ? (retryAfter || 60) : 0,
      payItemsFailed,
      calls,
    });
  } catch (err) {
    return json(500, { code: 'server_error', error: err.message });
  }
};

exports._payslipHours = payslipHours;
exports._computeAverages = computeAverages;
