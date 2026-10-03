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
    if (mode !== 'month' && mode !== 'quarter') return { path: 'Reports/ProfitAndLoss', fromDate: from, toDate: to };
    // Quarters are built from the same monthly report (see toQuarters), asking for just the months they cover.
    const months = mode === 'quarter' ? quarterRange(from, to, todayIso).quarters.flatMap((q) => q.months) : monthRange(from, to, todayIso).months;
    return requestForMonths(months);
  }
  // The monthly report for a list of consecutive months: the latest as the base period plus the (n-1) before it.
  function requestForMonths(months) {
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

  // ---- quarters ----
  // Quarters are calendar quarters (Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec). With a Jul–Jun financial year those are
  // exactly the financial-year quarters: Jul–Sep = Q1, Oct–Dec = Q2, Jan–Mar = Q3, Apr–Jun = Q4.
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const quarterStart = (mk) => { const m = Number(mk.slice(5, 7)); return `${mk.slice(0, 4)}-${pad(m - ((m - 1) % 3))}`; };
  function quarterLabel(startMk) {
    const y = Number(startMk.slice(0, 4)), m = Number(startMk.slice(5, 7));
    const fy = m >= 7 ? y + 1 : y, qn = Math.floor((m >= 7 ? m - 7 : m + 5) / 3) + 1;
    return { label: `Q${qn} FY${String(fy).slice(2)}`, sub: `${MON[m - 1]}–${MON[m + 1]} ${String(y).slice(2)}` };
  }
  // The quarters shown for a range: the range snapped OUT to whole quarters, stopping at the current month (the
  // quarter in progress is shown part-finished), and at most the latest 4 (Xero compares up to 12 months at once).
  function quarterRange(from, to, todayIso) {
    const cur = monthKey(todayIso);
    const toQuarterEnd = addMonths(quarterStart(monthKey(to)), 2); // widened out to the end of the quarter containing `to`…
    const lastKey = toQuarterEnd < cur ? toQuarterEnd : cur;       // …but never past the current month
    const first = quarterStart(monthKey(from));
    if (first > lastKey) return { quarters: [], capped: false, total: 0 };
    const all = [];
    for (let k = first; k <= lastKey; k = addMonths(k, 1)) {
      const qs = quarterStart(k);
      let q = all[all.length - 1];
      if (!q || q.start !== qs) { q = { start: qs, months: [], ...quarterLabel(qs) }; all.push(q); }
      q.months.push(k);
    }
    for (const q of all) q.partial = q.months.length < 3;
    return { quarters: all.slice(-4), capped: all.length > 4, total: all.length };
  }
  // The same quarters one year earlier, month for month — so a quarter still in progress is compared with the same
  // months of last year, not with a quarter that was complete.
  const priorQuarters = (quarters) => quarters.map((q) => { const start = addMonths(q.start, -12); return { ...q, start, months: q.months.map((m) => addMonths(m, -12)), ...quarterLabel(start) }; });

  // Turns the monthly report (one column per month, oldest first) into one column per quarter by adding the months.
  function toQuarters(report, quarters) {
    const months = quarters.flatMap((q) => q.months);
    const colMonth = report.columns.map((c, i) => c.month || months[i]);
    const groups = quarters.map((q) => colMonth.map((m, i) => (q.months.includes(m) ? i : -1)).filter((i) => i >= 0));
    const agg = (vals) => groups.map((g) => r2(g.reduce((a, i) => a + (vals[i] || 0), 0)));
    const sections = report.sections.map((sec) => ({
      title: sec.title,
      rows: sec.rows.map((r) => ({ ...r, values: agg(r.values) })),
      summary: sec.summary ? { ...sec.summary, values: agg(sec.summary.values) } : null,
    }));
    return { columns: quarters.map((q) => ({ label: q.label, sub: q.sub, month: q.start, partial: q.partial })), sections, assumedOrder: report.assumedOrder };
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
    // One column (a whole period) or several (quarters): every line carries its values and its previous-year values
    // per column. `prior` stays as the first previous-year value for the single-column case.
    const n = Math.max(1, (cur.columns || []).length);
    const vec = (r) => { const v = (r && r.values) || []; return Array.from({ length: n }, (_, i) => v[i] || 0); };
    const zeros = () => Array.from({ length: n }, () => 0);
    const lineKey = (r) => (r.id ? 'id:' + r.id : 'n:' + r.name.toLowerCase());
    const secKey = (sec) => (sec.title ? 't:' + sec.title.toLowerCase() : 'u:' + ((sec.rows[0] && sec.rows[0].name) || '').toLowerCase());
    const pair = (name, id, values, priorValues) => ({ name, id, values, priorValues, prior: priorValues[0] });
    const mergeSection = (c, p) => {
      const base = c || p;
      const pm = new Map(((p && p.rows) || []).map((r) => [lineKey(r), r]));
      const rows = [];
      // pair by Xero account first, then (for anything left) by name — covers a report whose lines carry no account id
      const take = (r) => {
        let k = lineKey(r), m = pm.get(k);
        if (!m) { k = [...pm.keys()].find((x) => pm.get(x).name.toLowerCase() === r.name.toLowerCase()); m = k ? pm.get(k) : undefined; }
        if (m) pm.delete(k);
        return m;
      };
      for (const r of (c && c.rows) || []) rows.push(pair(r.name, r.id, vec(r), vec(take(r))));
      for (const r of pm.values()) rows.push(pair(r.name, r.id, zeros(), vec(r)));
      const sc = c && c.summary, sp = p && p.summary;
      const summary = sc || sp ? pair((sc || sp).name, null, vec(sc), vec(sp)) : null;
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

  // ---- opening / closing stock ----
  // Xero lists these as ordinary lines inside Cost of Sales (Closing Stock comes through negative), and Total Cost of
  // Sales / Gross Profit / Net Profit include them. The page can hide the lines; the totals are never changed.
  const STOCK_RE = /^(opening|closing)\s+(stock|inventory)\b/i;
  const isStockRow = (name) => STOCK_RE.test(String(name || '').trim());
  // What the hidden lines add up to across all columns of the report (or merged comparison): { opening, closing, net, found }.
  function stockTotals(sections) {
    const t = { opening: 0, closing: 0, found: 0 };
    for (const sec of sections) for (const r of sec.rows) {
      if (!isStockRow(r.name)) continue;
      const v = r2((r.values || []).reduce((a, b) => a + b, 0));
      if (/^opening/i.test(r.name.trim())) t.opening = r2(t.opening + v); else t.closing = r2(t.closing + v);
      t.found++;
    }
    t.net = r2(t.opening + t.closing);
    return t;
  }

  root.PNL = { parseReport, headline, monthRange, quarterRange, quarterLabel, toQuarters, priorQuarters, requestFor, requestForMonths, lastDay, monthOfLabel, last12Completed, priorYear, compareReports, pctChange, isStockRow, stockTotals, num, r2 };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PNL;
})(typeof window !== 'undefined' ? window : globalThis);
