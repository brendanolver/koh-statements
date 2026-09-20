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

  const LINES_IN = ['online', 'wholesale', 'otherIn'];
  // 'cards' = Amex statement payments leaving the bank on their due dates; 'cardCredit' = the (negative)
  // card spend that is already inside Marketing / Other cash out but isn't paid until the statement
  // is due — so the Cash out total is what actually leaves the bank, and both lines reconcile.
  const LINES_OUT = ['stock', 'marketing', 'otherOut', 'cards', 'cardCredit'];
  const INPUT_LINES = ['online', 'wholesale', 'otherIn', 'stock', 'marketing', 'otherOut']; // the ones you can override monthly
  const LINES = [...LINES_IN, ...LINES_OUT];
  const LINE_LABELS = { online: 'Online sales', wholesale: 'Wholesale', otherIn: 'Other cash in', stock: 'Stock payments', marketing: 'Marketing', otherOut: 'Other cash out', cards: 'Amex payments', cardCredit: 'Charged to Amex (paid later)' };
  // Which scenario percentage moves which line (see DEFAULT_SETTINGS.scenarios).
  const LINE_PCT_KEY = { online: 'online', wholesale: 'wholesale', marketing: 'out', otherOut: 'out' };

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
    cashThreshold: 100000,    // "Cashflow Watch" warns when forecast cash drops below this
    onlineConversion: null,   // Shopify sales -> bank receipts; null = calibrate from Xero history
    scenarios: {
      // online / wholesale / out are % changes; delay is extra days customers take to pay.
      worst: { online: -15, wholesale: -10, out: 5, delay: 14 },
      base: { online: 0, wholesale: 0, out: 0, delay: 0 },
      best: { online: 15, wholesale: 5, out: -5, delay: -5 },
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

  // ------------------------------------------------------------ item building
  const isForeign = (cur) => cur && String(cur).toUpperCase() !== 'AUD';
  // Tax bills (BAS / PAYG) are cash out but not stock, so they go under "Other cash out".
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
      const expected = overdue ? addDays(today, settings.overdueCollectDays + delay) : addDays(inv.dueDate, settings.arLateDays + delay);
      push('wholesale', expected < tomorrow ? tomorrow : expected, amountAud, inv.contact, 'Xero', 'confirmed', { doc: inv.number, due: inv.dueDate, overdue, currency: isForeign(inv.currency) ? inv.currency : undefined });
    }

    // -- Wholesale: Apparel Magic open orders (confirmed, not yet invoiced)
    for (const o of input.amOrders || []) {
      const oRate = isForeign(o.cur) ? rateFor(o.cur) : 1;
      if (!oRate) { notes.excluded.push({ kind: 'order with no exchange rate', label: o.cn, amount: o.lines.reduce((a, l) => a + l.v, 0), currency: o.cur }); continue; }
      const terms = (input.termsByCustomer && input.termsByCustomer[(o.cn || '').toUpperCase()]) ?? settings.defaultTermsDays;
      for (const l of o.lines) {
        const ship = l.d < today ? addDays(today, settings.shipLateDays) : l.d;
        const receipt = addDays(ship, terms + settings.arLateDays + delay);
        push('wholesale', receipt, (l.v / oRate) * (1 + (o.gst || 0)) * (1 + (sc.wholesale || 0) / 100), o.cn, 'Apparel Magic', 'confirmed', { doc: o.po || o.id, ship, terms, order: o.id, currency: isForeign(o.cur) ? o.cur : undefined });
      }
    }

    // -- Online: Shopify sales (or Xero run-rate when Shopify isn't connected)
    const conv = input.conversion;
    if (input.shopifyFc && input.shopifyFc.hasData) {
      const ti = input.shopifyFc.targetInfo || {};
      for (const [d, v] of Object.entries(input.shopifyFc.perDay)) {
        const t = ti[monthKey(d)];
        const targeted = t && t.applied;
        push('online', d, v * conv * (1 + (sc.online || 0) / 100), targeted ? `Shopify forecast (${t.pct >= 0 ? '+' : ''}${t.pct}% target vs last year)` : 'Shopify forecast', 'Shopify', 'assumption',
          { method: targeted ? `last year's ${monthKey(addDays(d, -365))} sales × (1 ${t.pct >= 0 ? '+' : '−'} ${Math.abs(t.pct)}%)` : input.shopifyFc.method });
      }
    } else if (input.history && input.history.onlineReceiptsPerWeek > 0) {
      const perDay = input.history.onlineReceiptsPerWeek / 7;
      for (let i = 1; i <= input.horizonDays; i++) push('online', addDays(today, i), perDay * (1 + (sc.online || 0) / 100), 'Recent receipts run-rate', 'Xero', 'assumption', { method: 'Xero receipts, last 13 weeks' });
    }

    // -- Stock: Xero bills (converted to AUD) and Apparel Magic purchase orders
    for (const b of input.ap || []) {
      if (!(b.amountDueAud > 0)) continue;
      const overdue = b.dueDate < today;
      const pid = 'ap:' + b.id;
      const manualDate = input.payDates && input.payDates[pid];
      const pay = manualDate || (overdue ? addDays(today, settings.apOverduePayDays) : b.dueDate);
      push(TAX_CONTACT_RE.test(b.contact) ? 'otherOut' : 'stock', pay < tomorrow ? tomorrow : pay, b.amountDueAud, b.contact, 'Xero', 'confirmed', { doc: b.number, due: b.dueDate, overdue, currency: b.currency, pid, manualDate: !!manualDate });
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
        for (let k = 0; k < 7; k++) { const d = addDays(start, k); if (daysBetween(today, d) <= input.horizonDays) days.push(d); }
        const target = h.stockPerWeek * (days.length / 7);
        const known = items.filter((it) => it.line === 'stock' && it.date >= days[0] && it.date <= days[days.length - 1]).reduce((a, it) => a + it.amount, 0);
        const gap = target - known;
        if (gap > 0) for (const d of days) push('stock', d, gap / days.length, 'Typical supplier payments (not yet billed)', 'Xero', 'assumption', { method: 'Average weekly supplier payments, last 13 weeks; known bills & POs count toward it' });
      }
    }

    // -- Run-rate operating spend from Xero history (wages, rent, tax, cards…)
    const outMul = 1 + (sc.out || 0) / 100;
    if (h.marketingPerWeek > 0) for (let i = 1; i <= input.horizonDays; i++) push('marketing', addDays(today, i), (h.marketingPerWeek / 7) * outMul, 'Recent marketing spend', 'Xero', 'assumption', { method: 'Xero card/bank spend, last 13 weeks' });
    if (h.otherOutPerWeek > 0) for (let i = 1; i <= input.horizonDays; i++) push('otherOut', addDays(today, i), (h.otherOutPerWeek / 7) * outMul, 'Recent operating spend', 'Xero', 'assumption', { method: 'Xero cash spent less bills, marketing & transfers, last 13 weeks' });

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
    if (input.shopify && input.shopify.daily) full.shopifyFc = shopifyForecast(input.shopify.daily, input.today, horizonDays, input.onlineTargets);
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
    TAX_CONTACT_RE, findLoanBalance, mergeSettings, shopifyForecast, buildForecast, buckets, kpis, explain, monthCell, watch,
    util: { addDays, daysBetween, monthKey, addMonths, lastDayOfMonth, toIso, toMs, round2, money, fmtDate },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CFE;
  else root.CFE = CFE;
})(typeof window !== 'undefined' ? window : globalThis);
