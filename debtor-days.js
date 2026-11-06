/* Average days to pay — pure functions, no DOM, no network.
 *
 * From the customer invoices Xero marks as fully paid, works out how long each customer really takes to
 * pay: days from the invoice date to the day it was fully paid, and how that sits against the due date
 * (positive = paid after it was due). One average per customer, plus an overall figure, built by adding
 * up days and invoice counts — so any group of customers (everyone, those on stop…) can be combined
 * exactly, with each invoice counting once.
 *
 * Loaded by index.html as a plain script (window.DDP) and by tests/debtor-days.test.js.
 */
(function (root) {
  'use strict';

  const DAY = 86400000;

  // Xero dates arrive as /Date(ms+0000)/ (UTC midnight of the calendar day).
  function xeroIso(raw) {
    if (!raw) return null;
    const m = /\/Date\((-?\d+)/.exec(String(raw));
    const d = m ? new Date(Number(m[1])) : new Date(raw);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);

  // One paid invoice → the few facts needed, or null if it can't be used (not paid, or no dates).
  // The paid date is Xero's FullyPaidOnDate, or the last payment's date if that is missing.
  function rowFrom(inv) {
    if (!inv || !inv.Contact || !inv.Contact.ContactID) return null;
    if (inv.Status && inv.Status !== 'PAID') return null;
    const date = xeroIso(inv.DateString || inv.Date);
    if (!date) return null;
    let paid = xeroIso(inv.FullyPaidOnDate);
    if (!paid) {
      const dates = (inv.Payments || []).filter((p) => p.Status !== 'DELETED').map((p) => xeroIso(p.Date)).filter(Boolean).sort();
      paid = dates.length ? dates[dates.length - 1] : null;
    }
    if (!paid) return null;
    return { c: inv.Contact.ContactID, d: date, due: xeroIso(inv.DueDateString || inv.DueDate), paid };
  }

  // Rows → { byContact: { id: { n, days, late, nLate } }, n, days, late, nLate }.
  // A payment dated before its invoice counts as 0 days; "late" can be negative (paid early).
  function aggregate(rows) {
    const total = { n: 0, days: 0, late: 0, nLate: 0 };
    const byContact = {};
    for (const r of rows || []) {
      if (!r) continue;
      const days = Math.max(0, daysBetween(r.d, r.paid));
      const e = byContact[r.c] || (byContact[r.c] = { n: 0, days: 0, late: 0, nLate: 0 });
      e.n++; e.days += days; total.n++; total.days += days;
      if (r.due) { const late = daysBetween(r.due, r.paid); e.late += late; e.nLate++; total.late += late; total.nLate++; }
    }
    return { byContact, ...total };
  }

  // Add up a set of customers (ids) from the per-customer figures.
  function combine(byContact, ids) {
    const t = { n: 0, days: 0, late: 0, nLate: 0 };
    for (const id of ids || []) {
      const e = byContact && byContact[id];
      if (!e) continue;
      t.n += e.n; t.days += e.days; t.late += e.late; t.nLate += e.nLate;
    }
    return t;
  }

  // The averages for one entry (or a combined total): whole days, plus how many invoices they rest on.
  function avg(e) {
    if (!e || !e.n) return null;
    return { n: e.n, days: Math.round(e.days / e.n), late: e.nLate ? Math.round(e.late / e.nLate) : null };
  }

  // Colour band for a customer's lateness: pays on or before the due date, up to two weeks late, or later still.
  function band(a) {
    if (!a || a.late === null) return 'none';
    return a.late <= 0 ? 'ok' : a.late <= 14 ? 'warn' : 'bad';
  }

  // "12 paid invoices in the last 12 months · paid 9 days after the due date, on average"
  function describe(a) {
    if (!a) return 'No invoices paid in the last 12 months';
    const inv = `${a.n} paid invoice${a.n === 1 ? '' : 's'} in the last 12 months`;
    if (a.late === null) return inv;
    const when = a.late === 0 ? 'on the due date' : `${Math.abs(a.late)} day${Math.abs(a.late) === 1 ? '' : 's'} ${a.late > 0 ? 'after' : 'before'} the due date`;
    return `${inv} · paid ${when}, on average`;
  }

  root.DDP = { xeroIso, daysBetween, rowFrom, aggregate, combine, avg, band, describe };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.DDP;
})(typeof window !== 'undefined' ? window : globalThis);
