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
test('with no first name the greeting is "Hi there," — never the store name', () => {
  assert.ok(S.buildMessage({ greet: '', overdue: 100 }).text.startsWith("Hi there, it's Brendan"));
  assert.ok(S.buildMessage({ greet: '   '.trim(), overdue: 100, holdTotal: 50 }).text.startsWith('Hi there,'));
});
test('message: overdue only', () => {
  const m = S.buildMessage({ greet: 'Sam', overdue: 6210.4, holdTotal: 0, currency: 'AUD' });
  assert.strictEqual(m.kind, 'overdue');
  assert.strictEqual(m.text, "Hi Sam, it's Brendan from WNDRR. Your account has $6,210.40 overdue. Please call 0418 519939 or email brendan@kohindustries.com to let me know when you'll pay.");
});
test('message: stock on hold AND overdue is the urgent one and names both amounts', () => {
  const m = S.buildMessage({ greet: 'Sam', overdue: 6210.4, holdTotal: 12980, currency: 'AUD' });
  assert.strictEqual(m.kind, 'hold');
  assert.strictEqual(m.text, "Hi Sam, it's Brendan from WNDRR. Your account has $6,210.40 overdue, so your $12,980.00 of held stock can't be released. Pay today and we'll release it straight away. Please call 0418 519939 or email brendan@kohindustries.com to let me know when you'll pay.");
});
test('message: nothing overdue means no message (stock on hold alone is not chased), and NZD is spelled out', () => {
  assert.strictEqual(S.buildMessage({ greet: 'Sam', overdue: 0, holdTotal: 500, currency: 'AUD' }), null);
  assert.strictEqual(S.buildMessage({ greet: 'Sam', overdue: -5, holdTotal: 0 }), null);
  assert.ok(S.buildMessage({ greet: 'Jo', overdue: 100, holdTotal: 50, currency: 'NZD' }).text.includes('$100.00 NZD overdue, so your $50.00 NZD of held stock'));
  assert.ok(S.buildMessage({ overdue: 100 }).text.startsWith('Hi there,'));
});
test('the wording stays plain (no emoji, curly quotes or dashes) so it keeps the cheap text size, in 1-2 parts', () => {
  for (const hold of [0, 12980]) {
    const m = S.buildMessage({ greet: 'Sam', overdue: 6210.4, holdTotal: hold, currency: 'AUD' });
    const seg = S.segments(m.text);
    assert.strictEqual(seg.unicode, false);
    assert.ok(seg.parts <= 2, `${m.kind}: ${seg.parts} parts`);

  }
});

test('the texts never say "reply" — they come from a sender name (WNDRR), which customers cannot reply to', () => {
  for (const hold of [0, 12980]) {
    const t = S.buildMessage({ greet: 'Sam', overdue: 100, holdTotal: hold, currency: 'AUD' }).text;
    assert.ok(!/repl/i.test(t), t);
    assert.ok(t.includes('Please call 0418 519939 or email brendan@kohindustries.com'), t);
    assert.ok(t.includes('from WNDRR'), t);
  }
  assert.ok(S.buildMessage({ greet: 'Sam', overdue: 100, contact: 'ar@example.test' }).text.includes('email ar@example.test'), 'the contact address can be changed');
  assert.ok(S.buildMessage({ greet: 'Sam', overdue: 100, phone: '0400 000 000' }).text.includes('call 0400 000 000'), 'and so can the number');
  assert.strictEqual(S.CONTACT_EMAIL, 'brendan@kohindustries.com');
  assert.strictEqual(S.CONTACT_PHONE, '0418 519939');
});
test('New Zealand customers get the number with +61, since 04… cannot be dialled from there', () => {
  assert.strictEqual(S.phoneFor('Australia'), '0418 519939');
  assert.strictEqual(S.phoneFor(undefined), '0418 519939');
  assert.strictEqual(S.phoneFor('New Zealand'), '+61 418 519 939');
  const nz = S.buildMessage({ greet: 'Aroha', overdue: 100, currency: 'NZD', country: 'New Zealand' }).text;
  assert.ok(nz.includes('call +61 418 519 939 or email'), nz);
  assert.ok(!nz.includes('0418 519939'), nz);
  assert.ok(S.buildMessage({ greet: 'Sam', overdue: 100, currency: 'AUD', country: 'Australia' }).text.includes('call 0418 519939'));
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
