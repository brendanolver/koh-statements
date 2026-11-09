/* Cashflow forecast engine — pure functions, no DOM, no network.
 *
 * Turns what we know (Xero balance / receivables / payables, Apparel Magic open
 * orders + purchase orders, Shopify sales history, run-rates from Xero history)
 * plus the user's manual overrides into a day-by-day cash forecast for three
 * scenarios (worst / base / best), and explains where every number came from.
 *
 * Every forecast amount is an "item" with a date, a line, a label, a source
 * (Xero / Apparel Magic / Shopify / Manual / Run-rate) and a status
 * (confirmed = an invoice, bill or order that exists; assumption = modelled).
 * The summary numbers are sums of items, so any figure can be traced back.
 *
 * Loaded by index.html as a plain script (window.CFE) and by the node tests.
 */
(function (root) {
  'use strict';

  const DAY = 86400000;
  const toMs = (iso) => Date.parse(iso + 'T00:00:00Z');
  const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const addDays = (iso, n) => toIso(toMs(iso) + n * DAY);
  const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY);
  const monthKey = (iso) => iso.slice(0, 7);
  const lastDayOfMonth = (iso) => { const [y, m] = iso.split('-').map(Number); return toIso(Date.UTC(y, m, 0)); };
  const addMonths = (mk, n) => { const [y, m] = mk.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return toIso(d.getTime()).slice(0, 7); };
  const round2 = (n) => Math.round(n * 100) / 100;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  const LINES_IN = ['online', 'wholesale', 'otherIn', 'manualIn'];   // manualIn = one-off receipts the user has entered (incl. a planned Lumi drawdown)
  // 'cards' = Amex statement payments leaving the bank on their due dates; 'cardCredit' = the (negative)
  // card spend that is already inside Marketing / Other cash out but isn't paid until the statement
  // is due — so the Cash out total is what actually leaves the bank, and both lines reconcile.
  // 'bas' = the monthly GST + PAYG payment to the ATO, forecast on its own (never inside Other cash out);
  // 'manualOut' = one-off payments the user has entered (incl. a planned Lumi repayment).
  const LINES_OUT = ['stock', 'marketing', 'otherOut', 'cards', 'cardCredit', 'bas', 'manualOut'];
  const INPUT_LINES = ['online', 'wholesale', 'otherIn', 'stock', 'marketing', 'otherOut']; // the ones you can override monthly
  const LINES = [...LINES_IN, ...LINES_OUT];
  const LINE_LABELS = { online: 'Online sales', wholesale: 'Wholesale', otherIn: 'Other cash in', stock: 'Stock payments', marketing: 'Marketing', otherOut: 'Other cash out', cards: 'Amex payments', cardCredit: 'Charged to Amex (paid later)', bas: 'BAS (GST + PAYG)', manualIn: 'Manual adjustments (in)', manualOut: 'Manual adjustments (out)' };
  // Which scenario percentage moves which line (see DEFAULT_SETTINGS.scenarios).
  const LINE_PCT_KEY = { online: 'online', wholesale: 'wholesale', stock: 'stock', marketing: 'out', otherOut: 'out' };
  // Lines that can be planned from last year's same month (settings flag that switches each one off).
  // Online already works from last year's Shopify sales, and Other cash in is mostly one-offs (loan money,
  // owner money), so neither is in this list.
  const LY_LINES = { wholesale: 'lyWholesale', stock: 'lyStock', marketing: 'lyMarketing', otherOut: 'lyOtherOut' };

  const DEFAULT_SETTINGS = {
    defaultTermsDays: 30,     // wholesale customers we have no Xero payment-terms history for
    arLateDays: 7,            // wholesale invoices are typically paid this many days after due
    overdueCollectDays: 21,   // overdue receivables are assumed collected this many days from today
    apOverduePayDays: 7,      // overdue bills are assumed paid this many days from today
    poTermsDays: 30,          // Apparel Magic purchase orders are assumed paid this long after their ex-factory date
    nzdPerAud: 1.21,          // NZD receivables / orders are converted at this (foreign units per 1 AUD) unless the invoice carries its own rate
    // Credit-card statement rules, keyed by the card's last 4 digits (from Xero): the day the statement
    // closes, the day it's due, and whether that's the same month as the close (0) or the next (1).
    cardTerms: { '1003': { closeDay: 25, dueDay: 19, dueMonthOffset: 1 }, '1000': { closeDay: 5, dueDay: 29, dueMonthOffset: 0 } },
    cardDefault: { closeDay: 25, dueDay: 19, dueMonthOffset: 1 },
    usdPerAud: 0.66,          // Apparel Magic has no usable exchange rate (its POs carry rate 1), so USD POs use this
    shipLateDays: 7,          // open orders already past their due date are assumed to ship this many days from today
    cashThreshold: 100000,    // the "comfortable" level: below it is Amber (Watch closely)
    minCash: 30000,           // the minimum cash buffer: below it is Red (Action required)
    staleBillDays: 180,       // a bill overdue by more than this is left out as stale (set a payment date on it to include it)
    basPayDay: 25,            // day of the month the BAS is assumed paid (history shows the 21st–27th)
    debtorDaysOverride: null, // null = each customer's own average days to pay; a number = everyone pays this many days after invoice date
    lumiLimit: null,          // Lumi facility limit (typed in — Xero doesn't hold it)
    onlineConversion: null,   // Shopify sales -> bank receipts; null = calibrate from Xero history
    // Last year as the starting point: from next month on, Wholesale, Stock, Marketing and Other cash out are
    // planned as last year's same month x (1 + the scenario %). 1 = on, 0 = off (lyOn is the master switch).
    lyOn: 1, lyWholesale: 1, lyStock: 1, lyMarketing: 1, lyOtherOut: 1,
    scenarios: {
      // online / wholesale / stock / out are % changes (against last year's pattern, or the system forecast
      // where a line isn't using last year); delay is extra days customers take to pay.
      // out = growth in operating expenses on last year (base +5%; worst/best are 5 points either side)
      worst: { online: -15, wholesale: -10, stock: 0, out: 10, delay: 14 },
      base: { online: 0, wholesale: 0, stock: 0, out: 5, delay: 0 },
      best: { online: 15, wholesale: 5, stock: 0, out: 0, delay: -5 },
    },
  };

  function mergeSettings(saved) {
    const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    if (!saved) return s;
    for (const k of Object.keys(s)) {
      if (k === 'scenarios') continue;
      if (saved[k] !== undefined && saved[k] !== null && saved[k] !== '' && Number.isFinite(Number(saved[k]))) s[k] = Number(saved[k]);
    }
    for (const key of ['cardTerms']) {
      for (const [last4, t] of Object.entries((saved[key]) || {})) {
        const cur = s[key][last4] || { ...s.cardDefault };
        for (const k of ['closeDay', 'dueDay', 'dueMonthOffset']) if (t && t[k] !== undefined && t[k] !== '' && Number.isFinite(Number(t[k]))) cur[k] = Number(t[k]);
        s[key][last4] = cur;
      }
    }
    if (saved.scenarios) {
      for (const sc of ['worst', 'base', 'best']) {
        for (const k of Object.keys(s.scenarios[sc])) {
          const v = saved.scenarios[sc] && saved.scenarios[sc][k];
          if (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))) s.scenarios[sc][k] = Number(v);
        }
      }
    }
    return s;
  }

  // ---------------------------------------------------------------- Shopify
  // Base online forecast from Shopify's daily sales: last year's same-period
  // sales (7-day smoothed, so a single odd day doesn't dominate) scaled by how
  // this year is tracking against last (trailing 8 weeks vs the same 8 weeks a
  // year earlier). Where last year isn't available it falls back to the
  // trailing 28-day run-rate. Returns per-day gross sales and how it got there.
  //
  // `targets` ({ 'YYYY-MM': pct }) are the growth targets set for the year: for a month with a
  // target the forecast is last year's sales for that same calendar month x (1 + target), spread
  // over the month by last year's daily pattern so the month lands exactly on that number.
  // Months without a target keep the trend method above.
  function shopifyForecast(daily, today, horizonDays, targets) {
    const sales = (d) => (daily[d] ? daily[d][0] : null);
    const sumRange = (from, to) => { let s = 0, n = 0; for (let d = from; d <= to; d = addDays(d, 1)) { const v = sales(d); if (v !== null) { s += v; n++; } } return { s, n }; };
    const yest = addDays(today, -1);
    const cur = sumRange(addDays(today, -56), yest);
    const ly = sumRange(addDays(today, -56 - 364), addDays(yest, -364));
    const coverageOk = cur.n >= 50 && ly.n >= 50 && ly.s > 0;
    const yoy = coverageOk ? clamp(cur.s / ly.s, 0.4, 2.5) : null;
    const t28 = sumRange(addDays(today, -28), yest);
    const trailingPerDay = t28.n >= 20 ? t28.s / t28.n : (cur.n ? cur.s / cur.n : 0);
    const shapeAt = (d) => { const c = addDays(d, -364); const w = sumRange(addDays(c, -3), addDays(c, 3)); return w.n >= 5 ? w.s / w.n : null; };
    // Per-month growth targets -> a scale factor per month (only when last year's month is well covered).
    const targetInfo = {}, monthFactor = {};
    for (const [mk, raw] of Object.entries(targets || {})) {
      const pct = Number(raw);
      if (raw === '' || raw === null || raw === undefined || !Number.isFinite(pct)) continue;
      const first = mk + '-01', last = lastDayOfMonth(first);
      if (last <= today) continue; // a month that's already over
      const lyFirst = addMonths(mk, -12) + '-01', lyLast = lastDayOfMonth(lyFirst);
      const days = []; for (let d = first; d <= last; d = addDays(d, 1)) days.push(d);
      let shapeSum = 0, have = 0;
      for (const d of days) { const v = shapeAt(d); if (v !== null) { shapeSum += v; have++; } }
      const ly = sumRange(lyFirst, lyLast);
      const lyLen = daysBetween(lyFirst, lyLast) + 1;
      if (have < days.length * 0.9 || ly.n < lyLen * 0.95 || shapeSum <= 0) { targetInfo[mk] = { applied: false, pct, reason: 'last year is not fully in Shopify history' }; continue; }
      monthFactor[mk] = (ly.s * (1 + pct / 100)) / shapeSum;
      targetInfo[mk] = { applied: true, pct, ly: ly.s, sales: ly.s * (1 + pct / 100) };
    }
    const out = {}; let lyDays = 0, fallbackDays = 0;
    for (let i = 1; i <= horizonDays; i++) {
      const d = addDays(today, i);
      let v = null;
      const mk = monthKey(d);
      if (monthFactor[mk] !== undefined) { const sh = shapeAt(d); if (sh !== null) { v = sh * monthFactor[mk]; lyDays++; } }
      if (v === null && yoy !== null) {
        const sh = shapeAt(d);
        if (sh !== null) { v = sh * yoy; lyDays++; }
      }
      if (v === null) { v = trailingPerDay; fallbackDays++; }
      out[d] = Math.max(0, v);
    }
    return { perDay: out, yoy, trailingPerDay, lyDays, fallbackDays, targetInfo, method: yoy !== null ? 'last year × trend' : 'recent run-rate', hasData: cur.n > 0 || t28.n > 0 };
  }

  // Online forecast from LAST YEAR'S BANK DEPOSITS — used when Shopify's own sales history isn't available. Each future
  // day is last year's same day (364 days earlier, so weekdays line up) as a 7-day average: enough to keep Black Friday
  // and Christmas without letting one odd payout dominate. Bank deposits are already net of merchant fees and GST is not
  // taken off them (it settles through the BAS), so nothing is deducted here. Days whose last-year date hasn't happened
  // yet (the far end of a 12-month horizon) use the recent daily average instead.
  function xeroOnlineForecast(daily, today, horizonDays) {
    const val = (d) => Math.max(0, daily[d] || 0);
    const avg7 = (c) => { let t = 0; for (let k = -3; k <= 3; k++) t += val(addDays(c, k)); return t / 7; };
    const yest = addDays(today, -1);
    let recent = 0;
    for (let k = 1; k <= 28; k++) recent += val(addDays(today, -k));
    recent /= 28;
    const perDay = {};
    let lyDays = 0, fallbackDays = 0;
    for (let i = 1; i <= horizonDays; i++) {
      const d = addDays(today, i), c = addDays(d, -364);
      if (addDays(c, 3) <= yest) { perDay[d] = avg7(c); lyDays++; } else { perDay[d] = recent; fallbackDays++; }
    }
    return { perDay, lyDays, fallbackDays, recentPerDay: recent };
  }

  // One month of the user's own sales forecast: { pct } (growth on last year) or { amount } (dollars for the month);
  // null when nothing usable is typed. An amount wins if both are present.
  function salesPlanEntry(sp, line, mk) {
    const e = sp && sp[line] && sp[line][mk];
    if (!e || typeof e !== 'object') return null;
    const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));
    const amount = num(e.amount), pct = num(e.pct);
    if (Number.isFinite(amount) && amount >= 0) return { amount };
    if (Number.isFinite(pct)) return { pct: Math.max(-100, pct) };
    return null;
  }

  // ------------------------------------------------------------ item building
  const isForeign =(cur) => cur && String(cur).toUpperCase() !== 'AUD';
  // Tax bills (BAS / PAYG) are cash out but not stock: they are their own line, "BAS (GST + PAYG)".
  const TAX_CONTACT_RE = /\bATO\b|AUSTRALIAN TAX|TAXATION OFFICE|\bPAYG\b/i;

  // System-generated items for one scenario. Scenario effects applied here:
  //   delay  -> when customers pay (receivables + wholesale orders)
  //   %      -> online sales, unconfirmed wholesale orders, marketing/other spend
  function buildItems(input, settings, sc) {
    const { today } = input;
    const tomorrow = addDays(today, 1);
    const items = [];
    const push = (line, date, amount, label, source, status, meta) => {
      if (!(amount > 0) || date < tomorrow) return;
      items.push({ line, date, amount, label, source, status, ...(meta ? { meta } : {}) });
    };
    const delay = sc.delay || 0;
    const notes = { excluded: [] };

    // -- The user's own sales forecast (the Sales forecast card): per month, for online and wholesale, either a % on last
    // year or a dollar amount for the month. In the base case the typed figure IS the forecast — it replaces the general
    // growth % for that month rather than stacking on it. Worst and best sit either side by the same gap their % has from
    // the base %, so the three cases still fan out around what was typed.
    const sp = input.salesPlan || {};
    const baseSc = settings.scenarios.base;
    const rel = (key) => (1 + (sc[key] || 0) / 100) / Math.max(0.01, 1 + (baseSc[key] || 0) / 100);
    const planFor = (line, mk) => salesPlanEntry(sp, line, mk);
    const money0 = (n) => '$' + Math.round(n).toLocaleString('en-AU');
    const pctTxt = (p) => `${p >= 0 ? '+' : '−'}${Math.abs(Math.round(p * 10) / 10)}%`;
    notes.salesPlanSkipped = [];

    // -- Last year as the starting point: which future months are planned from last year, per line. The rest of
    // this month keeps the usual logic (known bills and orders dominate that short stretch), and so does any
    // month last year can't cover.
    const ly = input.lastYear || null;
    const growth = input.growth || {}; // { line: { 'YYYY-MM': pct } } — growth on last year for that month, before the case %
    const m0 = monthKey(today);
    const lyMonths = {};
    for (const [line, flag] of Object.entries(LY_LINES)) {
      lyMonths[line] = new Set();
      if (!ly || !settings.lyOn || !settings[flag]) continue;
      for (let k = 1; k <= 11; k++) {
        const mk = addMonths(m0, k);
        const row = ly[addMonths(mk, -12)];
        if (row && Number.isFinite(row[line])) lyMonths[line].add(mk);
      }
    }
    const inLy = (line, d) => lyMonths[line] && lyMonths[line].has(monthKey(d));

    // -- Wholesale: Xero receivables (issued invoices; scenario only changes timing)
    // Foreign-currency receivables/orders (NZD wholesale) are converted to AUD: an invoice's own
    // Xero rate when it has one, else the NZD/USD setting or a rate seen in Xero.
    const rateFor = (cur) => (!cur || String(cur).toUpperCase() === 'AUD' ? 1 : String(cur).toUpperCase() === 'NZD' ? (input.fx && input.fx.NZD) || settings.nzdPerAud : String(cur).toUpperCase() === 'USD' ? settings.usdPerAud : (input.fx && input.fx[cur]) || null);
    for (const inv of input.ar || []) {
      if (inv.online) { notes.excluded.push({ kind: 'online-contact receivable', label: inv.contact, amount: inv.amountDue }); continue; }
      if (!(inv.amountDue > 0)) continue;
      const rate = isForeign(inv.currency) ? (inv.rate > 0 ? inv.rate : rateFor(inv.currency)) : 1;
      if (!rate) { notes.excluded.push({ kind: 'receivable with no exchange rate', label: inv.contact, amount: inv.amountDue, currency: inv.currency }); continue; }
      const amountAud = inv.amountDue / rate;
      const overdue = inv.dueDate < today;
      // When a customer is expected to pay, best evidence first: a debtor-days setting that applies to everyone, else this
      // customer's own average days from invoice date to payment (needs 3+ paid invoices), else their terms + the usual
      // lateness. An invoice already past the date those give isn't assumed paid immediately: it's collected
      // `overdueCollectDays` from today (the same rule overdue invoices always had).
      const hist = input.payDaysByCustomer && input.payDaysByCustomer[String(inv.contact || '').toUpperCase()];
      let expected, basis = 'terms';
      if (Number.isFinite(settings.debtorDaysOverride) && inv.invoiceDate) { expected = addDays(inv.invoiceDate, settings.debtorDaysOverride + delay); basis = 'debtor days setting'; }
      else if (hist && hist.n >= 3 && inv.invoiceDate) { expected = addDays(inv.invoiceDate, Math.round(hist.days) + delay); basis = `their average ${Math.round(hist.days)} days to pay`; }
      if (expected !== undefined) { if (expected <= today) expected = addDays(today, settings.overdueCollectDays + delay); }
      else expected = overdue ? addDays(today, settings.overdueCollectDays + delay) : addDays(inv.dueDate, settings.arLateDays + delay);
      push('wholesale', expected < tomorrow ? tomorrow : expected, amountAud, inv.contact, 'Xero', 'confirmed', { doc: inv.number, due: inv.dueDate, overdue, basis, currency: isForeign(inv.currency) ? inv.currency : undefined });
    }

    // -- Wholesale: Apparel Magic open orders (confirmed, not yet invoiced)
    for (const o of input.amOrders || []) {
      const oRate = isForeign(o.cur) ? rateFor(o.cur) : 1;
      if (!oRate) { notes.excluded.push({ kind: 'order with no exchange rate', label: o.cn, amount: o.lines.reduce((a, l) => a + l.v, 0), currency: o.cur }); continue; }
      const terms = (input.termsByCustomer && input.termsByCustomer[(o.cn || '').toUpperCase()]) ?? settings.defaultTermsDays;
      for (const l of o.lines) {
        const ship = l.d < today ? addDays(today, settings.shipLateDays) : l.d;
        const receipt = addDays(ship, terms + settings.arLateDays + delay);
        // (in a month with a typed wholesale forecast the base case leaves confirmed orders as they are — the typed figure is the growth)
        push('wholesale', receipt, (l.v / oRate) * (1 + (o.gst || 0)) * (planFor('wholesale', monthKey(receipt)) ? rel('wholesale') : 1 + (sc.wholesale || 0) / 100), o.cn, 'Apparel Magic', 'confirmed', { doc: o.po || o.id, ship, terms, order: o.id, currency: isForeign(o.cur) ? o.cur : undefined });
      }
    }

    // -- Online: Shopify sales (or Xero run-rate when Shopify isn't connected)
    const conv = input.conversion;
    // onlineBasis: what each month would be with no growth at all (last year's pattern), so a typed % and a typed $ can be
    // shown against each other. It is the number the Sales forecast card calls "last year".
    const onlineBasis = {};
    const addBasis = (d, v) => { const mk = monthKey(d); onlineBasis[mk] = (onlineBasis[mk] || 0) + v; };
    if (input.shopifyFc && input.shopifyFc.hasData) {
      const ti = input.shopifyFc.targetInfo || {};
      const baseOnline = Math.max(0.01, 1 + (baseSc.online || 0) / 100);
      for (const [d, v] of Object.entries(input.shopifyFc.perDay)) {
        const t = ti[monthKey(d)];
        const targeted = t && t.applied;
        // a month with its own target replaces the general online % (the worst / best % sits around it) instead of stacking on it
        push('online', d, v * conv * (1 + (sc.online || 0) / 100) / (targeted ? baseOnline : 1), targeted ? `Shopify forecast (${t.pct >= 0 ? '+' : ''}${t.pct}% target vs last year)` : 'Shopify forecast', 'Shopify', 'assumption',
          { method: targeted ? `last year's ${monthKey(addDays(d, -365))} sales × (1 ${t.pct >= 0 ? '+' : '−'} ${Math.abs(t.pct)}%)` : input.shopifyFc.method });
        addBasis(d, v * conv);
      }
      for (const [mk, t] of Object.entries(ti)) if (t.applied) onlineBasis[mk] = t.ly * conv;
    } else if (input.onlineLy && input.onlineLy.daily && input.onlineLy.from && input.onlineLy.from <= addDays(today, -360)) {
      const xf = xeroOnlineForecast(input.onlineLy.daily, today, input.horizonDays);
      notes.onlineMethod = { method: 'last year deposits', lyDays: xf.lyDays, fallbackDays: xf.fallbackDays };
      const pct = sc.online || 0;
      const sgn = `${pct >= 0 ? '+' : '−'}${Math.abs(pct)}%`;
      for (const [d, v] of Object.entries(xf.perDay)) {
        push('online', d, v * (1 + pct / 100), `Last year's online deposits (${sgn})`, 'Xero', 'assumption',
          { method: `Last year's online bank deposits around the same day (7-day average, already net of fees) × (1 ${pct >= 0 ? '+' : '−'} ${Math.abs(pct)}%)` });
        addBasis(d, v);
      }
    } else if (input.history && input.history.onlineReceiptsPerWeek > 0) {
      const perDay = input.history.onlineReceiptsPerWeek / 7;
      for (let i = 1; i <= input.horizonDays; i++) { push('online', addDays(today, i), perDay * (1 + (sc.online || 0) / 100), 'Recent receipts run-rate', 'Xero', 'assumption', { method: 'Xero receipts, last 13 weeks' }); addBasis(addDays(today, i), perDay); }
    }
    notes.onlineBasis = onlineBasis;

    // Typed online forecast, month by month. A % scales that month's daily pattern; a $ amount rescales the month so it adds
    // up to exactly that (worst / best around it — see `rel`). With Shopify connected a typed % is applied by the Shopify
    // forecast itself from last year's actual sales (see buildForecast), so only $ amounts are handled here in that case.
    {
      const baseOnline = Math.max(0.01, 1 + (baseSc.online || 0) / 100);
      const m0o = monthKey(today);
      for (const mk of Object.keys(sp.online || {})) {
        const e = planFor('online', mk);
        if (!e || mk < m0o) continue;
        const its = items.filter((it) => it.line === 'online' && monthKey(it.date) === mk);
        const label = e.amount !== undefined ? `Your forecast (${money0(e.amount)} for the month)` : `Your forecast (${pctTxt(e.pct)} on last year)`;
        if (e.pct !== undefined) {
          const t = input.shopifyFc && input.shopifyFc.targetInfo && input.shopifyFc.targetInfo[mk];
          if (t && t.applied) continue;
          if (!its.length) { notes.salesPlanSkipped.push({ line: 'online', month: mk, reason: 'no online forecast to apply the % to' }); continue; }
          const f = (1 + e.pct / 100) / baseOnline;
          for (const it of its) { it.amount *= f; it.label = label; it.source = 'Your forecast'; it.meta = { ...(it.meta || {}), method: `${(it.meta && it.meta.method) || 'Online forecast'} — you set this month to ${pctTxt(e.pct)} on last year` }; }
        } else {
          const target = e.amount * rel('online');
          const have = its.reduce((a, it) => a + it.amount, 0);
          if (have > 0) {
            const f = target / have;
            for (const it of its) { it.amount *= f; it.label = label; it.source = 'Your forecast'; it.meta = { ...(it.meta || {}), method: `You set online sales for the month to ${money0(e.amount)}; the daily pattern follows last year` }; }
          } else if (target > 0) {
            const days = []; for (let i = 1; i <= input.horizonDays; i++) if (monthKey(addDays(today, i)) === mk) days.push(addDays(today, i));
            for (const d of days) push('online', d, target / days.length, label, 'Your forecast', 'assumption', { method: `You set online sales for the month to ${money0(e.amount)}, spread evenly` });
          }
        }
      }
      for (let i = items.length - 1; i >= 0; i--) if (items[i].line === 'online' && !(items[i].amount > 0)) items.splice(i, 1);
    }

    // -- Stock: Xero bills (converted to AUD) and Apparel Magic purchase orders
    for (const b of input.ap || []) {
      if (!(b.amountDueAud > 0)) continue;
      const overdue = b.dueDate < today;
      const pid = 'ap:' + b.id;
      const manualDate = input.payDates && input.payDates[pid];
      // A bill overdue by far more than any normal delay is almost certainly a leftover (a duplicate, or settled
      // outside Xero), so it isn't forecast as a payment next week — it's listed as left out, and setting a payment
      // date on it brings it back in.
      if (overdue && !manualDate && daysBetween(b.dueDate, today) > settings.staleBillDays) {
        notes.excluded.push({ kind: `bill overdue by more than ${settings.staleBillDays} days (left out as stale — set a payment date on it to include it)`, label: b.contact, amount: b.amountDueAud, doc: b.number, due: b.dueDate });
        continue;
      }
      const pay = manualDate || (overdue ? addDays(today, settings.apOverduePayDays) : b.dueDate);
      push(TAX_CONTACT_RE.test(b.contact) ? 'bas' : 'stock', pay < tomorrow ? tomorrow : pay, b.amountDueAud, b.contact, 'Xero', 'confirmed', { doc: b.number, due: b.dueDate, overdue, currency: b.currency, pid, manualDate: !!manualDate });
    }
    for (const p of input.amPOs || []) {
      // AM amounts are in the PO's own currency: convert USD at the setting, other currencies
      // at a Xero rate if there is one, otherwise say so rather than guess.
      const rate = !p.cur || p.cur === 'AUD' ? 1 : p.cur === 'USD' ? settings.usdPerAud : (input.fx && input.fx[p.cur]) || null;
      const amountAud = p.amountAud !== undefined ? p.amountAud : (rate ? p.amount / rate : 0);
      if (!(amountAud > 0)) { if (p.amount > 0) notes.excluded.push({ kind: 'PO with no exchange rate', label: p.vendor, amount: p.amount, currency: p.cur }); continue; }
      // A PO whose ex-factory date has passed is (almost always) already shipped and billed —
      // Xero holds that bill — so counting it too would double-count the same money.
      if (p.due && p.due < today) { notes.excluded.push({ kind: 'PO past its ex-factory date (assumed billed in Xero)', label: p.vendor, amount: amountAud }); continue; }
      const key = String(p.po || p.id).toLowerCase();
      const billed = p.duplicateOfBill || (input.ap || []).some((b) => (key.length >= 4 && `${b.number} ${b.reference}`.toLowerCase().includes(key))
        || (String(b.contact).toUpperCase() === String(p.vendor).toUpperCase() && Math.abs(b.amountDueAud - amountAud) / amountAud < 0.02));
      if (billed) { notes.excluded.push({ kind: 'PO already billed in Xero', label: p.vendor, amount: amountAud }); continue; }
      const p2 = { ...p, amountAud };
      const pid = 'po:' + p.id;
      const manualDate = input.payDates && input.payDates[pid];
      const pay = manualDate || addDays(p2.due || addDays(today, 30), settings.poTermsDays);
      push('stock', pay < tomorrow ? tomorrow : pay, p2.amountAud, p.vendor, 'Apparel Magic', 'confirmed', { doc: p.po || p.id, due: p.due, pid, manualDate: !!manualDate, currency: p.cur });
    }

    // -- Stock we haven't been billed for yet. Known bills / POs only cover the
    // next few weeks, so beyond them "stock payments" would fall to zero and the
    // forecast would flatter cash. Each week is topped up to the recent average
    // weekly supplier payments: weeks where the known bills/POs already exceed
    // that average keep the (higher) known amount, so nothing is counted twice.
    const h = input.history || {};
    if (h.stockPerWeek > 0) {
      for (let w = 0; ; w++) {
        const start = addDays(today, 1 + w * 7);
        if (daysBetween(today, start) > input.horizonDays) break;
        const days = [];
        for (let k = 0; k < 7; k++) { const d = addDays(start, k); if (daysBetween(today, d) <= input.horizonDays && !inLy('stock', d)) days.push(d); }
        if (!days.length) continue;
        const target = h.stockPerWeek * (days.length / 7);
        const known = items.filter((it) => it.line === 'stock' && it.date >= days[0] && it.date <= days[days.length - 1]).reduce((a, it) => a + it.amount, 0);
        const gap = target - known;
        if (gap > 0) for (const d of days) push('stock', d, gap / days.length, 'Typical supplier payments (not yet billed)', 'Xero', 'assumption', { method: 'Average weekly supplier payments, last 13 weeks; known bills & POs count toward it' });
      }
    }

    // -- Run-rate operating spend from Xero history (wages, rent, tax, cards…)
    const outMul = 1 + (sc.out || 0) / 100;
    if (h.marketingPerWeek > 0) for (let i = 1; i <= input.horizonDays; i++) if (!inLy('marketing', addDays(today, i))) push('marketing', addDays(today, i), (h.marketingPerWeek / 7) * outMul, 'Recent marketing spend', 'Xero', 'assumption', { method: 'Xero card/bank spend, last 13 weeks' });
    if (h.otherOutPerWeek > 0) for (let i = 1; i <= input.horizonDays; i++) if (!inLy('otherOut', addDays(today, i))) push('otherOut', addDays(today, i), (h.otherOutPerWeek / 7) * outMul, 'Recent operating spend', 'Xero', 'assumption', { method: 'Xero cash spent less bills, marketing & transfers, last 13 weeks' });

    // -- Last year's pattern: for each planned month, the plan is last year's same month x (1 + the scenario %).
    // Anything already known for that line and month (open invoices and orders, bills and POs, ATO bills) counts
    // towards it, so only the shortfall is added — spread evenly over the month — and nothing is counted twice.
    // A month where the known amounts already exceed the plan keeps the known amounts.
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthLabel = (mk) => `${MON[Number(mk.slice(5)) - 1]} ${mk.slice(2, 4)}`;
    notes.lastYear = {};
    for (const line of Object.keys(LY_LINES)) {
      // A typed wholesale $ amount for a month last year can't cover (or with "start from last year" off) still plans that month.
      const extra = [];
      if (line === 'wholesale') for (let k = 1; k <= 11; k++) { const mk = addMonths(m0, k), e = planFor('wholesale', mk); if (e && e.amount !== undefined && !lyMonths.wholesale.has(mk)) extra.push(mk); }
      if (!lyMonths[line].size && !extra.length) continue;
      notes.lastYear[line] = [...lyMonths[line]].sort();
      const pct = sc[LINE_PCT_KEY[line]] || 0;
      for (const mk of [...notes.lastYear[line], ...extra].sort()) {
        const lyMk = addMonths(mk, -12);
        const lyVal = ly && ly[lyMk] && Number.isFinite(ly[lyMk][line]) ? ly[lyMk][line] : null;
        const typed = line === 'wholesale' ? planFor('wholesale', mk) : null;
        const known = items.filter((it) => it.line === line && monthKey(it.date) === mk).reduce((a, it) => a + it.amount, 0);
        const nDays = Number(lastDayOfMonth(mk + '-01').slice(8));
        const sgn = (p) => `${p >= 0 ? '+' : '−'}${Math.abs(p)}%`;
        const fac = (p) => `(1 ${p >= 0 ? '+' : '−'} ${Math.abs(p)}%)`;
        let plan, label, method;
        if (typed) {
          // The user's own wholesale figure for this month — the base case is exactly that (more only if invoices and orders
          // already in Xero / Apparel Magic come to more, because those are real).
          const r = rel('wholesale');
          const caseNote = Math.abs(r - 1) > 1e-9 ? ` × (1 ${r >= 1 ? '+' : '−'} ${Math.abs(Math.round((r - 1) * 1000) / 10)}%) for this case` : '';
          if (typed.amount !== undefined) {
            plan = typed.amount * r;
            label = `Your forecast (${money0(typed.amount)} for the month)`;
            method = `You set wholesale collections for ${monthLabel(mk)} to ${money0(typed.amount)}${caseNote}, less ${money0(known)} already invoiced or ordered`;
          } else {
            if (lyVal === null) { notes.salesPlanSkipped.push({ line, month: mk, reason: 'no last year to apply the % to' }); continue; }
            plan = lyVal * (1 + typed.pct / 100) * r;
            label = `Your forecast (${pctTxt(typed.pct)} on last year)`;
            method = `Last year's ${monthLabel(lyMk)} wholesale ${money0(lyVal)} × (1 ${typed.pct >= 0 ? '+' : '−'} ${Math.abs(typed.pct)}%)${caseNote} = ${money0(plan)}, less ${money0(known)} already invoiced or ordered`;
          }
        } else {
          if (lyVal === null) continue;
          const g = Number(growth[line] && growth[line][mk]);
          const mPct = Number.isFinite(g) ? Math.max(-100, g) : 0;
          plan = lyVal * (1 + mPct / 100) * (1 + pct / 100);
          // The month's own growth % comes first, and the Worst / Base / Best % is applied on top of it.
          label = mPct === 0 ? `Last year's ${monthLabel(lyMk)} pattern (${sgn(pct)})` : `Last year's ${monthLabel(lyMk)} pattern (${sgn(mPct)} month${pct !== 0 ? `, ${sgn(pct)} case` : ''})`;
          const factors = mPct === 0 ? `x ${fac(pct)}` : `x ${fac(mPct)} for the month x ${fac(pct)} case`;
          method = `Last year's ${monthLabel(lyMk)} ${LINE_LABELS[line].toLowerCase()} ${factors} = ${Math.round(plan).toLocaleString('en-AU')}, less ${Math.round(known).toLocaleString('en-AU')} already known`;
        }
        const gap = plan - known;
        if (!(gap > 0)) continue;
        for (let day = 1; day <= nDays; day++) {
          push(line, `${mk}-${String(day).padStart(2, '0')}`, gap / nDays, label, typed ? 'Your forecast' : 'Last year', 'assumption', { method });
        }
      }
    }
    // a typed wholesale % can't be applied to a month with no last-year figure to apply it to
    for (let k = 1; k <= 11; k++) {
      const mk = addMonths(m0, k), e = planFor('wholesale', mk);
      if (e && e.pct !== undefined && !lyMonths.wholesale.has(mk) && !notes.salesPlanSkipped.some((s) => s.line === 'wholesale' && s.month === mk)) notes.salesPlanSkipped.push({ line: 'wholesale', month: mk, reason: 'no last year to apply the % to' });
    }

    // -- BAS: the monthly GST + PAYG payment to the ATO. Xero records it as a bill to "ATO" at the moment it is paid, so
    // an open ATO bill is the only known BAS; every other month is estimated:
    //   PAYG = the last 3 months' PAYG (grown with operating costs), and
    //   GST  = a share of LAST month's online + wholesale receipts — the share the GST payment has been over the current run
    //          of monthly BAS payments (GST follows sales, so a big sales month is followed by a big BAS). With too little
    //          monthly history it falls back to the 12-month average GST scaled by last month's receipts against average.
    // Paid on the BAS pay day. A month that already has an ATO bill (paid or open) gets no estimate — the real bill
    // replaces it. This is the least certain line in the forecast and is labelled that way.
    const bas = input.bas;
    if (bas && ((bas.gstMonthlyAvg || 0) > 0 || (bas.paygMonthly || 0) > 0)) {
      const known = new Set(bas.billMonths || []);
      for (const it of items) if (it.line === 'bas') known.add(monthKey(it.date));
      const receipts = (mk) => (bas.recByMonth && Number.isFinite(bas.recByMonth[mk]) ? bas.recByMonth[mk] : 0)
        + items.filter((it) => (it.line === 'online' || it.line === 'wholesale') && monthKey(it.date) === mk).reduce((a, it) => a + it.amount, 0);
      const scale = (mk) => (bas.recMonthAvg > 0 ? clamp(receipts(addMonths(mk, -1)) / bas.recMonthAvg, 0.5, 1.8) : 1);
      const growthOut = 1 + (sc.out || 0) / 100;
      const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      notes.bas = [];
      for (let k = 0; k <= 11; k++) {
        const mk = addMonths(m0, k);
        if (known.has(mk)) continue;
        let date = monthDayIso(mk, settings.basPayDay);
        if (date < tomorrow) { if (k === 0) date = tomorrow; else continue; }   // this month's BAS isn't recorded yet and its day has passed: assume it is imminent
        const prev = MONS[Number(addMonths(mk, -1).slice(5)) - 1];
        const prevReceipts = receipts(addMonths(mk, -1));
        const payg = (bas.paygMonthly || 0) * growthOut;
        const n0 = (x) => Math.round(x).toLocaleString('en-AU');
        let gst, f = null, how;
        if (bas.gstRatio > 0 && prevReceipts > 0) {
          gst = bas.gstRatio * prevReceipts;
          how = `GST ${n0(gst)} (${(bas.gstRatio * 100).toFixed(1)}% of ${prev} sales receipts of ${n0(prevReceipts)}, as in your recent monthly BAS payments)`;
        } else {
          f = scale(mk);
          gst = (bas.gstMonthlyAvg || 0) * f;
          how = `GST ${n0(gst)} (12-month average × ${f.toFixed(2)} for ${prev} sales)`;
        }
        push('bas', date, gst + payg, 'BAS (estimate)', 'Estimate', 'assumption',
          { gst, payg, scale: f, method: `PAYG ${n0(payg)} (recent monthly average) + ${how}` });
        notes.bas.push({ month: mk, date, gst, payg, scale: f });
      }
    }

    // -- Manual adjustments: one-off receipts / payments entered by the user (a planned Lumi drawdown or repayment is
    // just one of these). They sit on their own lines, so they never reduce an estimate or replace anything: they are
    // added on top, on the date entered.
    for (const a of input.adjustments || []) {
      const amt = Number(a.amount);
      if (!(amt > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(a.date || '') || (a.dir !== 'in' && a.dir !== 'out')) continue;
      if (a.date < tomorrow) { notes.excluded.push({ kind: 'manual adjustment dated today or earlier (not counted)', label: a.desc || 'Manual adjustment', amount: amt }); continue; }
      push(a.dir === 'in' ? 'manualIn' : 'manualOut', a.date, amt, a.desc || 'Manual adjustment', 'Manual', 'confirmed', { category: a.category || '', adjId: a.id });
    }

    return { items, notes };
  }

  // ------------------------------------------------------ credit-card timing
  const monthDayIso = (mk, day) => { const last = Number(lastDayOfMonth(mk + '-01').slice(8)); return `${mk}-${String(Math.min(Math.max(1, Math.round(day)), last)).padStart(2, '0')}`; };
  const dueForClose = (closeIso, t) => monthDayIso(addMonths(monthKey(closeIso), t.dueMonthOffset), t.dueDay);

  // Each card accrues its share of the forecast marketing / other spend, a statement is struck on the
  // close day (everything owed at that moment, less any earlier statement still unpaid), and that
  // statement leaves the bank on its due date. The statement already closed today is worked out from
  // the balance owed less the charges since it closed. Mutates flows / items; returns nothing.
  function scheduleCards(input, settings, flows, items, H) {
    const { today } = input;
    const tomorrow = addDays(today, 1);
    for (const card of input.cards || []) {
      const t = (settings.cardTerms && settings.cardTerms[card.last4]) || settings.cardDefault;
      const label = `${card.name}${card.last4 ? ' ···' + card.last4 : ''}`;
      const charges = new Array(H + 1).fill(0);
      for (const line of ['marketing', 'otherOut']) {
        const share = (input.cardShares && input.cardShares[line] && input.cardShares[line][card.id]) || 0;
        if (share > 0) for (let i = 1; i <= H; i++) charges[i] += flows[line][i] * share;
      }
      const m0 = monthKey(today);
      const closes = [];
      for (let k = -3; k <= 13; k++) closes.push(monthDayIso(addMonths(m0, k), t.closeDay));
      const pastCloses = closes.filter((c) => c <= today);
      const L = pastCloses[pastCloses.length - 1];
      const owed0 = Math.max(0, card.owed || 0);
      const since = (card.recentCharges || []).filter((c) => c.date > L && c.date <= today).reduce((a, c) => a + c.amount, 0);
      const stmt0 = Math.max(0, owed0 - since);
      const sched = []; // { date, amount, close, due, status, overdue }
      const payDateFor = (close, due, fallback) => (input.payDates && input.payDates[`card:${card.id}:${close}`]) || fallback || due;
      if (stmt0 > 0.5) {
        const due0 = dueForClose(L, t);
        const overdue = due0 <= today;
        let d = payDateFor(L, due0, overdue ? addDays(today, settings.apOverduePayDays) : due0);
        if (d < tomorrow) d = tomorrow;
        sched.push({ date: d, amount: stmt0, close: L, due: due0, status: 'confirmed', overdue, paid: false });
      }
      let owed = owed0;
      for (let i = 1; i <= H; i++) {
        const d = addDays(today, i);
        owed += charges[i];
        if (charges[i] > 0) { flows.cardCredit[i] -= charges[i]; items.push({ line: 'cardCredit', date: d, amount: -charges[i], label: `Charged to ${label} (paid on statement due date)`, source: 'Xero', status: 'assumption' }); }
        if (closes.includes(d)) {
          const pending = sched.filter((p) => !p.paid).reduce((a, p) => a + p.amount, 0);
          const amount = owed - pending;
          if (amount > 0.5) {
            const due = dueForClose(d, t);
            let pd = payDateFor(d, due);
            if (pd <= d) pd = addDays(d, 1);
            sched.push({ date: pd, amount, close: d, due, status: 'assumption', overdue: false, paid: false });
          }
        }
        for (const p of sched) {
          if (p.paid || p.date !== d) continue;
          p.paid = true; owed -= p.amount;
          flows.cards[i] += p.amount;
          items.push({ line: 'cards', date: d, amount: p.amount, label: label, source: 'Xero', status: p.status, meta: { doc: `statement closing ${fmtDate(p.close)}`, due: p.due, overdue: p.overdue, pid: `card:${card.id}:${p.close}`, manualDate: !!(input.payDates && input.payDates[`card:${card.id}:${p.close}`]), card: card.id } });
        }
      }
    }
  }

  // -------------------------------------------------------------- scenarios
  function computeScenario(input, settings, name) {
    const sc = settings.scenarios[name];
    const { items, notes } = buildItems(input, settings, sc);
    const H = input.horizonDays;
    const dates = [];
    for (let i = 0; i <= H; i++) dates.push(addDays(input.today, i));
    const idx = {}; dates.forEach((d, i) => { idx[d] = i; });
    const flows = {}; for (const l of LINES) flows[l] = new Array(H + 1).fill(0);
    const sysFlows = {}; for (const l of LINES) sysFlows[l] = new Array(H + 1).fill(0);
    for (const it of items) { const i = idx[it.date]; if (i !== undefined) { flows[it.line][i] += it.amount; sysFlows[it.line][i] += it.amount; } }

    // Manual overrides replace a line's forecast for a whole calendar month
    // (the days from tomorrow for the current month). The scenario % still
    // applies around the manual number; the month's day-shape follows the system
    // forecast when there is one, otherwise it's spread evenly.
    const overridden = {}; // line -> month -> { value, system }
    for (const line of LINES) {
      const months = (input.overrides && input.overrides[line]) || {};
      const pctKey = LINE_PCT_KEY[line];
      const mul = pctKey ? 1 + (sc[pctKey] || 0) / 100 : 1;
      for (const [mk, raw] of Object.entries(months)) {
        if (raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw))) continue;
        const target = Number(raw) * mul;
        const dayIdx = []; dates.forEach((d, i) => { if (i > 0 && monthKey(d) === mk) dayIdx.push(i); });
        if (!dayIdx.length) continue;
        const sys = dayIdx.reduce((a, i) => a + flows[line][i], 0);
        for (const i of dayIdx) flows[line][i] = sys > 0 ? (flows[line][i] / sys) * target : target / dayIdx.length;
        (overridden[line] = overridden[line] || {})[mk] = { value: Number(raw), system: sys };
      }
    }

    scheduleCards(input, settings, flows, items, H);

    const balance = new Array(H + 1).fill(0);
    balance[0] = input.cashToday;
    const inflow = new Array(H + 1).fill(0), outflow = new Array(H + 1).fill(0);
    for (let i = 1; i <= H; i++) {
      inflow[i] = LINES_IN.reduce((a, l) => a + flows[l][i], 0);
      outflow[i] = LINES_OUT.reduce((a, l) => a + flows[l][i], 0);
      balance[i] = balance[i - 1] + inflow[i] - outflow[i];
    }
    return { name, dates, idx, flows, sysFlows, balance, inflow, outflow, items, notes, overridden };
  }

  // Horizon: enough days to cover 12 calendar months from the current one.
  function horizonFor(today) { return daysBetween(today, lastDayOfMonth(addMonths(monthKey(today), 11) + '-01')); }

  function buildForecast(input) {
    const settings = mergeSettings(input.settings);
    const horizonDays = horizonFor(input.today);
    const full = { ...input, horizonDays };
    const conv = settings.onlineConversion !== null && Number.isFinite(settings.onlineConversion)
      ? settings.onlineConversion / (settings.onlineConversion > 1.5 ? 100 : 1)
      : (input.history && input.history.conversion) || 0.97;
    full.conversion = conv;
    if (input.shopify && input.shopify.daily) {
      // a typed online % is a growth target on last year's same month, which is exactly what the Shopify forecast takes
      const targets = { ...(input.onlineTargets || {}) };
      for (const mk of Object.keys((input.salesPlan && input.salesPlan.online) || {})) { const e = salesPlanEntry(input.salesPlan, 'online', mk); if (e && e.pct !== undefined) targets[mk] = e.pct; }
      full.shopifyFc = shopifyForecast(input.shopify.daily, input.today, horizonDays, targets);
    }
    const scenarios = {};
    for (const n of ['worst', 'base', 'best']) scenarios[n] = computeScenario(full, settings, n);
    return { today: input.today, cashToday: input.cashToday, horizonDays, settings, conversion: conv, shopifyFc: full.shopifyFc || null, scenarios, input: full };
  }

  // ---------------------------------------------------------------- buckets
  // view: 'weeks13' | 'months6' | 'months12'. Weekly buckets are rolling 7-day
  // periods from tomorrow; monthly buckets are calendar months (the first one
  // is the rest of this month).
  function buckets(result, view) {
    const today = result.today;
    const list = [];
    if (view === 'weeks13') {
      for (let w = 0; w < 13; w++) list.push({ start: addDays(today, w * 7 + 1), end: addDays(today, w * 7 + 7), label: '' });
    } else {
      const n = view === 'months6' ? 6 : 12;
      const m0 = monthKey(today);
      for (let m = 0; m < n; m++) {
        const mk = addMonths(m0, m);
        const start = m === 0 ? addDays(today, 1) : mk + '-01';
        list.push({ start, end: lastDayOfMonth(mk + '-01'), label: mk, month: mk });
      }
    }
    const out = [];
    for (const b of list) {
      if (b.start > b.end) continue;
      const byScenario = {};
      for (const [name, s] of Object.entries(result.scenarios)) {
        const row = { closing: 0 };
        for (const l of LINES) row[l] = 0;
        for (let d = b.start; d <= b.end; d = addDays(d, 1)) {
          const i = s.idx[d];
          if (i === undefined) continue;
          for (const l of LINES) row[l] += s.flows[l][i];
        }
        row.in = LINES_IN.reduce((a, l) => a + row[l], 0);
        row.out = LINES_OUT.reduce((a, l) => a + row[l], 0);
        row.net = row.in - row.out;
        const ei = s.idx[b.end] !== undefined ? s.idx[b.end] : s.dates.length - 1;
        row.closing = s.balance[ei];
        byScenario[name] = row;
      }
      out.push({ ...b, byScenario });
    }
    return out;
  }

  function rangeSum(result, scn, lines, startIso, endIso) {
    const s = result.scenarios[scn];
    let t = 0;
    for (let d = startIso; d <= endIso; d = addDays(d, 1)) { const i = s.idx[d]; if (i !== undefined) for (const l of lines) t += s.flows[l][i]; }
    return t;
  }

  function kpis(result, scn, view) {
    const s = result.scenarios[scn];
    const end30 = addDays(result.today, 30);
    const inLast = rangeSum(result, scn, LINES_IN, addDays(result.today, 1), end30);
    const outLast = rangeSum(result, scn, LINES_OUT, addDays(result.today, 1), end30);
    const bk = buckets(result, view);
    const endDate = bk.length ? bk[bk.length - 1].end : end30;
    let lowest = { value: Infinity, date: null };
    for (let i = 1; i < s.dates.length; i++) {
      if (s.dates[i] > endDate) break;
      if (s.balance[i] < lowest.value) lowest = { value: s.balance[i], date: s.dates[i] };
    }
    if (lowest.date === null) lowest = { value: result.cashToday, date: result.today };
    const i30 = s.idx[end30];
    return { cashToday: result.cashToday, in30: inLast, out30: outLast, position30: s.balance[i30], lowest, ending: s.balance[s.idx[endDate]], endDate };
  }

  // ------------------------------------------------------------ explanation
  // Everything behind one forecast number: the range's total for a line in a
  // scenario, split into the manual override (if any) and the system items,
  // grouped by customer / supplier / method with their source.
  function explain(result, scn, line, startIso, endIso) {
    const s = result.scenarios[scn];
    let total = 0, manualPortion = 0;
    const manualMonths = new Set();
    for (let d = startIso; d <= endIso; d = addDays(d, 1)) {
      const i = s.idx[d];
      if (i === undefined || i === 0) continue;
      const v = s.flows[line][i];
      total += v;
      const ov = s.overridden[line] && s.overridden[line][monthKey(d)];
      if (ov) { manualPortion += v; manualMonths.add(monthKey(d)); }
    }
    let systemInRange = 0;
    const groups = new Map();
    for (const it of s.items) {
      if (it.line !== line || it.date < startIso || it.date > endIso) continue;
      systemInRange += it.amount;
      if (s.overridden[line] && s.overridden[line][monthKey(it.date)]) continue; // replaced by the manual number
      // Bills and POs are listed one by one (each has its own payment date the
      // user can change); everything else is grouped by customer / supplier.
      const pid = it.meta && it.meta.pid;
      const key = `${it.source}|${it.label}|${pid || ''}`;
      const g = groups.get(key) || { label: it.label, source: it.source, status: it.status, amount: 0, count: 0, docs: [], method: it.meta && it.meta.method, pid, date: it.date, manualDate: !!(it.meta && it.meta.manualDate), overdue: !!(it.meta && it.meta.overdue) };
      g.amount += it.amount; g.count++;
      if (it.meta && it.meta.doc && g.docs.length < 4) g.docs.push(it.meta.doc);
      groups.set(key, g);
    }
    const rows = [...groups.values()].sort((a, b) => b.amount - a.amount);
    if (manualPortion > 0) rows.unshift({ label: `Manual override (${[...manualMonths].join(', ')})`, source: 'Manual', status: 'assumption', amount: manualPortion, count: 1, docs: [] });
    const bySource = {};
    for (const r of rows) bySource[r.source] = (bySource[r.source] || 0) + r.amount;
    return { total, systemTotal: systemInRange, manual: manualPortion, rows, bySource, replaced: manualPortion > 0 ? systemInRange : 0 };
  }

  // What each source contributes to a forecast month for a line (the inputs grid).
  function monthCell(result, scn, line, mk) {
    const s = result.scenarios[scn];
    const days = s.dates.filter((d, i) => i > 0 && monthKey(d) === mk);
    if (!days.length) return null;
    const range = [days[0], days[days.length - 1]];
    const ov = s.overridden[line] && s.overridden[line][mk];
    let systemAtBase = 0;
    // "system" value shown next to an override is the un-overridden total of the same scenario
    for (const it of s.items) if (it.line === line && it.date >= range[0] && it.date <= range[1]) systemAtBase += it.amount;
    const sources = {};
    for (const it of s.items) if (it.line === line && it.date >= range[0] && it.date <= range[1]) sources[it.source] = (sources[it.source] || 0) + it.amount;
    const value = days.reduce((a, d) => a + s.flows[line][s.idx[d]], 0);
    return { month: mk, value, system: systemAtBase, manual: ov ? ov.value : null, source: ov ? 'Manual' : (Object.entries(sources).sort((a, b) => b[1] - a[1])[0] || [null])[0], sources, partial: mk === monthKey(result.today) };
  }

  // What the Sales forecast card shows for one month of online or wholesale: last year's figure, what the forecast now has
  // for the month (base case), how much of that is already known (invoices / orders), what was typed, and the % the
  // forecast works out to against last year. null for a month outside the forecast. Wholesale for the current month is
  // not editable (known invoices dominate the rest of the month).
  function salesPlanCell(result, line, mk) {
    const cell = monthCell(result, 'base', line, mk);
    if (!cell) return null;
    const s = result.scenarios.base;
    const days = s.dates.filter((d, i) => i > 0 && monthKey(d) === mk);
    const known = s.items.filter((it) => it.line === line && it.status === 'confirmed' && it.date >= days[0] && it.date <= days[days.length - 1]).reduce((a, it) => a + it.amount, 0);
    const lyRow = result.input.lastYear && result.input.lastYear[addMonths(mk, -12)];
    const basis = line === 'online' ? (s.notes.onlineBasis && s.notes.onlineBasis[mk] !== undefined ? s.notes.onlineBasis[mk] : null) : (lyRow && Number.isFinite(lyRow.wholesale) ? lyRow.wholesale : null);
    const entry = salesPlanEntry(result.input.salesPlan, line, mk);
    const skipped = (s.notes.salesPlanSkipped || []).find((x) => x.line === line && x.month === mk) || null;
    const editable = line === 'online' ? true : mk !== monthKey(result.today);
    return { month: mk, line, forecast: cell.value, known, basis, entry, skipped, editable, partial: cell.partial,
      forecastPct: basis > 0 ? (cell.value / basis - 1) * 100 : null, defaultPct: result.settings.scenarios.base[line] || 0 };
  }

  // ------------------------------------------------------------------ watch
  function watch(result, extra) {
    const w = [];
    const base = result.scenarios.base, worst = result.scenarios.worst;
    const thr = result.settings.cashThreshold;
    const low = (s) => { let m = { v: Infinity, d: null }; for (let i = 1; i < s.dates.length && s.dates[i] <= addDays(result.today, 91); i++) if (s.balance[i] < m.v) m = { v: s.balance[i], d: s.dates[i] }; return m; };
    const lb = low(base), lw = low(worst);
    if (lb.d) w.push({ level: lb.v < thr ? 'warn' : 'info', kind: 'lowest', text: `Lowest forecast cash (13 weeks, base): ${money(lb.v)} on ${fmtDate(lb.d)}${lb.v < thr ? ` — below your ${money(thr)} threshold` : ''}` });
    if (lw.d && lw.v < thr && lb.v >= thr) w.push({ level: 'warn', kind: 'worst', text: `In the worst case cash falls to ${money(lw.v)} on ${fmtDate(lw.d)} (below ${money(thr)})` });
    const soon = base.items.filter((it) => it.line === 'stock' && it.date <= addDays(result.today, 30)).sort((a, b) => b.amount - a.amount)[0];
    if (soon && (soon.amount >= 50000 || soon.amount >= 0.15 * result.cashToday)) w.push({ level: 'warn', kind: 'supplier', text: `Large supplier payment approaching: ${money(soon.amount)} to ${soon.label} around ${fmtDate(soon.date)}` });
    const cardPay = base.items.filter((it) => it.line === 'cards' && it.date <= addDays(result.today, 30));
    if (cardPay.length) {
      const tot = cardPay.reduce((a, it) => a + it.amount, 0), first = cardPay.slice().sort((a, b) => (a.date < b.date ? -1 : 1))[0];
      w.push({ level: 'info', kind: 'amex', text: `Amex payments due in the next 30 days: ${money(tot)} (next: ${money(first.amount)} on ${fmtDate(first.date)}, ${first.label})` });
    }
    const ex = extra || {};
    if (ex.overdueAr && ex.overdueAr.total >= 25000) w.push({ level: 'info', kind: 'ar', text: `Overdue receivables: ${money(ex.overdueAr.total)} across ${ex.overdueAr.count} invoices` });
    if (ex.overdueAp && ex.overdueAp.total >= 10000) w.push({ level: 'info', kind: 'ap', text: `Overdue payables: ${money(ex.overdueAp.total)} across ${ex.overdueAp.count} bills — assumed paid within ${result.settings.apOverduePayDays} days; set a payment date on any bill under Cash out in the summary` });
    for (const n of ex.notes || []) w.push({ level: 'note', kind: 'data', text: n });
    return w;
  }

  // ------------------------------------------------------------ the dashboard's view of a forecast
  // The breakdown groups the engine's lines the way the dashboard shows them. Operating expenses are everything paid
  // from the bank for running the business: marketing + other cash out + the (negative) card credit, so spend that was
  // put on the Amex is not counted here but through the Amex payments, once.
  const GROUPS = {
    inflows: [
      { key: 'online', label: 'Online sales (Shopify, PayPal & other gateways)', short: 'Online sales', lines: ['online'] },
      { key: 'wholesale', label: 'Wholesale customer payments', short: 'Wholesale', lines: ['wholesale'] },
      { key: 'otherIn', label: 'Other income & manual receipts', short: 'Other income', lines: ['otherIn', 'manualIn'] },
    ],
    outflows: [
      { key: 'stock', label: 'Overseas stock suppliers', short: 'Stock suppliers', lines: ['stock'] },
      { key: 'cards', label: 'Amex card payments', short: 'Amex payments', lines: ['cards'] },
      { key: 'opex', label: 'Operating expenses', short: 'Operating expenses', lines: ['marketing', 'otherOut', 'cardCredit'] },
      { key: 'bas', label: 'BAS (GST + PAYG)', short: 'BAS', lines: ['bas'] },
      { key: 'other', label: 'Other scheduled payments (manual)', short: 'Other scheduled', lines: ['manualOut'] },
    ],
  };

  // One scenario's money in each group for a date range, split into what is already known (an invoice, bill, order,
  // statement or manual entry that exists) and what is estimated.
  function breakdown(result, scn, from, to) {
    const s = result.scenarios[scn];
    const row = (g) => {
      let amount = 0, known = 0, count = 0;
      for (let d = from; d <= to; d = addDays(d, 1)) { const i = s.idx[d]; if (i !== undefined && i > 0) for (const l of g.lines) amount += s.flows[l][i]; }
      for (const it of s.items) if (g.lines.includes(it.line) && it.date >= from && it.date <= to && it.status === 'confirmed' && !(s.overridden[it.line] && s.overridden[it.line][monthKey(it.date)])) { known += it.amount; count++; }
      known = Math.min(known, Math.max(amount, 0));
      return { key: g.key, label: g.label, short: g.short, amount, known, estimated: Math.max(0, amount - known), count };
    };
    const inflows = GROUPS.inflows.map(row), outflows = GROUPS.outflows.map(row);
    const totalIn = inflows.reduce((a, r) => a + r.amount, 0), totalOut = outflows.reduce((a, r) => a + r.amount, 0);
    return { from, to, inflows, outflows, totalIn, totalOut, net: totalIn - totalOut };
  }

  const levelOf = (v, st) => (v < st.minCash ? 'red' : v < st.cashThreshold ? 'amber' : 'green');
  const monthName = (mk) => new Date(mk + '-01T00:00:00Z').toLocaleDateString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  // Consecutive stretches of days (from tomorrow) when the balance is below a threshold.
  function belowRuns(s, threshold) {
    const runs = [];
    let cur = null;
    for (let i = 1; i < s.dates.length; i++) {
      const v = s.balance[i];
      if (v < threshold) {
        if (!cur) { cur = { from: s.dates[i], to: s.dates[i], low: { value: v, date: s.dates[i] } }; runs.push(cur); }
        else { cur.to = s.dates[i]; if (v < cur.low.value) cur.low = { value: v, date: s.dates[i] }; }
      } else cur = null;
    }
    const last = s.dates[s.dates.length - 1];
    for (const r of runs) { r.days = daysBetween(r.from, r.to) + 1; r.recoversOn = r.to < last ? addDays(r.to, 1) : null; }
    return runs;
  }

  // What left the bank in the weeks leading up to a date, biggest first — the "why" behind a low point.
  function drivers(result, scn, endDate, windowDays) {
    const s = result.scenarios[scn];
    const earliest = addDays(result.today, 1);
    const start = addDays(endDate, -windowDays + 1);
    const from = start < earliest ? earliest : start;
    const out = [];
    for (const g of GROUPS.outflows) {
      let amount = 0, count = 0;
      for (let d = from; d <= endDate; d = addDays(d, 1)) { const i = s.idx[d]; if (i !== undefined) for (const l of g.lines) amount += s.flows[l][i]; }
      for (const it of s.items) if (it.line !== 'cardCredit' && g.lines.includes(it.line) && it.date >= from && it.date <= endDate) count++;
      if (amount > 0) out.push({ key: g.key, label: g.label, short: g.short, amount, count });
    }
    let inflow = 0;
    for (let d = from; d <= endDate; d = addDays(d, 1)) { const i = s.idx[d]; if (i !== undefined) inflow += s.inflow[i]; }
    out.sort((a, b) => b.amount - a.amount);
    return { from, to: endDate, outflows: out, inflow };
  }

  // The answer to "when am I likely to be short of cash, and how much warning do I have?" for one scenario:
  // the four headline numbers, the green / amber / red stretches, and a few plain-English sentences (never more than three).
  function outlook(result, scn) {
    scn = scn || 'base';
    const s = result.scenarios[scn];
    const st = result.settings, today = result.today;
    const date = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', ...(iso.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}), timeZone: 'UTC' });
    const end90 = addDays(today, 90);
    let low90 = { value: Infinity, date: null }, tight = { value: Infinity, date: null };
    for (let i = 1; i < s.dates.length; i++) {
      const v = s.balance[i];
      if (s.dates[i] <= end90 && v < low90.value) low90 = { value: v, date: s.dates[i] };
      if (v < tight.value) tight = { value: v, date: s.dates[i] };
    }
    if (low90.date === null) low90 = { value: result.cashToday, date: today };
    if (tight.date === null) tight = { value: result.cashToday, date: today };
    const pos90 = s.balance[s.idx[end90] !== undefined ? s.idx[end90] : s.dates.length - 1];
    // The tightest period: the rolling week (first 13 weeks) or calendar month (after that) the lowest day falls in.
    const dd = daysBetween(today, tight.date);
    let tightest;
    if (dd >= 1 && dd <= 91) { const w = Math.floor((dd - 1) / 7); const start = addDays(today, w * 7 + 1); tightest = { kind: 'week', from: start, to: addDays(start, 6), label: `Week of ${date(start)}`, low: tight }; }
    else { const mk = monthKey(tight.date); tightest = { kind: 'month', from: mk + '-01', to: lastDayOfMonth(mk + '-01'), label: monthName(mk), low: tight }; }

    const red = belowRuns(s, st.minCash), amber = belowRuns(s, st.cashThreshold);
    const level = red.length ? 'red' : amber.length ? 'amber' : 'green';
    const todayLevel = levelOf(result.cashToday, st);
    const crossings = [];
    let prev = todayLevel;
    for (let i = 1; i < s.dates.length; i++) {
      const lv = levelOf(s.balance[i], st);
      if (lv !== prev) { crossings.push({ date: s.dates[i], from: prev, to: lv, value: s.balance[i] }); prev = lv; }
    }

    const messages = [];
    const topText = (d) => d.outflows.slice(0, 3).map((o) => `${o.short.toLowerCase()} ${money(o.amount)}`).join(', ');
    // "in the 4 weeks to X" — or the true, shorter window when the forecast hasn't been running that long
    const windowText = (d) => (d.from > addDays(d.to, -27) ? `Between ${date(d.from)} and ${date(d.to)}` : `In the 4 weeks to ${date(d.to)}`);
    const stayed = (r) => (r.recoversOn ? `for ${r.days} day${r.days === 1 ? '' : 's'}, back above it on ${date(r.recoversOn)}` : 'and does not recover within the forecast');
    if (red.length) {
      const r = red[0];
      const d = drivers(result, scn, r.low.date, 28);
      messages.push({ level: 'red', text: `Cash is forecast to fall below your ${money(st.minCash)} minimum on ${date(r.from)}, reaching ${money(r.low.value)} on ${date(r.low.date)}, and stays below it ${stayed(r)}.` });
      if (d.outflows.length) messages.push({ level: 'red', text: `${windowText(d)}, the biggest payments are ${topText(d)}; only ${money(d.inflow)} comes in over the same period.` });
      if (red.length > 1) messages.push({ level: 'red', text: `It happens again: ${red.length - 1} more stretch${red.length === 2 ? '' : 'es'} below ${money(st.minCash)}, the next from ${date(red[1].from)} (low ${money(red[1].low.value)}).` });
    } else if (amber.length) {
      const r = amber[0];
      const d = drivers(result, scn, r.low.date, 28);
      messages.push({ level: 'amber', text: `Cash dips below your ${money(st.cashThreshold)} comfortable level from ${date(r.from)}, with a low of ${money(r.low.value)} on ${date(r.low.date)} — still above your ${money(st.minCash)} minimum — ${stayed(r)}.` });
      if (d.outflows.length) messages.push({ level: 'amber', text: `${windowText(d)}, the biggest payments are ${topText(d)}; ${money(d.inflow)} comes in over the same period.` });
      if (amber.length > 1) messages.push({ level: 'amber', text: `${amber.length - 1} more stretch${amber.length === 2 ? '' : 'es'} below ${money(st.cashThreshold)} follow, the next from ${date(amber[1].from)}.` });
    } else {
      messages.push({ level: 'green', text: `Cash stays above your ${money(st.cashThreshold)} comfortable level for the whole forecast. The lowest point is ${money(tight.value)} on ${date(tight.date)}.` });
    }
    return {
      today, scenario: scn, minCash: st.minCash, comfortable: st.cashThreshold,
      cashToday: result.cashToday, todayLevel, level,
      lowest90: low90, position90: pos90, position90Date: end90, tightest,
      red, amber, crossings, messages,
      levelAt: (v) => levelOf(v, st),
    };
  }

  function money(n) { const a = Math.abs(Math.round(n)); return (n < 0 ? '-$' : '$') + a.toLocaleString('en-AU'); }
  function fmtDate(iso) { return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' }); }

  // Finds one account's balance in a Xero balance-sheet report (e.g. the Lumi loan): walks the
  // report rows for an account whose name matches, returns { name, balance } or null.
  function findLoanBalance(report, nameRe) {
    const rows = (report && report.Reports && report.Reports[0] && report.Reports[0].Rows) || [];
    const walk = (list) => {
      for (const row of list || []) {
        if (row.Rows) { const hit = walk(row.Rows); if (hit) return hit; }
        const cells = row.Cells || [];
        if (row.RowType === 'Row' && cells[0] && nameRe.test(String(cells[0].Value || ''))) {
          const n = parseFloat(String(cells[1] && cells[1].Value).replace(/[$,]/g, ''));
          if (Number.isFinite(n)) return { name: cells[0].Value, balance: n };
        }
      }
      return null;
    };
    return walk(rows);
  }

  const CFE = {
    LINES, LINES_IN, LINES_OUT, INPUT_LINES, LINE_LABELS, DEFAULT_SETTINGS,
    TAX_CONTACT_RE, findLoanBalance, mergeSettings, shopifyForecast, xeroOnlineForecast, buildForecast, buckets, kpis, explain, monthCell, salesPlanEntry, salesPlanCell, watch,
    GROUPS, breakdown, belowRuns, drivers, outlook,
    util: { addDays, daysBetween, monthKey, addMonths, lastDayOfMonth, toIso, toMs, round2, money, fmtDate },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CFE;
  else root.CFE = CFE;
})(typeof window !== 'undefined' ? window : globalThis);
