// Run with:  node tests/statement-email.test.js
// The statement email's wording: the standard overdue nudge stays exactly as it was, and a customer who is overdue
// AND has stock on hold gets the urgent "release your stock once you're back within terms" version.
const assert = require('assert');
const E = require('../netlify/functions/lib/statement-email.js');
let n = 0;
const test = (name, fn) => { try { fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };

const asAt = new Date('2026-11-09T00:00:00');
const base = { customerName: 'Acme Pty Ltd', contactFirstName: 'Sam', balanceDue: 1234.5, attachedInvoiceCount: 2, currency: 'AUD', asAt };
const body = (extra) => E.emailBodyHtml(Object.assign({}, base, extra));

const STANDARD_1 = 'You have received this email because you have overdue invoices &amp; your account could be on hold, which means we cannot deliver any more stock until the overdue invoices are paid.';
const STANDARD_2 = 'Can you please advise via return email when you will be making payment to bring your account back within our trading terms?';

test('overdue only: the standard wording, exactly as before', () => {
  const h = body({ overdue: 500 });
  assert.ok(h.includes(STANDARD_1) && h.includes(STANDARD_2));
  assert.ok(!h.includes('Your stock is on hold'));
});
test('no overdue and no hold: neither message', () => {
  const h = body({ overdue: 0 });
  assert.ok(!h.includes(STANDARD_1) && !h.includes('Your stock is on hold'));
});
test('stock on hold AND overdue: the urgent wording replaces the standard one', () => {
  const h = body({ overdue: 4567.8, holdTotal: 12345, holdCount: 3 });
  assert.ok(h.includes('Your stock is on hold'));
  assert.ok(h.includes("We're holding $12,345.00 AUD of your stock (3 orders) and can't release it while your account is outside our trading terms."));
  assert.ok(h.includes('You currently have $4,567.80 AUD overdue.'));
  assert.ok(h.includes("As soon as your overdue invoices are paid we'll release your held stock"));
  assert.ok(h.includes("reply today with the date you'll be making payment"));
  assert.ok(!h.includes(STANDARD_1) && !h.includes(STANDARD_2), 'one message, not both');
});
test('one held order reads "1 order"; an unknown count leaves the bracket out', () => {
  assert.ok(body({ overdue: 10, holdTotal: 100, holdCount: 1 }).includes('of your stock (1 order) and'));
  assert.ok(body({ overdue: 10, holdTotal: 100 }).includes('of your stock and can\'t release'));
});
test('stock on hold but NOTHING overdue gets no "back within terms" message (it would not be true for them)', () => {
  const h = body({ overdue: 0, holdTotal: 900, holdCount: 2 });
  assert.ok(!h.includes('Your stock is on hold') && !h.includes(STANDARD_1) && !h.includes('back within'));
});
test('the currency follows the customer (NZD, USD…) and defaults to AUD', () => {
  assert.ok(body({ overdue: 10, holdTotal: 100, currency: 'NZD' }).includes('$100.00 NZD of your stock'));
  assert.ok(E.holdLines({ holdTotal: 100, overdue: 10 }).why.includes('$100.00 AUD'));
});
test('the rest of the email is untouched by the hold wording (greeting, balance, attachments line, sign-off)', () => {
  const plain = body({ overdue: 500 });
  const urgent = body({ overdue: 500, holdTotal: 1000, holdCount: 1 });
  for (const keep of ['Hi Sam,', 'Here\'s your statement as at 9 November 2026', 'Balance Due AUD', '$1,234.50', 'Copies of the 2 underlying invoices', 'If you have any questions', 'Brendan Olver']) {
    assert.ok(plain.includes(keep) && urgent.includes(keep), keep);
  }
});
test('subject line: urgent only for stock on hold AND overdue; otherwise unchanged', () => {
  assert.strictEqual(E.emailSubject({ customerName: 'Acme', holdTotal: 1000, overdue: 50 }), 'Action needed: your stock is on hold — Statement from KOH Industries — Acme');
  assert.strictEqual(E.emailSubject({ customerName: 'Acme', holdTotal: 0, overdue: 50 }), 'Statement from KOH Industries — Acme');
  assert.strictEqual(E.emailSubject({ customerName: 'Acme', holdTotal: 1000, overdue: 0 }), 'Statement from KOH Industries — Acme');
  assert.strictEqual(E.emailSubject({ customerName: 'Acme' }), 'Statement from KOH Industries — Acme');
});
test('odd inputs (strings, negatives, missing) are treated as "no hold"', () => {
  assert.strictEqual(E.isHoldCase({ holdTotal: '1200', overdue: '30' }), true, 'numbers sent as text still count');
  for (const bad of [{ holdTotal: -5, overdue: 10 }, { holdTotal: 'abc', overdue: 10 }, { holdTotal: null, overdue: 10 }, {}, { holdTotal: 10, overdue: -1 }]) assert.strictEqual(E.isHoldCase(bad), false);
});

console.log(`\n${n} passing${process.exitCode ? ' — with failures' : ''}`);
