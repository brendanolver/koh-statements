// Run with:  node tests/sms.test.js
// SMS helpers: telling mobiles from landlines (AU and NZ), cleaning numbers up, the overdue / stock-on-hold
// message wording, and counting message parts. Numbers below are the ones Australia reserves for TV and film
// (0491 570 xxx) plus made-up landlines — none belong to a real person.
const assert = require('assert');
const S = require('../netlify/functions/lib/sms.js');
let n = 0;
const test = (name, fn) => { try { fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };

test('Australian mobiles in every common spelling come out the same', () => {
  for (const raw of ['0491 570 156', '0491570156', '+61 491 570 156', '+61491570156', '61491570156', '0061 491 570 156', '+61 (0)491 570 156', '(0491) 570-156', '491570156', ' 0491.570.156 ']) {
    const r = S.normaliseMobile(raw, 'Australia');
    assert.ok(r.ok, raw);
    assert.strictEqual(r.e164, '+61491570156', raw);
  }
  const r = S.normaliseMobile('0491 570 156');
  assert.deepStrictEqual([r.digits, r.display, r.country], ['61491570156', '+61 491 570 156', 'AU'], 'no country given = Australia');
});
test('New Zealand mobiles: the customer country decides what a leading 0 means', () => {
  const r = S.normaliseMobile('021 234 5678', 'New Zealand');
  assert.deepStrictEqual([r.ok, r.e164, r.display, r.country], [true, '+64212345678', '+64 21 234 5678', 'NZ']);
  assert.strictEqual(S.normaliseMobile('+64 21 234 5678', 'Australia').e164, '+64212345678', 'an international number keeps its own country');
  assert.strictEqual(S.normaliseMobile('0272345678', 'NZ').e164, '+64272345678');
  assert.strictEqual(S.normaliseMobile('212345678', 'NZ').e164, '+64212345678', 'leading 0 dropped by a spreadsheet');
});
test('landlines are recognised so a text is never sent to one', () => {
  for (const [raw, c] of [['03 5333 1234', 'Australia'], ['(02) 9999 1234', 'AU'], ['07 3333 1234', 'AU'], ['08 9333 1234', 'AU'], ['+61 3 5333 1234', 'AU'], ['09 123 4567', 'NZ'], ['03 345 6789', 'New Zealand'], ['04 123 4567', 'NZ']]) {
    const r = S.normaliseMobile(raw, c);
    assert.strictEqual(r.ok, false, raw);
    assert.strictEqual(r.reason, 'landline', raw);
    assert.ok(/landline/i.test(r.note));
  }
});
test('the same 02 number is a landline in Australia and a mobile in New Zealand', () => {
  assert.strictEqual(S.normaliseMobile('02 9999 1234', 'Australia').reason, 'landline');
  assert.strictEqual(S.normaliseMobile('021 999 1234', 'New Zealand').ok, true);
});
test('rubbish, blanks, 13/1300 numbers and other countries are rejected with a reason', () => {
  assert.strictEqual(S.normaliseMobile('', 'AU').reason, 'empty');
  assert.strictEqual(S.normaliseMobile(null).reason, 'empty');
  assert.strictEqual(S.normaliseMobile('abc', 'AU').reason, 'invalid');
  assert.strictEqual(S.normaliseMobile('0491 570', 'AU').reason, 'invalid', 'too short');
  assert.strictEqual(S.normaliseMobile('0491 570 156 99', 'AU').reason, 'invalid', 'too long');
  assert.strictEqual(S.normaliseMobile('1300 123 456', 'AU').reason, 'invalid');
  assert.strictEqual(S.normaliseMobile('+44 7911 123456', 'AU').reason, 'unsupported');
  assert.strictEqual(S.normaliseMobile('+1 415 555 0132', 'AU').reason, 'unsupported');
});
test('suggestMobile takes the first usable number, skipping landlines and junk, and says where it came from', () => {
  const s = S.suggestMobile([{ value: '03 5333 1234', source: 'Xero' }, { value: 'n/a', source: 'Xero' }, { value: '0491 570 157', source: 'ApparelMagic' }, { value: '0491 570 158', source: 'x' }], 'Australia');
  assert.deepStrictEqual([s.e164, s.source, s.display], ['+61491570157', 'ApparelMagic', '+61 491 570 157']);
  assert.strictEqual(S.suggestMobile([{ value: '03 5333 1234' }], 'AU'), null);
  assert.strictEqual(S.suggestMobile(null, 'AU'), null);
});

test('looksLikeName: first names pass; stores, departments, numbers and junk do not', () => {
  for (const ok of ['Sam', 'SAM', 'sam', 'Anne-Marie', "O'Brien", 'Sam Jo', 'Zoë'.replace('ë', 'e')]) assert.strictEqual(S.looksLikeName(ok), true, ok);
  for (const bad of ['', '  ', null, undefined, 'Accounts Payable', 'accounts', 'Reception', 'Sole Provider Pty Ltd', 'Surf Shop', 'Sam & Jo', 'Sam Jo Lee', 'S', 'Level 2', 'info@store.com', 'The Store', 'Manager']) assert.strictEqual(S.looksLikeName(bad), false, String(bad));
});
test('tidyName fixes shouting and lower case but leaves proper names alone', () => {
  assert.strictEqual(S.tidyName('SAM'), 'Sam');
  assert.strictEqual(S.tidyName('sam'), 'Sam');
  assert.strictEqual(S.tidyName('ANNE-MARIE'), 'Anne-Marie');
  assert.strictEqual(S.tidyName("o'brien"), "O'Brien");
  assert.strictEqual(S.tidyName('  jo   ann '), 'Jo Ann');
  assert.strictEqual(S.tidyName('McKenzie'), 'McKenzie', 'mixed case is left as typed');
  assert.strictEqual(S.tidyName('Sam'), 'Sam');
  assert.strictEqual(S.tidyName(null), '');
});
test('suggestName takes the first candidate that reads like a name and says where it came from', () => {
  const s = S.suggestName([{ value: '', source: 'Xero' }, { value: 'Accounts', source: 'Xero contact person' }, { value: 'ALEX', source: 'ApparelMagic' }, { value: 'jo', source: 'x' }]);
  assert.deepStrictEqual(s, { name: 'Alex', source: 'ApparelMagic' });
  assert.strictEqual(S.suggestName([{ value: 'Reception' }, { value: '' }]), null);
  assert.strictEqual(S.suggestName(null), null);
});
const B = (o) => S.buildMessage(Object.assign({ template: 'firm', greet: 'Sam', overdue: 6210.4, holdTotal: 12980.5, currency: 'AUD', country: 'Australia', priorReminders: 0 }, o));
const PH = '0418 519939';

test('Friendly Reminder: wording with stock on hold, and without', () => {
  assert.strictEqual(B({ template: 'friendly' }).text,
    `Hi Sam, Brendan from WNDRR. Just following up on your overdue balance of $6,210.40. We've also got $12,980.50 of stock ready to go, but can't release it until the account is brought up to date. Can you let me know when we can expect payment? Give me a call on ${PH} if you need to discuss. Cheers, Brendan.`);
  assert.strictEqual(B({ template: 'friendly', holdTotal: 0 }).text,
    `Hi Sam, Brendan from WNDRR. Just following up on your overdue balance of $6,210.40. Can you let me know when we can expect payment? Give me a call on ${PH} if you need to discuss. Cheers, Brendan.`);
});
test('Firm Reminder (the standard one): wording with stock on hold, and without', () => {
  assert.strictEqual(B({ template: 'firm' }).text,
    `Hi Sam, your WNDRR account has an overdue balance of $6,210.40, with $12,980.50 of stock currently on hold. Please arrange payment today so we can release your stock. If there's an issue with payment, please call me on ${PH}. Thanks, Brendan.`);
  assert.strictEqual(B({ template: 'firm', holdTotal: 0 }).text,
    `Hi Sam, your WNDRR account has an overdue balance of $6,210.40. Please arrange payment today. If there's an issue with payment, please call me on ${PH}. Thanks, Brendan.`);
  assert.strictEqual(B({ template: undefined }).template, 'firm', 'firm when nothing is chosen');
  assert.strictEqual(B({ template: 'nonsense' }).template, 'firm', 'and for an unknown name');
});
test('Final Reminder: says "despite previous reminders" only when earlier texts are on record', () => {
  const withPrior = B({ template: 'final', priorReminders: 2 });
  assert.strictEqual(withPrior.text,
    `Hi Sam, Brendan from WNDRR. Your account remains overdue by $6,210.40 despite previous reminders. Your outstanding orders totalling $12,980.50 remain on hold. We require payment or a confirmed payment arrangement today to avoid further account action. Please contact me directly on ${PH}. Brendan.`);
  assert.strictEqual(withPrior.leftOutPriorReminders, false);
  const noPrior = B({ template: 'final', priorReminders: 0 });
  assert.ok(!/previous reminders|remains overdue/.test(noPrior.text), noPrior.text);
  assert.ok(noPrior.text.includes('Your account is overdue by $6,210.40. Your outstanding orders totalling $12,980.50 remain on hold.'));
  assert.strictEqual(noPrior.leftOutPriorReminders, true, 'the page can tell the sender');
  assert.strictEqual(B({ template: 'final', priorReminders: undefined }).leftOutPriorReminders, true);
  assert.strictEqual(B({ template: 'final', priorReminders: 1, holdTotal: 0 }).text,
    `Hi Sam, Brendan from WNDRR. Your account remains overdue by $6,210.40 despite previous reminders. We require payment or a confirmed payment arrangement today to avoid further account action. Please contact me directly on ${PH}. Brendan.`);
});
test('no stock on hold: every template drops held stock completely and nothing mentions it', () => {
  for (const t of ['friendly', 'firm', 'final']) {
    const m = B({ template: t, holdTotal: 0, priorReminders: 1 });
    assert.strictEqual(m.hasHold, false);
    assert.ok(!/stock|hold|orders/i.test(m.text), `${t}: ${m.text}`);
    assert.ok(!/\$12,980/.test(m.text));
  }
  for (const t of ['friendly', 'firm', 'final']) assert.strictEqual(B({ template: t, holdTotal: -5 }).hasHold, false, 'a negative or missing amount is not held stock');
});
test('every template fills in name, overdue amount, held stock and the phone number — nothing is left as a {placeholder}', () => {
  for (const t of ['friendly', 'firm', 'final']) {
    const m = B({ template: t, priorReminders: 1 });
    assert.ok(m.text.startsWith('Hi Sam,'), m.text);
    assert.ok(m.text.includes('$6,210.40') && m.text.includes('$12,980.50') && m.text.includes(PH), m.text);
    assert.ok(!/[{}]|undefined|NaN|null/.test(m.text), m.text);
  }
});
test('no first name: every greeting is "Hi there," — never the store name', () => {
  for (const t of ['friendly', 'firm', 'final']) {
    assert.ok(B({ template: t, greet: '' }).text.startsWith('Hi there,'));
    assert.ok(B({ template: t, greet: undefined }).text.startsWith('Hi there,'));
  }
});
test('nothing overdue means no message at all (stock on hold alone is not chased)', () => {
  for (const t of ['friendly', 'firm', 'final']) {
    assert.strictEqual(B({ template: t, overdue: 0 }), null);
    assert.strictEqual(B({ template: t, overdue: -5 }), null);
    assert.strictEqual(B({ template: t, overdue: undefined }), null);
  }
});
test('amounts use dollars with thousands separators and cents; New Zealand customers are marked NZD', () => {
  assert.ok(B({ overdue: 1234567.5 }).text.includes('$1,234,567.50'));
  assert.ok(B({ overdue: 5 }).text.includes('$5.00'));
  const nz = B({ template: 'firm', currency: 'NZD', country: 'New Zealand' }).text;
  assert.ok(nz.includes('$6,210.40 NZD') && nz.includes('$12,980.50 NZD'), nz);
});
test('texts never say "reply" (WNDRR is a sender name — it cannot receive replies) and never promise a reply by text', () => {
  for (const t of ['friendly', 'firm', 'final']) assert.ok(!/repl/i.test(B({ template: t, priorReminders: 1 }).text), t);
});
test('New Zealand customers get the number with +61, since 04… cannot be dialled from there', () => {
  assert.strictEqual(S.phoneFor('Australia'), '0418 519939');
  assert.strictEqual(S.phoneFor(undefined), '0418 519939');
  assert.strictEqual(S.phoneFor('New Zealand'), '+61 418 519 939');
  for (const t of ['friendly', 'firm', 'final']) {
    const nz = B({ template: t, country: 'New Zealand', currency: 'NZD', priorReminders: 1 }).text;
    assert.ok(nz.includes('+61 418 519 939') && !nz.includes('0418 519939'), nz);
  }
  assert.ok(B({ phone: '0400 000 000' }).text.includes('call me on 0400 000 000'), 'the number can be overridden');
});
test('the three wordings stay in the cheap plain-text size (no emoji or curly quotes) and fit in 3 parts', () => {
  for (const t of ['friendly', 'firm', 'final']) for (const hold of [0, 12980.5]) {
    const seg = S.segments(B({ template: t, holdTotal: hold, priorReminders: 1 }).text);
    assert.strictEqual(seg.unicode, false, `${t}/${hold}`);
    assert.ok(seg.parts <= 3, `${t}/${hold}: ${seg.parts} parts`);
  }
});
test('template list: three choices in order, each with a label and a one-line "when to use it"', () => {
  assert.deepStrictEqual(S.TEMPLATE_ORDER, ['friendly', 'firm', 'final']);
  assert.deepStrictEqual(S.TEMPLATE_ORDER.map((k) => S.TEMPLATES[k].label), ['Friendly Reminder', 'Firm Reminder', 'Final Reminder']);
  for (const k of S.TEMPLATE_ORDER) assert.ok(S.TEMPLATES[k].blurb.length > 10);
});

const T = (o) => S.suggestTemplate(Object.assign({ priorReminders: 0, promiseDate: null, avgLateDays: null, paidCount: 0, overdue: 500, today: '2026-11-09' }, o));
test('suggested template: no evidence means no suggestion (Firm stays the default) — invoice age alone never escalates', () => {
  assert.strictEqual(T({}), null);
  assert.strictEqual(T({ paidCount: 2, avgLateDays: 40 }), null, 'two paid invoices is not a pattern');
  assert.strictEqual(T({ paidCount: 5, avgLateDays: 10 }), null, 'in between: no strong signal either way');
  assert.strictEqual(T({ overdue: 0, priorReminders: 5 }), null, 'nothing overdue, nothing to suggest');
});
test('suggested template: Final after 2+ texts on record, or a payment promise that has passed', () => {
  assert.strictEqual(T({ priorReminders: 2 }).template, 'final');
  assert.ok(/2 texts already sent/.test(T({ priorReminders: 2 }).reason));
  assert.strictEqual(T({ priorReminders: 3 }).template, 'final');
  assert.strictEqual(T({ promiseDate: '2026-11-07' }).template, 'final');
  assert.ok(/2026-11-07/.test(T({ promiseDate: '2026-11-07' }).reason));
  assert.strictEqual(T({ promiseDate: '2026-11-09' }), null, 'promised for today: not broken yet');
  assert.strictEqual(T({ promiseDate: '2026-11-20' }), null, 'a promise still to come is not broken');
});
test('suggested template: Firm after 1 text on record, or a record of paying 2+ weeks late', () => {
  assert.strictEqual(T({ priorReminders: 1 }).template, 'firm');
  assert.strictEqual(T({ paidCount: 6, avgLateDays: 22.4 }).template, 'firm');
  assert.ok(/22 days/.test(T({ paidCount: 6, avgLateDays: 22.4 }).reason));
  assert.strictEqual(T({ paidCount: 3, avgLateDays: 14 }), null, '14 days late exactly is not "2+ weeks late"');
  assert.strictEqual(T({ priorReminders: 1, paidCount: 6, avgLateDays: -3 }).template, 'firm', 'a text already sent beats a good history');
});
test('suggested template: Friendly only for a good payer who has not been texted yet', () => {
  assert.strictEqual(T({ paidCount: 4, avgLateDays: 2 }).template, 'friendly');
  assert.strictEqual(T({ paidCount: 4, avgLateDays: -5 }).template, 'friendly');
  assert.strictEqual(T({ paidCount: 3, avgLateDays: 7 }).template, 'friendly');
  assert.ok(/no text has been sent yet/.test(T({ paidCount: 4, avgLateDays: 2 }).reason));
  assert.strictEqual(T({ paidCount: 2, avgLateDays: 1 }), null, 'needs 3+ paid invoices to count as a history');
  assert.strictEqual(T({ paidCount: 4, avgLateDays: null }), null);
});
test('a suggestion only ever names a real template', () => {
  for (const o of [{ priorReminders: 2 }, { priorReminders: 1 }, { paidCount: 4, avgLateDays: 2 }, { promiseDate: '2026-01-01' }, { paidCount: 9, avgLateDays: 30 }]) assert.ok(S.TEMPLATES[T(o).template]);
});

test('segments: plain text is 160 then 153 per part; fancy characters drop it to 70 then 67', () => {
  assert.deepStrictEqual(S.segments('a'.repeat(160)), { unicode: false, chars: 160, parts: 1, max: 612 });
  assert.strictEqual(S.segments('a'.repeat(161)).parts, 2);
  assert.strictEqual(S.segments('a'.repeat(306)).parts, 2);
  assert.strictEqual(S.segments('a'.repeat(307)).parts, 3);
  assert.deepStrictEqual(S.segments('Hi \u{1F44B}'), { unicode: true, chars: 5, parts: 1, max: 268 }, 'an emoji is two units');
  assert.strictEqual(S.segments('é'.repeat(70)).unicode, false, 'é is in the standard alphabet');
  assert.strictEqual(S.segments('“hi”').unicode, true, 'curly quotes are not');
  assert.strictEqual(S.segments('x'.repeat(71) + '—').parts, 2);
  assert.strictEqual(S.segments('{}').chars, 4, 'braces cost two each');
  assert.strictEqual(S.segments('').parts, 0);
});
test('validateMessage: not empty, not longer than the provider allows', () => {
  assert.strictEqual(S.validateMessage('   ').ok, false);
  assert.strictEqual(S.validateMessage('hello').ok, true);
  assert.strictEqual(S.validateMessage('a'.repeat(612)).ok, true);
  assert.strictEqual(S.validateMessage('a'.repeat(613)).ok, false);
  assert.strictEqual(S.validateMessage('“' + 'a'.repeat(268)).ok, false, 'unicode limit is lower');
  assert.ok(/too long/.test(S.validateMessage('a'.repeat(700)).reason));
});

console.log(`\n${n} passing${process.exitCode ? ' — with failures' : ''}`);
