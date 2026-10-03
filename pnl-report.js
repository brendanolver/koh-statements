/* Profit & Loss — pure helpers, no DOM, no network.
 *
 * Reads Xero's Reports/ProfitAndLoss JSON (Reports[0].Rows: a Header row, then Sections — Income,
 * Less Cost of Sales, Less Operating Expenses… each with Row lines and a SummaryRow — plus untitled
 * Sections holding the Gross Profit / Net Profit lines) into a simple shape the P&L tab draws, and
 * works out the by-month request Xero needs (periods + timeframe).
 *
 * Loaded by index.html as a plain script (window.PNL) and by tests/pnl-report.test.js.
 */
(function (root) {
  'use strict';
  const pad = (n) => String(n).padStart(2, '0');
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const monthKey = (iso) => iso.slice(0, 7);
  const addMonths = (mk, n) => { const [y, m] = mk.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
  const lastDay = (mk) => { const [y, m] = mk.split('-').map(Number); return `${mk}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
  const r2 = (n) => Math.round(n * 100) / 100;
  const num = (v) => { const n = parseFloat(String(v === undefined || v === null ? '' : v).replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

  // "30 Sep 2026", "Sep 2026", "1 September 2026" -> '2026-09'. (Day-of-month is ignored.)
  function monthOfLabel(label) {
    const m = /([A-Za-z]{3,9})\.?\s+(\d{4})/.exec(String(label || ''));
    if (!m) return null;
    const i = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    return i < 0 ? null : `${m[2]}-${pad(i + 1)}`;
  }

  function parseSection(row) {
    const sec = { title: String(row.Title || '').trim(), rows: [], summary: null };
    for (const r of row.Rows || []) {
      const cells = r.Cells || [];
      const item = { name: String((cells[0] && cells[0].Value) || '').trim(), id: null, values: cells.slice(1).map((c) => num(c.Value)) };
      const attr = cells[0] && cells[0].Attributes && cells[0].Attributes.find((a) => a.Id === 'account');
      if (attr) item.id = attr.Value;
      if (r.RowType === 'Row') sec.rows.push(item);
      else if (r.RowType === 'SummaryRow') sec.summary = item;
    }
    return sec;
  }

  // -> { columns:[{label, month}], sections:[{title, rows, summary}], assumedOrder } or null if it isn't a report.
  // Columns come back OLDEST first: Xero lists comparison periods newest first, so they are reversed
  // (decided from the month names in the header when they can be read, else assumed newest-first).
  function parseReport(raw) {
    const rep = raw && raw.Reports && raw.Reports[0];
    if (!rep || !Array.isArray(rep.Rows)) return null;
    let header = null;
    const sections = [];
    for (const row of rep.Rows) {
      if (row.RowType === 'Header') header = (row.Cells || []).slice(1).map((c) => String((c && c.Value) || ''));
      else if (row.RowType === 'Section') sections.push(parseSection(row));
    }
    let n = header ? header.length : 0;
    for (const s of sections) for (const r of [...s.rows, s.summary].filter(Boolean)) n = Math.max(n, r.values.length);
    if (!n) return { columns: [], sections, assumedOrder: false };
    let cols = Array.from({ length: n }, (_, i) => ({ label: (header && header[i]) || '', month: monthOfLabel(header && header[i]), idx: i }));
    let order = cols.map((c) => c.idx);
    let assumed = false;
    if (n > 1) {
      if (cols.every((c) => c.month)) { if (cols[0].month > cols[n - 1].month) order.reverse(); }
      else { order.reverse(); assumed = true; }
    }
    const pick = (vals) => order.map((i) => (vals[i] === undefined ? 0 : vals[i]));
    for (const s of sections) { for (const r of s.rows) r.values = pick(r.values); if (s.summary) s.summary.values = pick(s.summary.values); }
    cols = order.map((i) => cols[i]);
    return { columns: cols, sections, assumedOrder: assumed };
  }

  const INCOME_RE = /^(trading )?(income|revenue)\b/i, COS_RE = /cost of (sales|goods)|direct costs?/i, OPEX_RE = /operating expenses|^(less )?expenses/i;
  const GROSS_RE = /^gross (profit|loss)/i, NET_RE = /^net (profit|loss|income|earnings)/i;
  const lineTotal = (sec, i) => (sec.summary ? sec.summary.values[i] || 0 : r2(sec.rows.reduce((a, r) => a + (r.values[i] || 0), 0)));

  // Headline numbers for column `i`, or for the sum of all columns when i === 'sum'.
  function headline(report, i) {
    const cols = report.columns.length || 1;
    const at = (sec) => (i === 'sum' ? r2(Array.from({ length: cols }, (_, k) => lineTotal(sec, k)).reduce((a, b) => a + b, 0)) : lineTotal(sec, i));
    const find = (re) => report.sections.find((s) => s.title && re.test(s.title));
    const named = (re) => { for (const s of report.sections) for (const r of s.rows) if (!s.title && re.test(r.name)) return r; return null; };
    const val = (row) => (row ? (i === 'sum' ? r2(row.values.reduce((a, b) => a + b, 0)) : row.values[i] || 0) : null);
    const inc = find(INCOME_RE), cos = find(COS_RE), opx = find(OPEX_RE);
    const income = inc ? at(inc) : null, cost = cos ? at(cos) : null, opex = opx ? at(opx) : null;
    let gross = val(named(GROSS_RE));
    if (gross === null && income !== null) gross = r2(income - (cost || 0));
    const net = val(named(NET_RE));
    return { income, cost, grossProfit: gross, opex, netProfit: net, margin: income ? r2((net === null ? 0 : net) / income * 100) : null };
  }

  // Months of the request: the range snapped OUT to whole months, never past the current month, and
  // at most the latest 12 (Xero compares at most 12 periods in one report).
  function monthRange(from, to, todayIso) {
    const first = monthKey(from), cur = monthKey(todayIso);
    const lastKey = monthKey(to) < cur ? monthKey(to) : cur;
    if (first > lastKey) return { months: [], capped: false, total: 0 };
    const all = [];
    for (let k = first; k <= lastKey; k = addMonths(k, 1)) all.push(k);
    return { months: all.slice(-12), capped: all.length > 12, total: all.length };
  }

  // Query for Reports/ProfitAndLoss. 'total' = one column for the whole range; 'month' = one column per
  // month: the latest month as the base period and (n-1) earlier months compared (timeframe=MONTH).
  function requestFor(mode, from, to, todayIso) {
    if (mode !== 'month') return { path: 'Reports/ProfitAndLoss', fromDate: from, toDate: to };
    const { months } = monthRange(from, to, todayIso);
    if (!months.length) return null;
    const last = months[months.length - 1];
    const q = { path: 'Reports/ProfitAndLoss', fromDate: `${last}-01`, toDate: lastDay(last) };
    if (months.length > 1) { q.periods = String(months.length - 1); q.timeframe = 'MONTH'; }
    return q;
  }

  // The last 12 COMPLETED months: the current (part-finished) month is left out, so it is always
  // 12 whole months ending on the last day of last month.
  function last12Completed(todayIso) {
    const cur = monthKey(todayIso);
    return { from: `${addMonths(cur, -12)}-01`, to: lastDay(addMonths(cur, -1)) };
  }

  // ---- compare with the previous year ----
  const shiftYear = (iso, delta) => { const mk = `${Number(iso.slice(0, 4)) + delta}-${iso.slice(5, 7)}`; return `${mk}-${pad(Math.min(Number(iso.slice(8)), Number(lastDay(mk).slice(8))))}`; };
  // The same period one year earlier. A period ending on the last day of a month ends on the last day of
  // that month a year earlier (so 29 Feb 2028 -> 28 Feb 2027), otherwise the day simply moves back a year.
  function priorYear(from, to) {
    const toEnd = to === lastDay(monthKey(to));
    return { from: shiftYear(from, -1), to: toEnd ? lastDay(addMonths(monthKey(to), -12)) : shiftYear(to, -1) };
  }

  // Lines up two single-column reports (this period and the earlier one): sections by title, lines by Xero
  // account (else by name). A line that only exists in one of them shows 0 in the other. Each merged line is
  // { name, id, values:[this period], prior }, and every summary row and Gross/Net Profit line is merged too.
  function compareReports(cur, prior) {
    const first = (r) => (r && r.values && r.values[0]) || 0;
    const lineKey = (r) => (r.id ? 'id:' + r.id : 'n:' + r.name.toLowerCase());
    const secKey = (sec) => (sec.title ? 't:' + sec.title.toLowerCase() : 'u:' + ((sec.rows[0] && sec.rows[0].name) || '').toLowerCase());
    const mergeSection = (c, p) => {
      const base = c || p;
      const pm = new Map(((p && p.rows) || []).map((r) => [lineKey(r), r]));
      const rows = [];
      for (const r of (c && c.rows) || []) { const m = pm.get(lineKey(r)); pm.delete(lineKey(r)); rows.push({ name: r.name, id: r.id, values: [first(r)], prior: first(m) }); }
      for (const r of pm.values()) rows.push({ name: r.name, id: r.id, values: [0], prior: first(r) });
      const sc = c && c.summary, sp = p && p.summary;
      const summary = sc || sp ? { name: (sc || sp).name, values: [first(sc)], prior: first(sp) } : null;
      return { title: base.title, rows, summary };
    };
    const pMap = new Map(((prior && prior.sections) || []).map((sec) => [secKey(sec), sec]));
    const out = [];
    for (const sec of cur.sections) { const k = secKey(sec); out.push(mergeSection(sec, pMap.get(k))); pMap.delete(k); }
    for (const sec of pMap.values()) {
      const m = mergeSection(null, sec);
      const at = sec.title ? out.findIndex((x) => !x.title) : -1; // a section only last year goes before the Gross/Net Profit lines
      if (at < 0) out.push(m); else out.splice(at, 0, m);
    }
    return { columns: cur.columns, sections: out, compare: true };
  }
  const pctChange = (v, p) => (p ? Math.round(((v - p) / Math.abs(p)) * 1000) / 10 : null);

  root.PNL = { parseReport, headline, monthRange, requestFor, monthOfLabel, last12Completed, priorYear, compareReports, pctChange, num, r2 };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PNL;
})(typeof window !== 'undefined' ? window : globalThis);
