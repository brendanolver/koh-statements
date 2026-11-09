const { cashflowInputsStore } = require('./lib/blob-store');

// The Cashflow tab's saved manual inputs: monthly overrides per forecast line,
// scenario percentages, thresholds. One JSON document; last save wins. Server
// side (not localStorage) so the forecast assumptions follow across devices,
// same as the app's other saved settings.
const MAX_BYTES = 200 * 1024;
const LINES = ['online', 'wholesale', 'otherIn', 'stock', 'marketing', 'otherOut'];

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

// Keep only the shape the page understands — never store arbitrary blobs.
function sanitise(doc) {
  const out = { overrides: {}, settings: {}, updatedAt: new Date().toISOString() };
  const ov = doc && typeof doc.overrides === 'object' && doc.overrides ? doc.overrides : {};
  for (const line of LINES) {
    const months = ov[line];
    if (!months || typeof months !== 'object') continue;
    for (const [m, v] of Object.entries(months)) {
      const n = Number(v);
      if (/^\d{4}-\d{2}$/.test(m) && Number.isFinite(n)) (out.overrides[line] = out.overrides[line] || {})[m] = Math.round(n * 100) / 100;
    }
  }
  // Online growth targets vs last year, per month (YYYY-MM -> percent).
  const tg = doc && doc.targets && typeof doc.targets.online === 'object' && doc.targets.online ? doc.targets.online : {};
  const targets = Object.entries(tg).filter(([k, v]) => /^\d{4}-\d{2}$/.test(k) && v !== '' && v !== null && Number.isFinite(Number(v)) && Number(v) >= -100 && Number(v) <= 1000).map(([k, v]) => [k, Math.round(Number(v) * 10) / 10]);
  if (targets.length) out.targets = { online: Object.fromEntries(targets) };
  // Growth on last year for a single month, per line (line -> YYYY-MM -> percent). Feeds the plan-from-last-year layer.
  const gr = doc && doc.growth && typeof doc.growth === 'object' ? doc.growth : {};
  const growth = {};
  for (const line of ['wholesale', 'stock', 'marketing', 'otherOut']) {
    const months = gr[line];
    if (!months || typeof months !== 'object') continue;
    for (const [m, v] of Object.entries(months)) {
      if (!/^\d{4}-\d{2}$/.test(m) || (typeof v !== 'number' && typeof v !== 'string') || String(v).trim() === '') continue;
      const n = Number(v);
      if (Number.isFinite(n) && n >= -100 && n <= 1000) (growth[line] = growth[line] || {})[m] = Math.round(n * 100) / 100;
    }
  }
  if (Object.keys(growth).length) out.growth = growth;
  // The Sales forecast card: for online and wholesale, month by month, EITHER a % on last year OR a dollar amount for the
  // month (line -> YYYY-MM -> { pct } | { amount }). An amount wins if a month somehow has both.
  const spIn = doc && doc.salesPlan && typeof doc.salesPlan === 'object' ? doc.salesPlan : {};
  const salesPlan = {};
  for (const line of ['online', 'wholesale']) {
    const months = spIn[line];
    if (!months || typeof months !== 'object') continue;
    for (const [m, e] of Object.entries(months)) {
      if (!/^\d{4}-\d{2}$/.test(m) || !e || typeof e !== 'object') continue;
      const num = (v) => (v === undefined || v === null || v === '' || typeof v === 'boolean' ? NaN : Number(v));
      const amount = num(e.amount), pct = num(e.pct);
      if (Number.isFinite(amount) && amount >= 0 && amount <= 1e9) (salesPlan[line] = salesPlan[line] || {})[m] = { amount: Math.round(amount * 100) / 100 };
      else if (Number.isFinite(pct) && pct >= -100 && pct <= 1000) (salesPlan[line] = salesPlan[line] || {})[m] = { pct: Math.round(pct * 100) / 100 };
    }
  }
  if (Object.keys(salesPlan).length) out.salesPlan = salesPlan;
  // Expected payment date per bill / PO (id -> YYYY-MM-DD), capped so the document stays small.
  const pd = doc && typeof doc.payDates === 'object' && doc.payDates ? doc.payDates : {};
  const dates = Object.entries(pd).filter(([k, v]) => /^(ap|po|card):[\w:-]{1,120}$/.test(k) && /^\d{4}-\d{2}-\d{2}$/.test(String(v))).slice(0, 500);
  if (dates.length) out.payDates = Object.fromEntries(dates);
  const st = doc && typeof doc.settings === 'object' && doc.settings ? doc.settings : {};
  for (const k of ['defaultTermsDays', 'arLateDays', 'overdueCollectDays', 'apOverduePayDays', 'poTermsDays', 'usdPerAud', 'nzdPerAud', 'cashThreshold', 'onlineConversion', 'lumiLoanBalance', 'lumiLimit', 'minCash', 'staleBillDays', 'basPayDay', 'debtorDaysOverride', 'stockFollowsSales', 'marketingPctOfOnline', 'onlineGst', 'lyOn', 'lyWholesale', 'lyStock', 'lyMarketing', 'lyOtherOut']) {
    const n = Number(st[k]);
    if (st[k] !== undefined && st[k] !== null && st[k] !== '' && Number.isFinite(n)) out.settings[k] = n;
  }
  // The dashboard's one-off manual adjustments (a planned stock payment, a big customer receipt, a Lumi drawdown or
  // repayment…): description, amount (always positive), date, direction and an optional category. At most 100.
  const adj = Array.isArray(doc && doc.adjustments) ? doc.adjustments : [];
  const adjustments = [];
  for (const a of adj) {
    if (!a || typeof a !== 'object') continue;
    const amount = Number(a.amount), desc = String(a.desc == null ? '' : a.desc).trim().slice(0, 80);
    if (!Number.isFinite(amount) || !(amount > 0) || amount > 1e9 || !desc) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.date)) || (a.dir !== 'in' && a.dir !== 'out')) continue;
    const id = /^[\w-]{1,40}$/.test(String(a.id)) ? String(a.id) : `adj-${adjustments.length + 1}`;
    adjustments.push({ id, desc, amount: Math.round(amount * 100) / 100, date: String(a.date), dir: a.dir, category: String(a.category == null ? '' : a.category).trim().slice(0, 40) });
    if (adjustments.length >= 100) break;
  }
  if (adjustments.length) out.adjustments = adjustments;
  // Which Amex pays for what: line -> last 4 digits of a card, 'bank' (straight from the bank) or 'auto' (what the history shows).
  if (st.cardRoute && typeof st.cardRoute === 'object') {
    const route = {};
    for (const line of ['marketing', 'otherOut', 'bas']) { const v = st.cardRoute[line]; if (typeof v === 'string' && /^(\d{2,6}|bank|auto)$/.test(v)) route[line] = v; }
    if (Object.keys(route).length) out.settings.cardRoute = route;
  }
  if (st.cardTerms && typeof st.cardTerms === 'object') {
    out.settings.cardTerms = {};
    for (const [last4, t] of Object.entries(st.cardTerms).slice(0, 10)) {
      if (!/^\d{2,6}$/.test(last4) || !t || typeof t !== 'object') continue;
      const row = {};
      for (const k of ['closeDay', 'dueDay', 'dueMonthOffset']) { const n = Number(t[k]); if (t[k] !== undefined && t[k] !== '' && Number.isFinite(n)) row[k] = n; }
      if (Object.keys(row).length) out.settings.cardTerms[last4] = row;
    }
  }
  if (st.scenarios && typeof st.scenarios === 'object') {
    out.settings.scenarios = {};
    for (const s of ['worst', 'base', 'best']) {
      const src = st.scenarios[s];
      if (!src || typeof src !== 'object') continue;
      out.settings.scenarios[s] = {};
      for (const k of ['online', 'wholesale', 'stock', 'out', 'delay']) {
        const n = Number(src[k]);
        if (src[k] !== undefined && src[k] !== '' && Number.isFinite(n)) out.settings.scenarios[s][k] = n;
      }
    }
  }
  return out;
}

exports.handler = async (event) => {
  try {
    const store = cashflowInputsStore();
    if (event.httpMethod === 'GET') {
      const doc = (await store.get('inputs', { type: 'json', consistency: 'strong' })) || { overrides: {}, settings: {}, updatedAt: null };
      return json(200, doc);
    }
    if (event.httpMethod === 'POST') {
      if ((event.body || '').length > MAX_BYTES) return json(413, { error: 'Too large' });
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }
      const doc = sanitise(body);
      await store.setJSON('inputs', doc);
      return json(200, { ok: true, updatedAt: doc.updatedAt });
    }
    return json(405, { error: 'GET or POST only' });
  } catch (err) {
    return json(500, { error: err.message });
  }
};

exports._sanitise = sanitise;
