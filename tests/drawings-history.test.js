// Run with:  node tests/drawings-history.test.js
const assert = require('assert');
const D = require('../drawings-history.js');
let n = 0;
const test = (name, fn) => { try { fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };
const M = (a, b) => ({ '501': a, '502': b });

test('windows split at each 1 January, first and last follow the given dates', () => {
  assert.deepStrictEqual(D.splitYears('2015-12-01', '2017-03-20'), [{ from: '2015-12-01', to: '2015-12-31' }, { from: '2016-01-01', to: '2016-12-31' }, { from: '2017-01-01', to: '2017-03-20' }]);
  assert.deepStrictEqual(D.splitYears('2026-08-01', '2026-10-03'), [{ from: '2026-08-01', to: '2026-10-03' }]);
});
test('no cache: read everything from the first month of the earliest transaction', () => {
  const p = D.planRead(null, '2026-10-03', '2015-12-23');
  assert.strictEqual(p.full, true); assert.strictEqual(p.from, '2015-12-01'); assert.deepStrictEqual(p.keep, {}); assert.strictEqual(p.safe, '2026-08');
});
test('with a cache: re-read only from the month after readThrough, keeping older final months', () => {
  const cache = { readThrough: '2026-08', months: { '2026-06': M(1, 0), '2026-08': M(2, 0), '2026-09': M(999, 0) } };
  const p = D.planRead(cache, '2026-10-03', null);
  assert.strictEqual(p.full, false); assert.strictEqual(p.from, '2026-09-01');
  assert.deepStrictEqual(Object.keys(p.keep).sort(), ['2026-06', '2026-08'], 'September is re-read, not kept');
  const later = D.planRead(cache, '2026-12-15', null);
  assert.strictEqual(later.from, '2026-09-01', 'a gap of months is re-read in full');
});
test('a malformed cache is ignored (full read)', () => {
  assert.strictEqual(D.planRead({ readThrough: '2026-08' }, '2026-10-03', '2020-01-05').full, true);
  assert.strictEqual(D.planRead({ months: {} }, '2026-10-03', '2020-01-05').from, '2020-01-01');
});
test('progress is only saved over the contiguous prefix of finished windows', () => {
  const w = D.splitYears('2015-12-01', '2018-05-01');
  assert.strictEqual(D.contiguousEnd(w, [false, true, true, true]), null);
  assert.strictEqual(D.contiguousEnd(w, [true, true, false, true]), '2016-12-31');
  assert.strictEqual(D.contiguousEnd(w, [true, true, true, true]), '2018-05-01');
});
test('readThrough never passes the "safe" month (the last two months are always re-read)', () => {
  assert.strictEqual(D.newReadThrough('2026-10-03', '2026-08', null), '2026-08');
  assert.strictEqual(D.newReadThrough('2018-05-01', '2026-08', null), '2018-04', 'a window ending mid-month: that month is not yet complete');
  assert.strictEqual(D.newReadThrough('2017-12-31', '2026-08', null), '2017-12');
  assert.strictEqual(D.newReadThrough(null, '2026-08', '2020-03'), '2020-03');
  assert.strictEqual(D.newReadThrough('2016-12-31', '2026-08', '2020-03'), '2020-03', 'never goes backwards');
});
test('since-inception = running sum of (501 - 502) month by month, to the cent', () => {
  const months = { '2016-01': M(1000.1, 200.05), '2016-02': M(0, 500), '2016-03': M(300, 0), '2026-09': M(50, 25.5) };
  assert.strictEqual(D.cumBefore(months, '2016-01'), 0);
  assert.strictEqual(D.cumThrough(months, '2016-01'), 800.05);
  assert.strictEqual(D.cumThrough(months, '2016-02'), 300.05);
  assert.strictEqual(D.cumThrough(months, '2016-03'), 600.05);
  assert.strictEqual(D.cumBefore(months, '2026-09'), 600.05); assert.strictEqual(D.cumThrough(months, '2026-09'), 624.55);
  assert.strictEqual(D.cumThrough(months, '2020-01'), 600.05, 'a month with no data carries the total forward');
});
test('the since-inception total equals the all-time sum of the two accounts', () => {
  const months = {}; let a = 0, b = 0;
  for (let i = 0; i < 130; i++) { const k = D.addMonths('2015-12', i); const x = (i * 37.13) % 900, y = (i * 91.7) % 700; months[k] = M(Math.round(x * 100) / 100, Math.round(y * 100) / 100); a += months[k]['501']; b += months[k]['502']; }
  const last = D.addMonths('2015-12', 129);
  assert.ok(Math.abs(D.cumThrough(months, last) - (a - b)) < 0.01);
});
test('inception = first month with any activity; merge keeps final months and overwrites re-read ones', () => {
  assert.strictEqual(D.firstActiveMonth({ '2016-01': M(0, 0), '2016-02': M(0, 12), '2016-03': M(5, 0) }), '2016-02'); assert.strictEqual(D.firstActiveMonth({ '2016-01': M(0, 0) }), null);
  const out = D.merge({ '2026-06': M(1, 2), '2026-08': M(3, 4) }, { '2026-08': M(30, 40), '2026-09': M(5, 6) });
  assert.deepStrictEqual(out, { '2026-06': M(1, 2), '2026-08': M(30, 40), '2026-09': M(5, 6) });
});
console.log(`\n${n} passing${process.exitCode ? ' — with failures' : ''}`);
