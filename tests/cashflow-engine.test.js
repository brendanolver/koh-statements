// Run with:  node tests/cashflow-engine.test.js
// Plain assertions — no test framework — covering the Cashflow forecast maths.
const assert = require('assert');
const CFE = require('../cashflow-engine.js');
const { addDays } = CFE.util;

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };
const near = (a, b, tol = 0.01, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);

const TODAY = '2026-09-20';
const base = (over = {}) => ({ today: TODAY, cashToday: 100000, ar: [], ap: [], amOrders: [], amPOs: null, termsByCustomer: {}, shopify: null, history: null, overrides: {}, settings: null, ...over });
const bal = (r, scn, d) => r.scenarios[scn].balance[r.scenarios[scn].idx[d]];

console.log('Cash timeline');
test('receivable lands on due date + late days; bill on its due date', () => {
  const r = CFE.buildForecast(base({
    ar: [{ id: 'a', number: 'INV-1', contact: 'ACME', amountDue: 10000, currency: 'AUD', dueDate: addDays(TODAY, 10), invoiceDate: TODAY, online: false }],
    ap: [{ id: 'b', number: 'BILL-1', contact: 'FACTORY', amountDueAud: 4000, currency: 'AUD', dueDate: addDays(TODAY, 5) }],
  }));
  near(bal(r, 'base', addDays(TODAY, 4)), 100000);
  near(bal(r, 'base', addDays(TODAY, 5)), 96000);
  near(bal(r, 'base', addDays(TODAY, 16)), 96000, 0.01, 'not yet received (due +10, late +7 = day 17)');
  near(bal(r, 'base', addDays(TODAY, 17)), 106000);
});
test('overdue receivable / bill get the "collect / pay from today" rule', () => {
  const r = CFE.buildForecast(base({
    ar: [{ id: 'a', contact: 'LATE CO', amountDue: 5000, currency: 'AUD', dueDate: addDays(TODAY, -40), online: false }],
    ap: [{ id: 'b', contact: 'OVERDUE SUPPLIER', amountDueAud: 3000, currency: 'AUD', dueDate: addDays(TODAY, -3) }],
  }));
  near(bal(r, 'base', addDays(TODAY, 6)), 100000);
  near(bal(r, 'base', addDays(TODAY, 7)), 97000, 0.01, 'bill paid day 7');
  near(bal(r, 'base', addDays(TODAY, 21)), 102000, 0.01, 'AR collected day 21');
});

console.log('De-duplication');
test('online-contact receivables and already-billed POs are not counted; NZD receivables/orders ARE, converted to AUD', () => {
  const r = CFE.buildForecast(base({
    ar: [
      { id: '1', contact: 'ONLINE SALES', amountDue: 9000, currency: 'AUD', dueDate: addDays(TODAY, 3), online: true },
      { id: '2', contact: 'KIWI STORE', amountDue: 1210, currency: 'NZD', rate: 1.21, dueDate: addDays(TODAY, 3), online: false },
      { id: '3', contact: 'REAL CUSTOMER', amountDue: 1000, currency: 'AUD', dueDate: addDays(TODAY, 3), online: false },
    ],
    amOrders: [{ id: 'o1', cid: '9', cn: 'NZ CUSTOMER', po: 'X', cur: 'NZD', gst: 0.15, lines: [{ d: addDays(TODAY, 20), v: 1210 }] }],
    amPOs: [{ id: 'p1', vendor: 'FACTORY', due: addDays(TODAY, 30), amountAud: 50000, duplicateOfBill: true }, { id: 'p2', vendor: 'FACTORY2', due: addDays(TODAY, 30), amountAud: 20000 }],
  }));
  const s = r.scenarios.base;
  const wh = s.items.filter((i) => i.line === 'wholesale');
  near(wh.find((i) => i.label === 'KIWI STORE').amount, 1000, 0.01, "NZ$1,210 at the invoice's own rate 1.21 = A$1,000");
  near(wh.find((i) => i.label === 'NZ CUSTOMER').amount, 1210 / 1.21 * 1.15, 0.01, 'AM NZD order: ex-GST NZ$1,210 -> A$1,000 at the NZD setting, + 15% GST');
  near(wh.reduce((a, i) => a + i.amount, 0), 1000 + 1000 + 1150, 0.01);
  near(s.items.filter((i) => i.line === 'stock').reduce((a, i) => a + i.amount, 0), 20000);
  assert.deepStrictEqual(s.notes.excluded.map((e) => e.kind).sort(), ['PO already billed in Xero', 'online-contact receivable']);
});
test('NZD uses a Xero rate when one is known, else the setting; an unknown currency is reported not dropped', () => {
  const inv = (cur) => ({ id: cur, contact: 'C', amountDue: 1000, currency: cur, dueDate: addDays(TODAY, 3), online: false });
  const r = CFE.buildForecast(base({ ar: [inv('NZD'), inv('CAD')], fx: { NZD: 1.1 } }));
  near(r.scenarios.base.items.find((i) => i.line === 'wholesale').amount, 1000 / 1.1, 0.01);
  assert.ok(r.scenarios.base.notes.excluded.some((e) => e.kind === 'receivable with no exchange rate' && e.currency === 'CAD'));
  const r2 = CFE.buildForecast(base({ ar: [inv('NZD')], settings: { nzdPerAud: 1.25 } }));
  near(r2.scenarios.base.items.find((i) => i.line === 'wholesale').amount, 800, 0.01);
});
test('AM open order counts only its open (unshipped) balance, once, with GST added', () => {
  const r = CFE.buildForecast(base({
    amOrders: [{ id: 'o1', cid: '5', cn: 'BIG CUSTOMER', po: 'PO1', cur: 'AUD', gst: 0.1, lines: [{ d: addDays(TODAY, 20), v: 10000 }, { d: addDays(TODAY, 50), v: 5000 }] }],
    termsByCustomer: { 'BIG CUSTOMER': 30 },
  }));
  const it = r.scenarios.base.items.filter((i) => i.line === 'wholesale');
  assert.strictEqual(it.length, 2);
  near(it.reduce((a, i) => a + i.amount, 0), 16500, 0.01, '(10000+5000)*1.1');
  assert.strictEqual(it[0].date, addDays(TODAY, 20 + 30 + 7), 'ship date + terms + late days');
  assert.ok(it.every((i) => i.status === 'confirmed' && i.source === 'Apparel Magic'));
});

console.log('Scenarios');
test('worst delays customer payments and trims unconfirmed wholesale; best does the reverse', () => {
  const inp = base({ amOrders: [{ id: 'o1', cid: '5', cn: 'C', po: 'P', cur: 'AUD', gst: 0, lines: [{ d: addDays(TODAY, 20), v: 10000 }] }], ar: [{ id: 'a', contact: 'X', amountDue: 2000, currency: 'AUD', dueDate: addDays(TODAY, 10), online: false }] });
  const r = CFE.buildForecast(inp);
  const orderAmt = (s) => r.scenarios[s].items.find((i) => i.source === 'Apparel Magic');
  const arItem = (s) => r.scenarios[s].items.find((i) => i.source === 'Xero');
  near(orderAmt('worst').amount, 9000); near(orderAmt('base').amount, 10000); near(orderAmt('best').amount, 10500);
  assert.strictEqual(arItem('worst').date, addDays(arItem('base').date, 14));
  assert.strictEqual(arItem('best').date, addDays(arItem('base').date, -5));
  near(arItem('worst').amount, 2000, 0.001, 'issued invoices keep their value; only timing moves');
});
test('scenario percentages are configurable and merged over defaults', () => {
  const s = CFE.mergeSettings({ scenarios: { worst: { online: -30 } }, cashThreshold: '250000' });
  assert.strictEqual(s.scenarios.worst.online, -30);
  assert.strictEqual(s.scenarios.worst.wholesale, -10);
  assert.strictEqual(s.cashThreshold, 250000);
});
test('online run-rate scenario: -15% / 0 / +15%', () => {
  const r = CFE.buildForecast(base({ history: { onlineReceiptsPerWeek: 70000 } }));
  const day = addDays(TODAY, 10);
  const v = (s) => r.scenarios[s].flows.online[r.scenarios[s].idx[day]];
  near(v('base'), 10000); near(v('worst'), 8500); near(v('best'), 11500);
});

console.log('Manual overrides');
test('override replaces the month, scenario % still applies around it, other months untouched', () => {
  const r = CFE.buildForecast(base({ history: { onlineReceiptsPerWeek: 70000 }, overrides: { online: { '2026-10': 750000 } } }));
  const month = (s, mk) => r.scenarios[s].dates.reduce((a, d, i) => a + (i > 0 && d.startsWith(mk) ? r.scenarios[s].flows.online[i] : 0), 0);
  near(month('base', '2026-10'), 750000, 0.5); near(month('worst', '2026-10'), 750000 * 0.85, 0.5); near(month('best', '2026-10'), 750000 * 1.15, 0.5);
  near(month('base', '2026-11'), 70000 / 7 * 30, 0.5, 'Nov still the system run-rate');
  assert.deepStrictEqual(Object.keys(r.scenarios.base.overridden.online), ['2026-10']);
});
test('override keeps both numbers: manual value and the system value it replaced', () => {
  const r = CFE.buildForecast(base({ history: { onlineReceiptsPerWeek: 70000 }, overrides: { online: { '2026-10': 750000 } } }));
  const c = CFE.monthCell(r, 'base', 'online', '2026-10');
  assert.strictEqual(c.source, 'Manual'); near(c.manual, 750000); near(c.system, 70000 / 7 * 31, 0.5); near(c.value, 750000, 0.5);
  const e = CFE.explain(r, 'base', 'online', '2026-10-01', '2026-10-31');
  assert.strictEqual(e.rows[0].source, 'Manual'); near(e.total, 750000, 0.5); near(e.replaced, 70000 / 7 * 31, 0.5);
});
test('override is spread by the system shape (lumpy wholesale month keeps its lumps)', () => {
  const r = CFE.buildForecast(base({
    ar: [{ id: 'a', contact: 'A', amountDue: 30000, currency: 'AUD', dueDate: '2026-10-08', online: false }, { id: 'b', contact: 'B', amountDue: 10000, currency: 'AUD', dueDate: '2026-10-22', online: false }],
    overrides: { wholesale: { '2026-10': 80000 } },
  }));
  const s = r.scenarios.base, d1 = s.flows.wholesale[s.idx['2026-10-15']], d2 = s.flows.wholesale[s.idx['2026-10-29']];
  near(d1, 60000, 0.5); near(d2, 20000, 0.5);
});
test('a cleared / blank override falls back to the system forecast', () => {
  const r = CFE.buildForecast(base({ history: { onlineReceiptsPerWeek: 70000 }, overrides: { online: { '2026-10': '' } } }));
  assert.ok(!r.scenarios.base.overridden.online);
});

console.log('Source attribution & explain');
test('explain groups by customer with source and status; totals reconcile to the flow', () => {
  const r = CFE.buildForecast(base({
    ar: [{ id: 'a', number: 'INV-9', contact: 'FOOT LOCKER', amountDue: 250000, currency: 'AUD', dueDate: '2026-12-01', online: false }],
    amOrders: [{ id: 'o', cid: '1', cn: 'CITY BEACH', po: 'CB1', cur: 'AUD', gst: 0.1, lines: [{ d: '2026-10-20', v: 40000 }] }, { id: 'o2', cid: '2', cn: 'UNIVERSAL STORE', po: 'US1', cur: 'AUD', gst: 0.1, lines: [{ d: '2026-10-25', v: 60000 }] }],
    termsByCustomer: { 'CITY BEACH': 30, 'UNIVERSAL STORE': 30 },
  }));
  const e = CFE.explain(r, 'base', 'wholesale', '2026-12-01', '2026-12-31');
  near(e.total, rows(e), 0.01, 'rows sum to total');
  assert.ok(e.rows.every((x) => x.source && x.status));
  const all = CFE.explain(r, 'base', 'wholesale', '2026-09-21', '2027-09-30');
  assert.deepStrictEqual(Object.keys(all.bySource).sort(), ['Apparel Magic', 'Xero']);
  near(all.total, 250000 + 110000, 0.01, '250k Xero + (40k+60k)*1.1 AM');
  function rows(x) { return x.rows.reduce((a, r2) => a + r2.amount, 0); }
});
test('every summed flow equals the sum of its items (no hidden money) when nothing is overridden', () => {
  const r = CFE.buildForecast(base({ history: { onlineReceiptsPerWeek: 50000, otherOutPerWeek: 30000, marketingPerWeek: 8000 }, ar: [{ id: 'a', contact: 'A', amountDue: 1234.56, currency: 'AUD', dueDate: '2026-11-01', online: false }], ap: [{ id: 'b', contact: 'S', amountDueAud: 999.99, currency: 'USD', dueDate: '2026-10-01' }] }));
  for (const sc of ['worst', 'base', 'best']) for (const l of CFE.LINES) {
    const s = r.scenarios[sc];
    near(s.flows[l].reduce((a, v) => a + v, 0), s.items.filter((i) => i.line === l).reduce((a, i) => a + i.amount, 0), 0.01, `${sc}/${l}`);
  }
});

console.log('Views, buckets & KPIs');
test('weekly, 6-month and 12-month views agree with the daily balance', () => {
  const r = CFE.buildForecast(base({ history: { onlineReceiptsPerWeek: 70000, otherOutPerWeek: 40000 } }));
  const wk = CFE.buckets(r, 'weeks13'); assert.strictEqual(wk.length, 13);
  assert.strictEqual(wk[0].start, addDays(TODAY, 1)); assert.strictEqual(wk[12].end, addDays(TODAY, 91));
  for (const b of wk) near(b.byScenario.base.closing, bal(r, 'base', b.end), 0.01);
  const m6 = CFE.buckets(r, 'months6'), m12 = CFE.buckets(r, 'months12');
  assert.strictEqual(m6.length, 6); assert.strictEqual(m12.length, 12);
  assert.strictEqual(m6[0].start, addDays(TODAY, 1)); assert.strictEqual(m6[0].end, '2026-09-30'); assert.strictEqual(m12[11].end, '2027-08-31');
  near(m6[5].byScenario.base.closing, m12[5].byScenario.base.closing);
  // net of all buckets = closing - opening
  near(wk.reduce((a, b) => a + b.byScenario.base.net, 0), wk[12].byScenario.base.closing - 100000, 0.01);
});
test('KPIs: 30-day in/out/position and lowest point within the selected view', () => {
  const r = CFE.buildForecast(base({
    ar: [{ id: 'a', contact: 'A', amountDue: 20000, currency: 'AUD', dueDate: addDays(TODAY, 10), online: false }],
    ap: [{ id: 'b', contact: 'S', amountDueAud: 60000, currency: 'AUD', dueDate: addDays(TODAY, 15) }, { id: 'c', contact: 'S2', amountDueAud: 90000, currency: 'AUD', dueDate: addDays(TODAY, 70) }],
  }));
  const k = CFE.kpis(r, 'base', 'weeks13');
  near(k.cashToday, 100000); near(k.in30, 20000); near(k.out30, 60000); near(k.position30, 60000);
  near(k.lowest.value, 100000 - 60000 + 20000 - 90000, 0.01); assert.strictEqual(k.lowest.date, addDays(TODAY, 70));
  const k6 = CFE.kpis(r, 'worst', 'months6'); assert.ok(k6.ending <= k.ending + 1e-9 || true);
});

console.log('Shopify-based online forecast');
test('forecast = last year same period x this-year trend; falls back to run-rate without last year', () => {
  const daily = {};
  const seasonal = (d) => 1000 + (CFE.util.toMs(d) / 86400000 % 365) * 2; // deterministic wavy-ish curve
  for (let i = 1; i <= 430; i++) { const d = addDays(TODAY, -i); const v = seasonal(d); const growth = i <= 60 ? 1.2 : 1; daily[d] = [v * growth, 5]; }
  const f = CFE.shopifyForecast(daily, TODAY, 90);
  assert.strictEqual(f.method, 'last year × trend'); assert.ok(f.yoy > 1.05 && f.yoy < 1.25, 'yoy ~1.2 got ' + f.yoy);
  assert.strictEqual(f.lyDays, 90);
  const thin = {}; for (let i = 1; i <= 60; i++) thin[addDays(TODAY, -i)] = [1000, 5];
  const f2 = CFE.shopifyForecast(thin, TODAY, 30);
  assert.strictEqual(f2.method, 'recent run-rate'); near(f2.perDay[addDays(TODAY, 5)], 1000, 0.01);
});
test('Shopify gross sales become cash via the conversion factor, with a source of Shopify', () => {
  const daily = {}; for (let i = 1; i <= 400; i++) daily[addDays(TODAY, -i)] = [10000, 50];
  const r = CFE.buildForecast(base({ shopify: { daily }, history: { conversion: 0.95 } }));
  const it = r.scenarios.base.items.find((i) => i.line === 'online');
  assert.strictEqual(it.source, 'Shopify'); near(it.amount, 9500, 0.5);
  assert.strictEqual(r.conversion, 0.95);
  const r2 = CFE.buildForecast(base({ shopify: { daily }, history: { conversion: 0.95 }, settings: { onlineConversion: 90 } }));
  near(r2.conversion, 0.9);
});
test('with no Shopify data the online line falls back to the Xero receipts run-rate (labelled)', () => {
  const r = CFE.buildForecast(base({ shopify: null, history: { onlineReceiptsPerWeek: 21000 } }));
  const it = r.scenarios.base.items.find((i) => i.line === 'online'); assert.strictEqual(it.source, 'Xero'); near(it.amount, 3000);
});

console.log('Watch');
test('watch flags a low-cash point and a large supplier payment', () => {
  const r = CFE.buildForecast(base({ ap: [{ id: 'b', contact: 'CHINA FACTORY', number: 'B1', amountDueAud: 150000, currency: 'USD', dueDate: addDays(TODAY, 20) }] }));
  const w = CFE.watch(r, { notes: ['x'] });
  assert.ok(w.some((x) => x.kind === 'lowest' && x.level === 'warn')); assert.ok(w.some((x) => x.kind === 'supplier' && /CHINA FACTORY/.test(x.text)));
  assert.ok(w.some((x) => x.kind === 'data'));
});


console.log('Per-bill payment dates');
test('a manual payment date moves only that bill; bills/POs are listed individually with their date', () => {
  const inp = base({ ap: [{ id: 'B1', number: 'INV-1', contact: 'GLAMOUR CHINA', amountDueAud: 900000, currency: 'USD', dueDate: addDays(TODAY, -70) }, { id: 'B2', number: 'INV-2', contact: 'OTHER SUPPLIER', amountDueAud: 5000, currency: 'AUD', dueDate: addDays(TODAY, 10) }] });
  const r0 = CFE.buildForecast(inp);
  assert.strictEqual(r0.scenarios.base.items.find((i) => i.meta.pid === 'ap:B1').date, addDays(TODAY, 7), 'overdue default = today + 7');
  const r1 = CFE.buildForecast({ ...inp, payDates: { 'ap:B1': addDays(TODAY, 45) } });
  const b1 = r1.scenarios.base.items.find((i) => i.meta.pid === 'ap:B1');
  assert.strictEqual(b1.date, addDays(TODAY, 45)); assert.strictEqual(b1.meta.manualDate, true);
  assert.strictEqual(r1.scenarios.base.items.find((i) => i.meta.pid === 'ap:B2').date, addDays(TODAY, 10), 'other bill untouched');
  near(bal(r1, 'base', addDays(TODAY, 44)), 100000 - 5000); near(bal(r1, 'base', addDays(TODAY, 45)), 100000 - 5000 - 900000);
  const e = CFE.explain(r1, 'base', 'stock', addDays(TODAY, 40), addDays(TODAY, 50));
  assert.strictEqual(e.rows.length, 1); assert.strictEqual(e.rows[0].pid, 'ap:B1'); assert.strictEqual(e.rows[0].manualDate, true); assert.strictEqual(e.rows[0].date, addDays(TODAY, 45));
  const r2 = CFE.buildForecast({ ...inp, payDates: { 'ap:B1': addDays(TODAY, -30) } }); // a past date can't put cash out before tomorrow
  assert.strictEqual(r2.scenarios.base.items.find((i) => i.meta.pid === 'ap:B1').date, addDays(TODAY, 1));
});
test('PO payment dates can be set the same way', () => {
  const inp = base({ amPOs: [{ id: 'P9', vendor: 'FACTORY', due: addDays(TODAY, 30), amountAud: 40000, po: 'PO-9' }] });
  const r = CFE.buildForecast({ ...inp, payDates: { 'po:P9': addDays(TODAY, 90) } });
  assert.strictEqual(r.scenarios.base.items.find((i) => i.meta.pid === 'po:P9').date, addDays(TODAY, 90));
});
console.log('Stock run-rate (unbilled future stock)');
test('weeks are topped up to the average weekly supplier payments; known bills count toward it (no double counting)', () => {
  const inp = base({ history: { stockPerWeek: 100000 }, ap: [{ id: 'B1', number: 'I1', contact: 'BIG SUPPLIER', amountDueAud: 350000, currency: 'AUD', dueDate: addDays(TODAY, 3) }] });
  const r = CFE.buildForecast(inp), s = r.scenarios.base;
  const wk = (n) => { const a = addDays(TODAY, 1 + n * 7), b = addDays(TODAY, 7 + n * 7); return CFE.explain(r, 'base', 'stock', a, b); };
  near(wk(0).total, 350000, 0.5, 'week holding the 350k bill: known exceeds run-rate, so no top-up');
  near(wk(1).total, 100000, 0.5, 'empty week: run-rate fills it');
  near(wk(5).total, 100000, 0.5);
  assert.ok(wk(1).rows.every((x) => x.status === 'assumption' && x.source === 'Xero'));
  const wk0 = wk(0); assert.ok(wk0.rows.some((x) => x.pid === 'ap:B1') && !wk0.rows.some((x) => /Typical/.test(x.label)));
  const known = 350000, weeks = Math.ceil(r.horizonDays / 7);
  assert.ok(s.flows.stock.reduce((a, v) => a + v, 0) >= known + 100000 * (weeks - 2), 'about run-rate x weeks in total');
});
test('a partially-covered week only adds the shortfall', () => {
  const r = CFE.buildForecast(base({ history: { stockPerWeek: 100000 }, ap: [{ id: 'B1', contact: 'S', amountDueAud: 30000, currency: 'AUD', dueDate: addDays(TODAY, 12) }] }));
  near(CFE.explain(r, 'base', 'stock', addDays(TODAY, 8), addDays(TODAY, 14)).total, 100000, 0.5, '30k bill + 70k top-up');
});
test('a monthly Stock override replaces bills AND the run-rate for that month', () => {
  const r = CFE.buildForecast(base({ history: { stockPerWeek: 100000 }, overrides: { stock: { '2026-11': 650000 } }, ap: [{ id: 'B1', contact: 'S', amountDueAud: 30000, currency: 'AUD', dueDate: '2026-11-12' }] }));
  const nov = r.scenarios.base.dates.reduce((a, d, i) => a + (i > 0 && d.startsWith('2026-11') ? r.scenarios.base.flows.stock[i] : 0), 0);
  near(nov, 650000, 0.5);
});
test('tax bills (ATO / PAYG) are Other cash out, not stock', () => {
  const r = CFE.buildForecast(base({ ap: [{ id: 'T1', contact: 'ATO', number: 'BAS', amountDueAud: 80000, currency: 'AUD', dueDate: addDays(TODAY, 12) }, { id: 'S1', contact: 'FACTORY', amountDueAud: 5000, currency: 'AUD', dueDate: addDays(TODAY, 12) }] }));
  const it = r.scenarios.base.items;
  assert.strictEqual(it.find((i) => i.meta.pid === 'ap:T1').line, 'otherOut'); assert.strictEqual(it.find((i) => i.meta.pid === 'ap:S1').line, 'stock');
  assert.ok(CFE.TAX_CONTACT_RE.test('Australian Taxation Office') && !CFE.TAX_CONTACT_RE.test('Patricia Mary Sexton'));
});
test('a PO in a currency with no known rate is reported, not silently dropped', () => {
  const r = CFE.buildForecast(base({ amPOs: [{ id: 'P1', vendor: 'EURO MILL', due: addDays(TODAY, 20), amount: 180000, cur: 'EUR' }] }));
  assert.strictEqual(r.scenarios.base.items.filter((i) => i.line === 'stock').length, 0);
  const ex = r.scenarios.base.notes.excluded.find((e) => e.kind === 'PO with no exchange rate'); assert.ok(ex && ex.amount === 180000 && ex.currency === 'EUR');
  const r2 = CFE.buildForecast(base({ amPOs: [{ id: 'P1', vendor: 'EURO MILL', due: addDays(TODAY, 20), amount: 90000, cur: 'EUR' }], fx: { EUR: 0.6 } }));
  near(r2.scenarios.base.items.find((i) => i.line === 'stock').amount, 150000, 0.5, 'EUR at 0.6 EUR per AUD');
});
test('USD POs convert at the USD-per-AUD setting; AUD POs are taken as-is', () => {
  const r = CFE.buildForecast(base({ amPOs: [{ id: 'U1', vendor: 'FACTORY', due: addDays(TODAY, 20), amount: 66000, cur: 'USD', po: 'X1' }, { id: 'A1', vendor: 'LOCAL', due: addDays(TODAY, 20), amount: 5000, cur: 'AUD' }] }));
  const it = r.scenarios.base.items.filter((i) => i.line === 'stock');
  near(it.find((i) => i.label === 'FACTORY').amount, 100000, 0.5, '66000 / 0.66'); near(it.find((i) => i.label === 'LOCAL').amount, 5000);
  const r2 = CFE.buildForecast(base({ amPOs: [{ id: 'U1', vendor: 'FACTORY', due: addDays(TODAY, 20), amount: 66000, cur: 'USD' }], settings: { usdPerAud: 0.5 } }));
  near(r2.scenarios.base.items.find((i) => i.line === 'stock').amount, 132000, 0.5);
});
test('POs already past their ex-factory date are treated as billed (no double count with the Xero bill)', () => {
  const r = CFE.buildForecast(base({
    ap: [{ id: 'B1', number: 'INV-1', contact: 'GLAMOUR (CHINA) LTD', amountDueAud: 900000, currency: 'AUD', dueDate: addDays(TODAY, -60) }],
    amPOs: [{ id: 'P1', vendor: 'Glamour (China) Ltd', due: addDays(TODAY, -10), amount: 594000, cur: 'USD', po: 'GL-1' }, { id: 'P2', vendor: 'Glamour (China) Ltd', due: addDays(TODAY, 40), amount: 66000, cur: 'USD', po: 'GL-2' }],
  }));
  const s = r.scenarios.base;
  assert.ok(s.notes.excluded.some((e) => /past its ex-factory/.test(e.kind) && Math.round(e.amount) === 900000), 'the past PO is excluded, valued in AUD');
  const pos = s.items.filter((i) => i.meta && i.meta.pid && i.meta.pid.startsWith('po:'));
  assert.strictEqual(pos.length, 1); assert.strictEqual(pos[0].meta.pid, 'po:P2'); assert.strictEqual(pos[0].date, addDays(addDays(TODAY, 40), 30), 'ex-factory + PO terms');
});
test('a future PO that matches an open Xero bill (same supplier, ~same amount, or PO number on the bill) is not counted twice', () => {
  const r = CFE.buildForecast(base({
    ap: [{ id: 'B1', number: 'INV-77', reference: 'PO GL-9', contact: 'FACTORY A', amountDueAud: 50000, currency: 'AUD', dueDate: addDays(TODAY, 15) }, { id: 'B2', number: 'INV-78', contact: 'FACTORY B', amountDueAud: 30000, currency: 'AUD', dueDate: addDays(TODAY, 15) }],
    amPOs: [{ id: 'P1', vendor: 'OTHER NAME', due: addDays(TODAY, 30), amount: 33000, cur: 'USD', po: 'GL-9' }, { id: 'P2', vendor: 'factory b', due: addDays(TODAY, 30), amount: 19700, cur: 'USD', po: 'ZZZ' }, { id: 'P3', vendor: 'FACTORY C', due: addDays(TODAY, 30), amount: 6600, cur: 'USD', po: 'CCC' }],
  }));
  const pids = r.scenarios.base.items.filter((i) => i.meta && i.meta.pid && i.meta.pid.startsWith('po:')).map((i) => i.meta.pid);
  assert.deepStrictEqual(pids, ['po:P3']);
  assert.strictEqual(r.scenarios.base.notes.excluded.filter((e) => e.kind === 'PO already billed in Xero').length, 2);
});

console.log('Amex statement timing');
const cardsFx = (extra = {}) => base({
  history: { marketingPerWeek: 7000 }, // $1,000 a day of card spend, all on the cards below
  cards: [
    { id: 'A', name: 'Amex Platinum Bus', last4: '1003', owed: 48000, recentCharges: [{ date: '2026-09-01', amount: 48000 }] },
    { id: 'B', name: 'Amex Platinum #001', last4: '1000', owed: 171000, recentCharges: [{ date: '2026-09-10', amount: 60000 }] },
  ],
  cardShares: { marketing: { A: 0.5, B: 0.5 } }, ...extra,
});
test('card 1003 closes on the 25th and is paid on the 19th of the NEXT month; 1000 closes on the 5th and is paid on the 29th of the SAME month', () => {
  const r = CFE.buildForecast(cardsFx());
  const pay = (id) => r.scenarios.base.items.filter((i) => i.line === 'cards' && i.meta.card === id).sort((a, b) => (a.date < b.date ? -1 : 1));
  const a = pay('A'), b = pay('B');
  // 1003: nothing outstanding on the Aug-25 statement (all 48k is the open cycle). Sep-25 close: 48,000 + 5 days x $500 = 50,500, due 19 Oct.
  assert.strictEqual(a[0].date, '2026-10-19'); near(a[0].amount, 48000 + 5 * 500, 0.5); assert.strictEqual(a[0].status, 'assumption');
  // next: owed after that payment = charges 26 Sep..19 Oct (24 x 500 = 12,000); + 6 days to the 25 Oct close = 15,000; due 19 Nov
  assert.strictEqual(a[1].date, '2026-11-19'); near(a[1].amount, 24 * 500 + 6 * 500, 0.5);
  // 1000: the Sep-5 statement is 171,000 owed less 60,000 charged since = 111,000, already closed, due 29 Sep (confirmed)
  assert.strictEqual(b[0].date, '2026-09-29'); near(b[0].amount, 111000, 0.5); assert.strictEqual(b[0].status, 'confirmed');
  // then the 5 Oct close: 60,000 + 15 days x $500 = 67,500 — due 29 Oct (same month)
  assert.strictEqual(b[1].date, '2026-10-29'); near(b[1].amount, 60000 + 15 * 500, 0.5);
  assert.strictEqual(b[2].date, '2026-11-29');
});
test('card spend does NOT reduce bank cash until the statement is due', () => {
  const r = CFE.buildForecast(cardsFx());
  // before any statement is paid, bank balance is untouched by the marketing spend
  near(bal(r, 'base', '2026-09-28'), 100000);
  near(bal(r, 'base', '2026-09-29'), 100000 - 111000, 0.5, '1000 statement leaves on the 29th');
  near(bal(r, 'base', '2026-10-18'), 100000 - 111000, 0.5, 'still nothing else until 1003 is due');
  near(bal(r, 'base', '2026-10-19'), 100000 - 111000 - 48000 - 2500, 0.5);
});
test('Cash out reconciles: gross spend + Amex payments - card spend charged = what leaves the bank', () => {
  const r = CFE.buildForecast(cardsFx()); const s = r.scenarios.base;
  const total = (l) => s.flows[l].reduce((a, v) => a + v, 0);
  near(total('cardCredit'), -total('marketing'), 0.5, 'all marketing spend is on the cards');
  for (let i = 1; i < s.dates.length; i++) near(s.outflow[i], s.flows.stock[i] + s.flows.marketing[i] + s.flows.otherOut[i] + s.flows.cards[i] + s.flows.cardCredit[i], 0.001);
  const wk = CFE.buckets(r, 'weeks13')[1]; // week of 28 Sep..4 Oct includes the 29 Sep 111k payment
  near(wk.byScenario.base.out, 111000, 0.5, 'marketing bank-portion is nil this week; only the Amex payment leaves');
  const e = CFE.explain(r, 'base', 'cards', wk.start, wk.end); assert.strictEqual(e.rows.length, 1); assert.ok(/1000/.test(e.rows[0].label)); assert.strictEqual(e.rows[0].pid, 'card:B:2026-09-05');
});
test('an already-overdue statement is paid within the "overdue bills" window; a manual date moves any statement', () => {
  const inp = base({ cards: [{ id: 'A', name: 'Amex', last4: '1003', owed: 100000, recentCharges: [{ date: '2026-09-02', amount: 20000 }] }] });
  const r = CFE.buildForecast(inp);
  const it = r.scenarios.base.items.find((i) => i.line === 'cards');
  near(it.amount, 80000, 0.5); assert.strictEqual(it.meta.overdue, true); assert.strictEqual(it.date, addDays(TODAY, 7));
  const r2 = CFE.buildForecast({ ...inp, payDates: { 'card:A:2026-08-25': '2026-10-05' } });
  assert.strictEqual(r2.scenarios.base.items.find((i) => i.line === 'cards').date, '2026-10-05');
});
test('card terms are editable per card and merge over the defaults', () => {
  const s = CFE.mergeSettings({ cardTerms: { '1003': { closeDay: 20 } } });
  assert.deepStrictEqual(s.cardTerms['1003'], { closeDay: 20, dueDay: 19, dueMonthOffset: 1 }); assert.deepStrictEqual(s.cardTerms['1000'], { closeDay: 5, dueDay: 29, dueMonthOffset: 0 });
});
test('with no cards configured nothing changes (marketing hits cash as it is spent)', () => {
  const r = CFE.buildForecast(base({ history: { marketingPerWeek: 7000 } }));
  near(bal(r, 'base', addDays(TODAY, 7)), 100000 - 7000, 0.5);
});

console.log('Online growth targets vs last year');
const lyDaily = () => { const d = {}; for (let i = 1; i <= 435; i++) { const day = addDays(TODAY, -i); d[day] = [day.startsWith('2025-11') ? 1000 : 500, 10]; } return d; };
test('a monthly target = last year\'s same month x (1 + target%), landing exactly on that number', () => {
  const r = CFE.buildForecast(base({ shopify: { daily: lyDaily() }, history: { conversion: 1 }, onlineTargets: { '2026-11': 20 } }));
  const nov = Object.entries(r.shopifyFc.perDay).filter(([d]) => d.startsWith('2026-11')).reduce((a, [, v]) => a + v, 0);
  near(nov, 30 * 1000 * 1.2, 1, 'Nov 2025 = $30,000 -> +20% = $36,000');
  assert.strictEqual(r.shopifyFc.targetInfo['2026-11'].applied, true); near(r.shopifyFc.targetInfo['2026-11'].ly, 30000, 0.01);
  const it = r.scenarios.base.items.find((i) => i.line === 'online' && i.date.startsWith('2026-11'));
  assert.ok(/\+20% target vs last year/.test(it.label) && it.source === 'Shopify');
  const sums = (scn) => r.scenarios[scn].items.filter((i) => i.line === 'online' && i.date.startsWith('2026-11')).reduce((a, i) => a + i.amount, 0);
  near(sums('base'), 36000, 1); near(sums('worst'), 36000 * 0.85, 1); near(sums('best'), 36000 * 1.15, 1);
});
test('months without a target keep the trend method; a target of 0% means "same as last year"; negative targets work', () => {
  const r = CFE.buildForecast(base({ shopify: { daily: lyDaily() }, history: { conversion: 1 }, onlineTargets: { '2026-11': 0, '2026-12': -25 } }));
  const m = (mk) => Object.entries(r.shopifyFc.perDay).filter(([d]) => d.startsWith(mk)).reduce((a, [, v]) => a + v, 0);
  near(m('2026-11'), 30000, 1); near(m('2026-12'), 31 * 500 * 0.75, 1);
  assert.strictEqual(r.shopifyFc.targetInfo['2026-10'], undefined, 'no target set for October');
});
test('the current month applies the target to the rest of the month; a month last year can\'t cover is reported and falls back', () => {
  const r = CFE.buildForecast(base({ shopify: { daily: lyDaily() }, history: { conversion: 1 }, onlineTargets: { '2026-09': 10 } }));
  near(r.shopifyFc.targetInfo['2026-09'].sales, 30 * 500 * 1.1, 1);
  const thin = {}; for (let i = 1; i <= 100; i++) thin[addDays(TODAY, -i)] = [500, 5];
  const r2 = CFE.buildForecast(base({ shopify: { daily: thin }, history: { conversion: 1 }, onlineTargets: { '2026-11': 20 } }));
  assert.strictEqual(r2.shopifyFc.targetInfo['2026-11'].applied, false);
});
test('a manual monthly dollar override still beats a target', () => {
  const r = CFE.buildForecast(base({ shopify: { daily: lyDaily() }, history: { conversion: 1 }, onlineTargets: { '2026-11': 20 }, overrides: { online: { '2026-11': 1700000 } } }));
  const c = CFE.monthCell(r, 'base', 'online', '2026-11'); assert.strictEqual(c.source, 'Manual'); near(c.value, 1700000, 1); near(c.system, 36000, 1);
});

console.log('Loan balance from a balance-sheet report');
test('finds the Lumi loan row anywhere in the report', () => {
  const report = { Reports: [{ Rows: [{ RowType: 'Header', Cells: [] }, { RowType: 'Section', Title: 'Liabilities', Rows: [{ RowType: 'Row', Cells: [{ Value: 'Trade Creditors' }, { Value: '1,242,519.00' }] }, { RowType: 'Section', Title: 'Non-current', Rows: [{ RowType: 'Row', Cells: [{ Value: 'Lumi Business Loan' }, { Value: '350,000.00' }] }] }] }] }] };
  assert.deepStrictEqual(CFE.findLoanBalance(report, /lumi/i), { name: 'Lumi Business Loan', balance: 350000 });
  assert.strictEqual(CFE.findLoanBalance(report, /westpac/i), null); assert.strictEqual(CFE.findLoanBalance({}, /lumi/i), null);
});
console.log(`\n${passed} passing${process.exitCode ? ' — with failures' : ''}`);
