// Run with:  node tests/cashflow-history.test.js
// Last year's cash flow: Xero's BankSummary + direct bank transactions + invoice/bill payments → one row per
// month on the forecast's basis, and the Year view rows (actual months, then forecast months with last year).
const assert = require('assert');
const H = require('../cashflow-history.js');
let n = 0;
const test = (name, fn) => { try { fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };

const B = 'bank-1', C = 'card-1', PP = 'paypal';
const d = (iso) => `/Date(${Date.parse(iso + 'T00:00:00Z')}+0000)/`;
const tx = (acct, date, total, contact, extra) => Object.assign({ Status: 'AUTHORISED', BankAccount: { AccountID: acct }, Date: d(date), Total: total, Contact: { Name: contact } }, extra || {});
const inv = (contact, payments, extra) => Object.assign({ Contact: { Name: contact }, CurrencyCode: 'AUD', Payments: payments.map(([date, amt, more]) => Object.assign({ Date: d(date), Amount: amt }, more || {})) }, extra || {});

// January: bank 1000 → 1160 (received 560, spent 400); the card owes 200 more than it did (spent 300, received 150).
const summaries = {
  '2026-01': [{ id: B, open: 1000, rec: 560, sp: 400, close: 1160 }, { id: C, open: -200, rec: 150, sp: 300, close: -350 }, { id: PP, open: 5, rec: 0, sp: 0, close: 5 }],
  '2026-02': [{ id: B, open: 1160, rec: 100, sp: 60, close: 1200 }, { id: C, open: -350, rec: 0, sp: 0, close: -350 }],
};
const input = {
  months: ['2026-01', '2026-02'], today: '2026-02-10', summaries, bankIds: [B], cardIds: [C],
  recv: [
    tx(B, '2026-01-10', 200, 'ONLINE SALES'), tx(B, '2026-01-12', 100, 'Lumi Finance'),
    tx(C, '2026-01-05', 10, 'Some Shop refund'), tx(PP, '2026-01-06', 999, 'ignored: not a bank account'),
    tx(B, '2026-01-14', 777, 'Void', { Status: 'DELETED' }),
  ],
  spend: [
    tx(B, '2026-01-03', 120, 'Wages'),
    tx(C, '2026-01-08', 220, 'Facebook'), tx(C, '2026-01-09', 30, 'Cafe'),
  ],
  arInvoices: [
    inv('BOBBIES CLOTHING', [['2026-01-20', 150], ['2026-02-02', 100]]),
    inv('VOID CLOTHING - NZ', [['2026-01-22', 125, { CurrencyRate: 1.25 }]], { CurrencyCode: 'NZD', CurrencyRate: 1.3 }),
    inv('Afterpay', [['2026-01-25', 0]]),
  ],
  apInvoices: [
    inv('Dongguan Factory', [['2026-01-15', 90], ['2026-01-16', 50, { Status: 'DELETED' }]]),
    inv('Other Supplier', [['2026-01-16', 50]]),          // settled with the card (see cardsSpent − card spend = 50)
    inv('Australian Taxation Office', [['2026-01-28', 40]]),
  ],
};
const jan = () => H.buildMonthly(input).months[0];

test('Bank summary rows are read per account: opening, received, spent, closing', () => {
  const rep = { Reports: [{ Rows: [{ RowType: 'Header' }, { RowType: 'Section', Rows: [
    { RowType: 'Row', Cells: [{ Value: 'Business Account', Attributes: [{ Id: 'accountID', Value: 'a1' }] }, { Value: '104960.66' }, { Value: '965260.93' }, { Value: '780476.73' }, { Value: '289744.86' }] },
    { RowType: 'SummaryRow', Cells: [{ Value: 'Total' }] },
  ] }] }] };
  assert.deepStrictEqual(H.parseBankSummary(rep), [{ id: 'a1', name: 'Business Account', open: 104960.66, rec: 965260.93, sp: 780476.73, close: 289744.86 }]);
  assert.deepStrictEqual(H.parseBankSummary({}), []);
});
test('cash in: online from online contacts, wholesale from customer payments (NZD converted), the rest is other in', () => {
  const m = jan();
  assert.strictEqual(m.online, 200);
  assert.strictEqual(m.wholesale, 150 + 125 / 1.25, 'NZD 125 at 1.25 per AUD = AUD 100');
  assert.strictEqual(m.totalIn, 560);
  assert.strictEqual(m.otherIn, 560 - 200 - 250, 'loan money, owner money and transfers land here, so the lines always add up');
  assert.strictEqual(m.online + m.wholesale + m.otherIn, m.totalIn);
});
test('cash out: Amex payments are money into the cards (less refunds); card-paid bills are not counted as stock', () => {
  const m = jan();
  assert.strictEqual(m.cards, 150 - 10, 'cards received 150, of which 10 was a refund');
  assert.strictEqual(m.stock, 90, 'supplier payments 90 + 50 (paid by card, 300 spent − 250 direct card spend) − 50; the ATO bill and the deleted payment are excluded');
  assert.strictEqual(m.totalOut, 400);
  assert.strictEqual(m.bas, 40, 'the ATO bill payment is its own BAS column…');
  assert.strictEqual(m.otherOut, 400 - 90 - 140 - 40, '…and is no longer inside Other out');
  assert.strictEqual(m.stock + m.cards + m.bas + m.otherOut, m.totalOut);
});
test('BAS is kept out of the operating-cost baseline the forecast plans from (eng.otherOut), and reported alongside it', () => {
  const m = jan();
  assert.strictEqual(m.eng.bas, 40);
  const withoutBas = H.buildMonthly({ ...input, apInvoices: input.apInvoices.filter((i) => i.Contact.Name !== 'Australian Taxation Office') }).months[0];
  assert.strictEqual(m.eng.otherOut + m.eng.bas, withoutBas.eng.otherOut, 'the same cash, but the ATO payment sits in BAS instead of in the planning baseline');
  assert.strictEqual(withoutBas.eng.bas, 0);
  assert.strictEqual(m.eng.stock, withoutBas.eng.stock, 'and it is not stock either');
});
test('online deposits are kept day by day (bank receipts + invoice payments from online contacts), for the online forecast', () => {
  const m = jan();
  assert.deepStrictEqual(m.onlineDaily, { '2026-01-10': 200 }, 'the deleted receipt, the PayPal account and the $0 Afterpay payment are not in it');
  const withPay = H.buildMonthly({ ...input, arInvoices: [...input.arInvoices, inv('Shopify', [['2026-01-10', 55.5], ['2026-01-11', 20]])] }).months[0];
  assert.deepStrictEqual(withPay.onlineDaily, { '2026-01-10': 255.5, '2026-01-11': 20 });
  assert.strictEqual(Math.round(Object.values(withPay.onlineDaily).reduce((a, b) => a + b, 0) * 100), Math.round(withPay.online * 100), 'the daily figures add up to the month');
});
test('forecast rows carry BAS in its own column and fold manual receipts / payments into other in / other out', () => {
  const b = { month: '2026-03', start: '2026-03-01', byScenario: { base: { online: 1, wholesale: 2, otherIn: 3, manualIn: 4, stock: 5, cards: 6, marketing: 7, otherOut: 8, cardCredit: -9, bas: 10, manualOut: 11, net: 0, closing: 0 } } };
  const r = H.forecastRow(b, 'base');
  assert.deepStrictEqual([r.otherIn, r.bas, r.otherOut, r.totalIn, r.totalOut], [3 + 4, 10, 7 + 8 - 9 + 11, 1 + 2 + 7, 5 + 6 + 10 + (7 + 8 - 9 + 11)]);
});
test('net, opening and closing come straight from the bank summary (cards and PayPal are not cash)', () => {
  const m = jan();
  assert.deepStrictEqual([m.opening, m.closing, m.net], [1000, 1160, 160]);
  assert.strictEqual(m.closing - m.opening, m.net);
});
test('card spend is reported as a memo: marketing vs other (including bills paid by card)', () => {
  assert.deepStrictEqual(jan().memo, { cardMarketing: 220, cardOther: 30 + 50 });
});
test('the cross-check shows what could not be matched to a transaction', () => {
  const c = jan().check;
  assert.strictEqual(c.unmatchedOut, 400 - 120 - (90 + 40) - 140, 'spent − direct bank spend − bank-paid supplier payments − Amex payments');
  assert.strictEqual(c.unmatchedIn, 560 - 300 - 250, 'received − direct receipts on the bank − customer payments');
});
test('the current month is flagged as partial; payments outside a month are ignored by it', () => {
  const r = H.buildMonthly(input).months;
  assert.deepStrictEqual(r.map((m) => m.partial), [false, true]);
  assert.strictEqual(r[1].wholesale, 100, 'only the 2 Feb payment');
  assert.strictEqual(r[1].online, 0);
});
test('a foreign payment with no exchange rate is left out with a warning, a missing summary is flagged', () => {
  const noRate = H.buildMonthly({ ...input, arInvoices: [inv('X NZ', [['2026-01-22', 125]], { CurrencyCode: 'NZD' })], months: ['2026-01', '2026-03'], summaries });
  assert.ok(noRate.warnings.some((w) => /no exchange rate/.test(w)));
  assert.ok(noRate.warnings.some((w) => /2026-03/.test(w)), 'no bank summary for March');
});
test('months for the Year view: 12 complete months plus the one in progress', () => {
  const m = H.monthsFor('2026-11-06');
  assert.strictEqual(m.length, 13); assert.strictEqual(m[0], '2025-11'); assert.strictEqual(m[11], '2026-10'); assert.strictEqual(m[12], '2026-11');
  assert.strictEqual(H.monthsFor('2026-01-31')[0], '2025-01');
});

// ---- Year view rows --------------------------------------------------------------------------
const fcRow = (o) => Object.assign({ online: 0, wholesale: 0, otherIn: 0, stock: 0, marketing: 0, otherOut: 0, cards: 0, cardCredit: 0, net: 0, closing: 0 }, o);
const bucket = (month, start, byScenario) => ({ month, start, end: H.lastDayOfMonth(month), byScenario });
const history = ['2025-11', '2025-12', '2026-01'].map((month, i) => ({ month, partial: false, online: 100 * (i + 1), wholesale: 50, otherIn: 5, totalIn: 100 * (i + 1) + 55, stock: 40, cards: 30, otherOut: 20, totalOut: 90, net: 100 * (i + 1) - 35, closing: 1000 + i }));
test('forecast lines map onto the bank basis: other out = marketing + other + card credit', () => {
  const r = H.forecastRow(bucket('2026-02', '2026-02-01', { base: fcRow({ online: 300, wholesale: 120, otherIn: 10, stock: 80, marketing: 200, otherOut: 50, cards: 220, cardCredit: -190, net: 70, closing: 1500 }) }), 'base');
  assert.deepStrictEqual([r.totalIn, r.stock, r.cards, r.otherOut, r.totalOut, r.net, r.closing], [430, 80, 220, 60, 360, 70, 1500]);
  assert.strictEqual(r.partial, false);
  assert.strictEqual(H.forecastRow(bucket('2026-02', '2026-02-07', { base: fcRow({}) }), 'base').partial, true, 'the first month starts tomorrow, so it is "the rest of the month"');
});
test('year rows: actual months first, then forecast months, each full forecast month carrying the same month last year', () => {
  const rows = H.yearRows(history, [
    bucket('2026-11', '2026-11-07', { base: fcRow({ online: 50 }) }),
    bucket('2026-12', '2026-12-01', { base: fcRow({ online: 700 }) }),
  ], 'base');
  assert.deepStrictEqual(rows.map((r) => r.kind + ':' + r.month), ['actual:2025-11', 'actual:2025-12', 'actual:2026-01', 'forecast:2026-11', 'forecast:2026-12']);
  assert.strictEqual(rows[3].lastYear, undefined, 'the part-month forecast has no like-for-like last year');
  assert.strictEqual(rows[4].lastYear.online, 200, 'Dec 2026 sits next to Dec 2025');
  assert.strictEqual(rows[4].lastYear.closing, 1001);
  const jan27 = H.yearRows(history, [bucket('2027-01', '2027-01-01', { base: fcRow({}) })], 'base')[3];
  assert.strictEqual(jan27.lastYear.online, 300, 'Jan 2027 sits next to Jan 2026');
  const feb27 = H.yearRows(history, [bucket('2027-02', '2027-02-01', { base: fcRow({}) })], 'base')[3];
  assert.strictEqual(feb27.lastYear, undefined, 'no history for Feb 2026 in this fixture');
});
test('totals add the flows and take the last closing balance', () => {
  const t = H.totals(history);
  assert.strictEqual(t.online, 600); assert.strictEqual(t.totalOut, 270); assert.strictEqual(t.closing, 1002);
});

// ---- BAS profile: quarterly BAS in the past, monthly since — modelled on the real pattern (round numbers) ----
const bill = (date, gst, payg, extra) => ({ date, total: gst + payg + ((extra && extra.fee) || 0), lines: [gst ? { AccountCode: '820', LineAmount: gst } : null, extra && extra.deferred ? { AccountCode: '822', LineAmount: extra.deferred } : null, payg ? { AccountCode: '825', LineAmount: payg } : null, extra && extra.fee ? { AccountCode: '404', LineAmount: extra.fee } : null].filter(Boolean) });
const BAS_BILLS = [
  bill('2025-11-27', 104000, 13000, { fee: 4500 }), bill('2025-12-05', 0, 7000), bill('2026-03-05', 101000, 10000),          // quarterly era
  bill('2026-05-21', 14000, 8000), bill('2026-05-26', 45000, 11000),                                                        // monthly from May: two bills in May
  bill('2026-06-26', 74000, 9000), bill('2026-07-26', 80000, 13000), bill('2026-08-21', 181000, 14000), bill('2026-09-27', 37000, 10000), bill('2026-11-04', 40000, 11000, { deferred: 15000 }),
];
const REC = { '2026-04': 800000, '2026-05': 1100000, '2026-06': 1250000, '2026-07': 2180000, '2026-08': 840000, '2026-09': 700000, '2026-10': 750000, '2026-02': 600000, '2026-01': 700000 };
test('BAS profile: the share of last month\'s receipts comes from the CURRENT monthly run only (quarterly payments are ignored)', () => {
  const p = H.basProfile(BAS_BILLS, REC, '2026-11-09');
  // monthly run = May … Nov: ratios 60/800=7.5%, 74/1100=6.7%, 80/1250=6.4%, 181/2180=8.3%, 37/840=4.4%, 55/700=7.9%  (Nov GST = 40k + deferred 15k, against Oct 750k = 7.3%)
  assert.strictEqual(p.gstRatioMonths, 6);
  assert.ok(p.gstRatio > 0.065 && p.gstRatio < 0.075, `median ratio ${p.gstRatio}`);
  assert.deepStrictEqual(p.billMonths.slice(-3), ['2026-08', '2026-09', '2026-11']);
});
test('BAS profile: GST counts the GST, GST-adjustment and deferred-GST lines; PAYG is the last 3 months ÷ 3; fees are ignored', () => {
  const p = H.basProfile(BAS_BILLS, REC, '2026-11-09');
  const gstYear = 104000 + 101000 + 14000 + 45000 + 74000 + 80000 + 181000 + 37000 + 40000 + 15000;   // bills dated in the last 365 days
  assert.ok(Math.abs(p.gstMonthlyAvg - gstYear / 12) < 1, `${p.gstMonthlyAvg} vs ${gstYear / 12}`);
  assert.ok(Math.abs(p.paygMonthly - (14000 + 10000 + 11000) / 3) < 1, 'Aug 21 + Sep 27 + Nov 4 are the PAYG lines in the last 90 days');
});
test('BAS profile: too little monthly history, no receipts for those months, or an old last payment means no ratio (the average is used instead)', () => {
  assert.strictEqual(H.basProfile(BAS_BILLS.slice(0, 5), REC, '2026-05-30').gstRatio, null, 'only 1–2 monthly payments so far');
  assert.strictEqual(H.basProfile(BAS_BILLS, {}, '2026-11-09').gstRatio, null, 'no receipts to compare with');
  assert.strictEqual(H.basProfile(BAS_BILLS, REC, '2027-03-09').gstRatio, null, 'the last BAS was over 75 days ago — the cadence may have changed');
  assert.ok(H.basProfile(BAS_BILLS, {}, '2026-11-09').gstMonthlyAvg > 0);
});
test('BAS profile: a ratio is capped at 12%, bills without line items fall back to their totals, and nothing in = zeros', () => {
  const big = [bill('2026-05-21', 500000, 0), bill('2026-06-21', 600000, 0), bill('2026-07-21', 700000, 0)];
  assert.strictEqual(H.basProfile(big, { '2026-04': 1000000, '2026-05': 1000000, '2026-06': 1000000 }, '2026-07-30').gstRatio, 0.12);
  const noLines = [{ date: '2026-06-01', total: 24000, lines: [] }, { date: '2026-08-01', total: 12000, lines: [] }];
  const p = H.basProfile(noLines, {}, '2026-08-15');
  assert.deepStrictEqual([p.gstMonthlyAvg, p.paygMonthly], [3000, 0]);
  assert.deepStrictEqual(H.basProfile([], {}, '2026-11-09'), { gstRatio: null, gstRatioMonths: 0, gstMonthlyAvg: 0, paygMonthly: 0, billMonths: [], count: 0 });
  assert.strictEqual(H.basProfile([bill('2027-01-01', 5000, 0)], {}, '2026-11-09').gstMonthlyAvg, 0, 'a bill dated in the future is not history');
});
console.log(`\n${n} passing${process.exitCode ? ' — with failures' : ''}`);
