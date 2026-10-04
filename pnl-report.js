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

  // "30 Sep 26" (what Xero's report actually sends), "30 Sep 2026", "Sep 2026", "1 September 2026" -> '2026-09'.
  // (Day-of-month is ignored; a two-digit year means 20xx.)
  function monthOfLabel(label) {
    const m = /([A-Za-z]{3,9})\.?\s+(\d{4}|\d{2})\b/.exec(String(label || ''));
    if (!m) return null;
    const i = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    return i < 0 ? null : `${m[2].length === 2 ? '20' + m[2] : m[2]}-${pad(i + 1)}`;
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

  // Query for the 'total' view: one column for the whole range. (By month / By quarter use monthlyPlan below.)
  function requestFor(mode, from, to) {
    return { path: 'Reports/ProfitAndLoss', fromDate: from, toDate: to };
  }
  // The consecutive months a By month / By quarter view needs. Quarters are built from the same monthly report
  // (see toQuarters), asking for just the months they cover.
  function monthsFor(mode, from, to, todayIso) {
    return mode === 'quarter' ? quarterRange(from, to, todayIso).quarters.flatMap((q) => q.months) : monthRange(from, to, todayIso).months;
  }

  // ---- monthly columns from Xero ----
  // Xero builds comparison columns by stepping the base period back k months and KEEPING THE BASE END DAY (clamped to
  // the month's length). From a base ending on the 30th, every 31-day month loses its 31st; from 28 Feb every column
  // stops on the 28th. (Seen on the live report: columns labelled "30 Jul 26", "30 May 26"… and the months added up
  // 1.9% short of the Total view.) Only a base ending on the 31st gives true month ends — so the base is always a
  // 31-day month: the last month itself if it has 31 days, otherwise the next one (its extra column is dropped).
  // Xero allows at most 11 comparison periods (12 columns), so a full 12 months ending in a 30-day month needs the
  // oldest month fetched on its own. Returns the requests to make, oldest first, each with the months to keep.
  const daysIn = (mk) => Number(lastDay(mk).slice(8));
  const monthsBetween = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
  function monthlyPlan(months) {
    if (!months.length) return [];
    const last = months[months.length - 1];
    const base = daysIn(last) === 31 ? last : addMonths(last, 1);
    const oldestReach = addMonths(base, -11);
    const covered = months.filter((m) => m >= oldestReach), rest = months.filter((m) => m < oldestReach);
    const span = monthsBetween(covered[0], base); // comparison periods needed to reach the oldest covered month
    const main = { path: 'Reports/ProfitAndLoss', fromDate: `${base}-01`, toDate: lastDay(base) };
    if (span > 0) { main.periods = String(span); main.timeframe = 'MONTH'; }
    const singles = rest.map((m) => ({ request: { path: 'Reports/ProfitAndLoss', fromDate: `${m}-01`, toDate: lastDay(m) }, keep: [m] }));
    return [...singles, { request: main, keep: covered }];
  }
  // Keeps only the wanted months' columns (dropping the extra base-month column). Falls back to dropping the newest
  // columns when Xero's headings couldn't be read.
  function keepMonths(report, months) {
    const cols = report.columns;
    if (cols.length && cols.every((c) => c.month)) {
      const idx = cols.map((c, i) => (months.includes(c.month) ? i : -1)).filter((i) => i >= 0);
      return pickColumns(report, idx);
    }
    return pickColumns(report, cols.map((_, i) => i).slice(0, months.length));
  }
  function pickColumns(report, idx) {
    const pick = (vals) => idx.map((i) => (vals[i] === undefined ? 0 : vals[i]));
    return {
      columns: idx.map((i) => report.columns[i]),
      sections: report.sections.map((sec) => ({ title: sec.title, rows: sec.rows.map((r) => ({ ...r, values: pick(r.values) })), summary: sec.summary ? { ...sec.summary, values: pick(sec.summary.values) } : null })),
      assumedOrder: report.assumedOrder,
    };
  }
  // Joins two monthly reports side by side: `older` columns first, then `newer`. Lines are matched by account / name.
  function mergeColumns(older, newer) {
    const no = older.columns.length;
    const c = compareReports(newer, older); // values = newer columns; priorValues = older columns (padded to the newer count)
    const sections = c.sections.map((sec) => ({
      title: sec.title,
      rows: sec.rows.map((r) => ({ name: r.name, id: r.id, values: r.priorValues.slice(0, no).concat(r.values) })),
      summary: sec.summary ? { name: sec.summary.name, values: sec.summary.priorValues.slice(0, no).concat(sec.summary.values) } : null,
    }));
    return { columns: older.columns.concat(newer.columns), sections, assumedOrder: older.assumedOrder || newer.assumedOrder };
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
      for (const r of (c && c.rows) || []) { const o = pair(r.name, r.id, vec(r), vec(take(r))); if (r.modelled) o.modelled = true; rows.push(o); }
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

  // ---- trading P&L ----
  // Stock lands in lumps (a big shipment hits one month's purchases; the following months sell it with almost no
  // purchases), so each month's actual gross and net profit swing. The trading view replaces the PRODUCT cost lines
  // — Opening Stock, Cost of Goods Sold / Purchases, Closing Stock — with a chosen % of each sales channel's income:
  // one % for Online sales and one for Wholesale sales. Other income (e.g. Freight Invoiced) carries no goods cost,
  // other Cost of Sales lines (e.g. Freight & Courier) stay actual, and so does everything below Gross Profit. Gross
  // Profit and Net Profit move by exactly the amount the goods cost moved.
  const GOODS_RE = /^(opening|closing)\s+(stock|inventory)\b|^cost of goods\b|^purchases\b/i;
  const isGoodsRow = (name) => GOODS_RE.test(String(name || '').trim());
  // Which channel an income line belongs to, by its account name (Sales - Online, Sales AM - Wholesale AU/NZ…).
  const incomeKind = (name) => (/wholesale/i.test(name) ? 'wholesale' : /online|shopify|e-?commerce/i.test(name) ? 'online' : 'other');
  const KIND_LABEL = { online: 'Online', wholesale: 'Wholesale' };
  const colCount = (rep) => Math.max(1, (rep.columns || []).length, ...rep.sections.flatMap((sec) => [...sec.rows, sec.summary].filter(Boolean).map((r) => r.values.length)));
  const sumArr = (a) => r2(a.reduce((x, y) => x + y, 0));

  // The actual goods cost and the income by channel, per column. { found:false } if the report has no Income section
  // or no recognisable goods lines inside Cost of Sales. actualPct is goods cost as a % of Online + Wholesale sales
  // (the base the percentages apply to), blended across the two channels.
  function goodsInfo(report) {
    const n = colCount(report);
    const incSec = report.sections.find((x) => x.title && INCOME_RE.test(x.title));
    const cosSec = report.sections.find((x) => x.title && COS_RE.test(x.title));
    const goods = cosSec ? cosSec.rows.filter((r) => isGoodsRow(r.name)) : [];
    if (!incSec || !cosSec || !goods.length) return { found: false };
    const kindIncome = { online: Array(n).fill(0), wholesale: Array(n).fill(0), other: Array(n).fill(0) };
    for (const r of incSec.rows) { const k = incomeKind(r.name); for (let i = 0; i < n; i++) kindIncome[k][i] = r2(kindIncome[k][i] + (r.values[i] || 0)); }
    const kindTotal = { online: sumArr(kindIncome.online), wholesale: sumArr(kindIncome.wholesale), other: sumArr(kindIncome.other) };
    const actual = Array.from({ length: n }, (_, i) => r2(goods.reduce((a, r) => a + (r.values[i] || 0), 0)));
    const totalActual = sumArr(actual), salesTotal = r2(kindTotal.online + kindTotal.wholesale);
    return { found: true, n, kindIncome, kindTotal, salesTotal, actual, totalActual, actualPct: salesTotal ? r2((totalActual / salesTotal) * 100) : null, cosSec, incSec };
  }

  const validPct = (v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100;

  // pcts = { online, wholesale } (0–100). A % is only needed for a channel that actually has income in this report.
  // Returns { applied, report, info, missing:[...] }; with a needed % missing (or nothing to replace) the report comes
  // back unchanged, and `missing` says which channels still need one.
  function tradingView(report, pcts) {
    const info = goodsInfo(report);
    if (!info.found) return { applied: false, report, info, missing: [] };
    const need = ['online', 'wholesale'].filter((k) => info.kindTotal[k] !== 0);
    if (!need.length) return { applied: false, report, info, missing: [], noChannels: true };
    const missing = need.filter((k) => !validPct(pcts && pcts[k]));
    if (missing.length) return { applied: false, report, info, missing };
    const pct = {}, modelledBy = {};
    for (const k of need) { pct[k] = Number(pcts[k]); modelledBy[k] = info.kindIncome[k].map((v) => r2((v * pct[k]) / 100)); }
    const modelled = Array.from({ length: info.n }, (_, i) => r2(need.reduce((a, k) => a + modelledBy[k][i], 0)));
    const delta = info.actual.map((a, i) => r2(a - modelled[i])); // positive = the model's cost is lower, so profit is higher
    const rowsFor = () => need.map((k) => ({ name: `Cost of goods – ${KIND_LABEL[k]} (${Math.round(pct[k] * 100) / 100}% of ${k} sales)`, id: null, values: modelledBy[k].slice(), modelled: true }));
    const sections = report.sections.map((sec) => {
      if (sec === info.cosSec) {
        const rows = []; let placed = false;
        for (const r of sec.rows) {
          if (!isGoodsRow(r.name)) { rows.push(r); continue; }
          if (!placed) { rows.push(...rowsFor()); placed = true; }
        }
        const summary = sec.summary ? { ...sec.summary, values: Array.from({ length: info.n }, (_, i) => r2((sec.summary.values[i] || 0) - info.actual[i] + modelled[i])) } : null;
        return { ...sec, rows, summary };
      }
      if (!sec.title) return { ...sec, rows: sec.rows.map((r) => (GROSS_RE.test(r.name) || NET_RE.test(r.name) ? { ...r, values: Array.from({ length: info.n }, (_, i) => r2((r.values[i] || 0) + delta[i])) } : r)) };
      return sec;
    });
    const totalModelled = sumArr(modelled);
    return { applied: true, report: { ...report, sections }, info, pct, need, modelled, modelledBy, delta, totalModelled, totalDelta: sumArr(delta), blendedPct: info.salesTotal ? r2((totalModelled / info.salesTotal) * 100) : null };
  }

  root.PNL = { goodsInfo, tradingView, isGoodsRow, incomeKind, validPct, parseReport, headline, monthRange, quarterRange, quarterLabel, toQuarters, priorQuarters, requestFor, monthsFor, monthlyPlan, keepMonths, mergeColumns, lastDay, monthOfLabel, last12Completed, priorYear, compareReports, pctChange, isStockRow, stockTotals, num, r2 };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PNL;
})(typeof window !== 'undefined' ? window : globalThis);
