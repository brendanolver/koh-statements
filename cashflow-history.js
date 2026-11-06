/* Cashflow history — last year's cash in / cash out, month by month. Pure functions, no DOM, no network.
 *
 * Turns what Xero already holds (the BankSummary report for each month, direct receive/spend bank
 * transactions, and the payments recorded against customer invoices and supplier bills) into one row per
 * calendar month on the same "what actually moved through the bank" basis the forecast uses, so a forecast
 * month can sit next to the same month last year.
 *
 * What is exact and what is estimated (checked against a year of this org's real data):
 *   - Total cash in / out and the closing balance are straight from BankSummary — exact.
 *   - Online = direct receipts from online contacts (Shopify payouts, Afterpay, PayPal…) + any invoice
 *     payments from them; Wholesale = payments on customer invoices. Other in is whatever is left of the
 *     bank's cash received (loan money, owner contributions, transfers in) — so it always adds up.
 *   - Amex payments = money moved into the credit-card accounts (their BankSummary "cash received" less any
 *     direct refunds), i.e. what left the bank to pay the cards.
 *   - Stock payments = supplier bill payments, less the bills that were paid with a card (those left the
 *     bank later, as part of the Amex payment). Other out is the rest of what left the bank: wages, tax,
 *     drawings, loan repayments, anything paid direct.
 *
 * Loaded by index.html as a plain script (window.CFH) and by tests/cashflow-history.test.js.
 */
(function (root) {
  'use strict';

  const r2 = (n) => Math.round(n * 100) / 100;
  const DEFAULT_ONLINE_RE = /ONLINE SALES|SHOPIFY|AFTERPAY|PAYPAL|KLARNA|STRIPE/i;
  const DEFAULT_MARKETING_RE = /FACEBOOK|FACEBK|\bMETA\b|GOOGLE|TIKTOK|KLAVIYO|SNAPCHAT|PINTEREST|INFLUENCER|AFFILIATE|MARKETING|ADVERT/i;
  const DEFAULT_TAX_RE = /\bATO\b|AUSTRALIAN TAX|TAXATION OFFICE|\bPAYG\b/i;

  // Xero dates arrive as /Date(ms+0000)/ (UTC midnight of the calendar day), or as DateString.
  function xeroIso(raw) {
    if (!raw) return null;
    const m = /\/Date\((-?\d+)/.exec(String(raw));
    const d = m ? new Date(Number(m[1])) : new Date(raw);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const monthKey = (iso) => iso.slice(0, 7);
  const addMonths = (mk, n) => { const [y, m] = mk.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
  const lastDayOfMonth = (mk) => { const [y, m] = mk.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

  // The calendar months to show: the last 12 complete months, plus the month in progress.
  function monthsFor(today) {
    const cur = monthKey(today);
    const out = [];
    for (let k = -12; k <= 0; k++) out.push(addMonths(cur, k));
    return out;
  }

  // Money applied to invoices / bills: one entry per payment, in AUD, dated by when it was paid.
  // A payment in a foreign currency is converted at its own rate (Xero's rate is foreign units per 1 AUD).
  function paymentsOf(invoices, warnings, kind) {
    const out = [];
    for (const inv of invoices || []) {
      const cur = String(inv.CurrencyCode || 'AUD').toUpperCase();
      for (const p of inv.Payments || []) {
        if (p.Status === 'DELETED') continue;
        const date = xeroIso(p.Date);
        if (!date) continue;
        let aud = Number(p.Amount) || 0;
        if (cur !== 'AUD') {
          const rate = Number(p.CurrencyRate) > 0 && Number(p.CurrencyRate) !== 1 ? Number(p.CurrencyRate) : Number(inv.CurrencyRate) || 0;
          if (!(rate > 0)) { warnings.push(`${kind} payment of ${aud} ${cur} on ${date} left out: no exchange rate`); continue; }
          aud = aud / rate;
        }
        out.push({ date, aud, contact: (inv.Contact && inv.Contact.Name) || '' });
      }
    }
    return out;
  }

  const idSet = (v) => (v instanceof Set ? v : new Set(v || []));

  // One account per row of Xero's BankSummary report: opening balance, cash received, cash spent, closing balance.
  function parseBankSummary(data) {
    const sections = (data && data.Reports && data.Reports[0] && data.Reports[0].Rows) || [];
    const out = [];
    for (const section of sections) {
      if (section.RowType !== 'Section') continue;
      for (const row of section.Rows || []) {
        if (row.RowType !== 'Row') continue;
        const cells = row.Cells || [];
        const acct = cells[0] && cells[0].Attributes && cells[0].Attributes.find((a) => a.Id === 'accountID');
        if (!acct) continue;
        const n = (i) => parseFloat(cells[i] && cells[i].Value) || 0;
        out.push({ id: acct.Value, name: cells[0].Value, open: n(1), rec: n(2), sp: n(3), close: n(4) });
      }
    }
    return out;
  }

  /* input = {
   *   months: ['2025-11', … '2026-11'],           // oldest first; the last may be the month in progress
   *   today: '2026-11-06',
   *   summaries: { '2025-11': [{ id, open, rec, sp, close }, …], … }, // BankSummary rows per month
   *   bankIds, cardIds,                          // cash accounts (not cards) and credit-card accounts
   *   recv, spend,                               // Xero bank transactions (Type RECEIVE / SPEND)
   *   arInvoices, apInvoices,                    // Xero invoices / bills with their Payments
   *   onlineRe?, marketingRe?, taxRe?
   * } */
  function buildMonthly(input) {
    const bankIds = idSet(input.bankIds), cardIds = idSet(input.cardIds);
    const onlineRe = input.onlineRe || DEFAULT_ONLINE_RE;
    const marketingRe = input.marketingRe || DEFAULT_MARKETING_RE;
    const taxRe = input.taxRe || DEFAULT_TAX_RE;
    const warnings = [];
    const arPay = paymentsOf(input.arInvoices, warnings, 'Customer');
    const apPay = paymentsOf(input.apInvoices, warnings, 'Supplier');
    const bt = (rows) => (rows || []).filter((t) => (!t.Status || t.Status === 'AUTHORISED') && t.BankAccount)
      .map((t) => ({ date: xeroIso(t.DateString || t.Date), amount: Number(t.Total) || 0, acct: t.BankAccount.AccountID, contact: (t.Contact && t.Contact.Name) || '' }))
      .filter((t) => t.date);
    const recv = bt(input.recv), spend = bt(input.spend);
    const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

    const months = [];
    for (const mk of input.months) {
      const rows = (input.summaries && input.summaries[mk]) || [];
      const inM = (x) => monthKey(x.date) === mk;
      const bankRows = rows.filter((r) => bankIds.has(r.id)), cardRows = rows.filter((r) => cardIds.has(r.id));
      const opening = sum(bankRows, (r) => r.open), closing = sum(bankRows, (r) => r.close);
      const received = sum(bankRows, (r) => r.rec), spent = sum(bankRows, (r) => r.sp);

      // Cash in
      const recvBank = recv.filter((t) => inM(t) && bankIds.has(t.acct));
      const online = sum(recvBank.filter((t) => onlineRe.test(t.contact)), (t) => t.amount)
        + sum(arPay.filter((p) => inM(p) && onlineRe.test(p.contact)), (p) => p.aud);
      const wholesale = sum(arPay.filter((p) => inM(p) && !onlineRe.test(p.contact)), (p) => p.aud);
      const otherIn = received - online - wholesale; // loans, owner money, transfers in — whatever else arrived

      // Cash out
      const cardsReceived = sum(cardRows, (r) => r.rec), cardsSpent = sum(cardRows, (r) => r.sp);
      const cardRefunds = sum(recv.filter((t) => inM(t) && cardIds.has(t.acct)), (t) => t.amount);
      const cardPayments = cardsReceived - cardRefunds; // bank → cards
      const cardSpendRows = spend.filter((t) => inM(t) && cardIds.has(t.acct));
      const cardDirectSpend = sum(cardSpendRows, (t) => t.amount);
      const cardPaidBills = Math.max(0, cardsSpent - cardDirectSpend); // bills settled with a card rather than the bank
      const supplierPaid = sum(apPay.filter((p) => inM(p) && !taxRe.test(p.contact)), (p) => p.aud);
      const stock = Math.max(0, supplierPaid - cardPaidBills);
      const otherOut = spent - stock - cardPayments;
      // The same month in the forecast engine's own terms, which count spend when it is charged (card spend
      // included) rather than when it leaves the bank: Stock = every supplier payment however it was paid,
      // Marketing / Other out = direct spend from the bank plus card spend. This is what a forecast month is
      // planned from.
      const bankMarketing = sum(spend.filter((t) => inM(t) && bankIds.has(t.acct) && marketingRe.test(t.contact)), (t) => t.amount);
      const cardMarketing = sum(cardSpendRows.filter((t) => marketingRe.test(t.contact)), (t) => t.amount);

      // Cross-check: everything we can name that left the bank, against what BankSummary says did.
      const directBankSpend = sum(spend.filter((t) => inM(t) && bankIds.has(t.acct)), (t) => t.amount);
      const allSupplierPaid = sum(apPay.filter(inM), (p) => p.aud);
      const unmatchedOut = spent - directBankSpend - Math.max(0, allSupplierPaid - cardPaidBills) - cardPayments;
      const unmatchedIn = received - sum(recvBank, (t) => t.amount) - sum(arPay.filter(inM), (p) => p.aud);

      months.push({
        month: mk,
        partial: mk === monthKey(input.today),
        opening: r2(opening), closing: r2(closing),
        online: r2(online), wholesale: r2(wholesale), otherIn: r2(otherIn), totalIn: r2(received),
        stock: r2(stock), cards: r2(cardPayments), otherOut: r2(otherOut), totalOut: r2(spent),
        net: r2(received - spent),
        memo: {
          cardMarketing: r2(cardMarketing),
          cardOther: r2(sum(cardSpendRows.filter((t) => !marketingRe.test(t.contact)), (t) => t.amount) + cardPaidBills),
        },
        eng: {
          online: r2(online), wholesale: r2(wholesale), stock: r2(supplierPaid),
          marketing: r2(bankMarketing + cardMarketing),
          otherOut: r2(Math.max(0, otherOut - bankMarketing + cardDirectSpend - cardMarketing)),
        },
        check: { unmatchedIn: r2(unmatchedIn), unmatchedOut: r2(unmatchedOut), noSummary: rows.length === 0 },
      });
    }
    for (const m of months) {
      if (m.check.noSummary) warnings.push(`No bank summary came back for ${m.month}`);
      else if (Math.abs(m.check.unmatchedOut) > Math.max(10000, 0.1 * m.totalOut)) warnings.push(`${m.month}: ${Math.round(m.check.unmatchedOut)} of cash out couldn't be matched to a transaction`);
    }
    return { months, warnings };
  }

  // ---------------------------------------------------------------------------------------------
  // Table rows for the Year view: the actual months, then the forecast months from the engine's
  // monthly buckets (CFE.buckets(result, 'months12')) for one scenario, each with the same month a
  // year earlier alongside.
  // The forecast's lines map onto the bank basis like this: Stock = stock, Amex payments = cards, and
  // Other out = marketing + other cash out + card credit (the card spend that is paid later through
  // the Amex payments, entered as a negative so it isn't counted twice).
  const FIELDS = ['online', 'wholesale', 'otherIn', 'totalIn', 'stock', 'cards', 'otherOut', 'totalOut', 'net', 'closing'];

  function forecastRow(b, scn) {
    const s = b.byScenario[scn];
    const online = s.online, wholesale = s.wholesale, otherIn = s.otherIn;
    const stock = s.stock, cards = s.cards, otherOut = s.marketing + s.otherOut + s.cardCredit;
    return {
      month: b.month, partial: b.start !== b.month + '-01',
      online, wholesale, otherIn, totalIn: online + wholesale + otherIn,
      stock, cards, otherOut, totalOut: stock + cards + otherOut,
      net: s.net, closing: s.closing,
    };
  }

  function yearRows(history, buckets, scn) {
    const byMonth = {};
    for (const m of history || []) byMonth[m.month] = m;
    const rows = (history || []).map((m) => ({ kind: 'actual', ...m }));
    for (const b of buckets || []) {
      const row = { kind: 'forecast', ...forecastRow(b, scn) };
      const ly = byMonth[addMonths(b.month, -12)];
      // Last year's same month — only for a full forecast month (the first one is just "the rest of this month").
      if (ly && !row.partial && !ly.partial) row.lastYear = Object.fromEntries(FIELDS.map((f) => [f, ly[f]]));
      rows.push(row);
    }
    return rows;
  }

  function totals(rows) {
    const t = Object.fromEntries(FIELDS.map((f) => [f, 0]));
    for (const r of rows) for (const f of FIELDS) if (f !== 'closing') t[f] += r[f] || 0;
    t.closing = rows.length ? rows[rows.length - 1].closing : 0;
    return t;
  }

  root.CFH = { buildMonthly, parseBankSummary, monthsFor, paymentsOf, forecastRow, yearRows, totals, xeroIso, monthKey, addMonths, lastDayOfMonth, FIELDS, DEFAULT_ONLINE_RE, DEFAULT_MARKETING_RE, DEFAULT_TAX_RE };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.CFH;
})(typeof window !== 'undefined' ? window : globalThis);
