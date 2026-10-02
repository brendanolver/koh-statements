// Server-side port of the Debtors tab's buildDebtorsList() (index.html) so other
// apps (the WMS) can show the same figures. Keep the bucketing rules in step
// with that function — they are intentionally identical.

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Xero returns dates as /Date(ms+0000)/ — midnight UTC of the calendar date.
function xeroIso(raw) {
  if (!raw) return null;
  const m = /\/Date\((-?\d+)/.exec(String(raw));
  const d = m ? new Date(Number(m[1])) : new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function todayIso(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(now);
}

function bucketLabels(today) {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)) - 1;
  const labels = [];
  for (let i = 0; i < 4; i++) {
    const d = new Date(Date.UTC(y, m - i, 1));
    labels.push(`${MONTH_NAMES[d.getUTCMonth()].toUpperCase()} ${d.getUTCFullYear()}`);
  }
  labels.push('OLDER');
  return labels;
}

function bucketIndex(invIso, today) {
  if (!invIso) return 0;
  const monthsBack = (Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7))) - (Number(invIso.slice(0, 4)) * 12 + Number(invIso.slice(5, 7)));
  if (monthsBack <= 0) return 0;
  if (monthsBack >= 4) return 4;
  return monthsBack;
}

const round2 = (n) => Math.round(n * 100) / 100;

function buildDebtors({ openInvoices, submittedInvoices, creditNotes, today }) {
  const byContact = new Map();
  const entryFor = (contact) => {
    const contactId = contact && contact.ContactID;
    const name = contact && contact.Name;
    if (!contactId || !name) return null;
    if (!byContact.has(contactId)) {
      byContact.set(contactId, { contactId, name, total: 0, overdue: 0, holdTotal: 0, buckets: [0, 0, 0, 0, 0], currency: null });
    }
    return byContact.get(contactId);
  };

  for (const inv of openInvoices) {
    const e = entryFor(inv.Contact);
    if (!e) continue;
    const due = inv.AmountDue || 0;
    e.total += due;
    e.buckets[bucketIndex(xeroIso(inv.Date), today)] += due;
    const dueIso = xeroIso(inv.DueDate);
    if (dueIso && dueIso < today) e.overdue += due;
    if (!e.currency && inv.CurrencyCode) e.currency = inv.CurrencyCode;
  }

  // Credit notes net into their own invoice-date bucket and reduce Total, but
  // never Overdue (a credit note has no due date).
  for (const cn of creditNotes) {
    const e = entryFor(cn.Contact);
    if (!e) continue;
    const remaining = -(cn.RemainingCredit || 0);
    e.total += remaining;
    e.buckets[bucketIndex(xeroIso(cn.Date), today)] += remaining;
    e.creditCount = (e.creditCount || 0) + 1;
    e.creditTotal = (e.creditTotal || 0) + (cn.RemainingCredit || 0);
    if (!e.currency && cn.CurrencyCode) e.currency = cn.CurrencyCode;
  }

  // A customer with stock on hold but nothing owing must still appear.
  for (const inv of submittedInvoices) {
    const e = entryFor(inv.Contact);
    if (!e) continue;
    e.holdTotal += inv.Total || 0;
    if (!e.currency && inv.CurrencyCode) e.currency = inv.CurrencyCode;
  }

  return Array.from(byContact.values())
    .map((d) => ({
      contactId: d.contactId,
      name: d.name,
      total: round2(d.total),
      overdue: round2(d.overdue),
      holdTotal: round2(d.holdTotal),
      buckets: d.buckets.map(round2),
      currency: d.currency || 'AUD',
      creditCount: d.creditCount || 0,
      creditTotal: round2(d.creditTotal || 0),
    }))
    .sort((a, b) => b.overdue - a.overdue);
}

// Eligible for stop-supply review = any balance invoiced 2+ calendar months back.
const isEligible = (d) => (d.buckets[2] || 0) + (d.buckets[3] || 0) + (d.buckets[4] || 0) > 0;

const normName = (name) => String(name || '').trim().toUpperCase();

// Layers the live Stop/Clear marks and the hidden-customers list on top of the
// (cached) Xero-derived rows, and computes the headline stats exactly as the
// Debtors tab does.
function decorate(rows, statusMap, hiddenMap) {
  const hidden = hiddenMap || {};
  const statuses = statusMap || {};
  const debtors = rows
    .filter((d) => !hidden[normName(d.name)])
    .map((d) => ({ ...d, status: statuses[d.contactId] || null, eligible: isEligible(d) }));
  let stopN = 0, clearN = 0, stopAmt = 0, eligibleN = 0;
  for (const d of debtors) {
    if (!d.eligible) continue;
    eligibleN++;
    if (d.status === 'stop') { stopN++; stopAmt += d.total; } else if (d.status === 'clear') clearN++;
  }
  return {
    debtors,
    stats: {
      onStop: stopN,
      cleared: clearN,
      pending: eligibleN - stopN - clearN,
      stockOnHold: debtors.filter((d) => d.holdTotal > 0).length,
      totalOnStop: round2(stopAmt),
      eligible: eligibleN,
    },
    hiddenCount: rows.length - debtors.length,
  };
}

module.exports = { xeroIso, todayIso, bucketLabels, bucketIndex, buildDebtors, decorate, isEligible, normName };
