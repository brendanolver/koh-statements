/* Drawings "since inception" — pure helpers, no DOM, no network.
 *
 * Xero can't filter bank transactions by account code, so the all-time figure means reading every
 * bank transaction once (~33 pages for this org). These helpers plan that read so it only ever
 * happens once per browser: the monthly totals are cached, and later loads re-read just the last
 * couple of months (recent transactions get edited / back-dated; older months are treated as final).
 *
 * Loaded by index.html as a plain script (window.DWH) and by tests/drawings-history.test.js.
 */
(function (root) {
  'use strict';
  const pad = (n) => String(n).padStart(2, '0');
  const monthKey = (iso) => iso.slice(0, 7);
  const addMonths = (mk, n) => { const [y, m] = mk.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
  const lastDay = (mk) => { const [y, m] = mk.split('-').map(Number); return `${mk}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
  const r2 = (n) => Math.round(n * 100) / 100;
  const diffOf = (m) => r2((m ? m['501'] : 0) - (m ? m['502'] : 0));

  // One window per calendar year: [from .. to] split at 1 Jan so no window is huge.
  function splitYears(from, to) {
    const out = [];
    let y = Number(from.slice(0, 4));
    const endY = Number(to.slice(0, 4));
    for (; y <= endY; y++) {
      const a = y === Number(from.slice(0, 4)) ? from : `${y}-01-01`;
      const b = y === endY ? to : `${y}-12-31`;
      if (a <= b) out.push({ from: a, to: b });
    }
    return out;
  }

  // What to read. A cache with `readThrough` (the last month treated as final) means "read from the
  // month after that"; no cache means "everything from the earliest Xero transaction".
  function planRead(cache, today, earliestIso) {
    const cur = monthKey(today);
    const safe = addMonths(cur, -2); // after a successful read, months up to here are final
    const valid = cache && cache.readThrough && cache.months && typeof cache.months === 'object';
    if (!valid) {
      if (!earliestIso) return { full: true, from: `${cur}-01`, keep: {}, safe };
      return { full: true, from: `${monthKey(earliestIso)}-01`, keep: {}, safe };
    }
    const keep = {};
    for (const [k, v] of Object.entries(cache.months)) if (k <= cache.readThrough) keep[k] = v;
    return { full: false, from: `${addMonths(cache.readThrough, 1)}-01`, keep, safe };
  }

  // Windows finish out of order when read concurrently, but progress may only be saved over the
  // contiguous run from the start — otherwise a failure could leave a hole that is never re-read.
  function contiguousEnd(windows, done) {
    let end = null;
    for (let i = 0; i < windows.length && done[i]; i++) end = windows[i].to;
    return end;
  }

  // The last month that can be saved as final after reading windows through `readEnd`.
  function newReadThrough(readEnd, safe, prevReadThrough) {
    if (!readEnd) return prevReadThrough || null;
    const doneMonth = readEnd === lastDay(monthKey(readEnd)) ? monthKey(readEnd) : addMonths(monthKey(readEnd), -1);
    const v = doneMonth < safe ? doneMonth : safe;
    return prevReadThrough && prevReadThrough > v ? prevReadThrough : v;
  }

  // Sum of (501 - 502) over every month strictly before `key`.
  function cumBefore(months, key) {
    let t = 0;
    for (const k of Object.keys(months)) if (k < key) t += diffOf(months[k]);
    return r2(t);
  }
  const cumThrough = (months, key) => r2(cumBefore(months, key) + diffOf(months[key]));

  function firstActiveMonth(months) {
    const ks = Object.keys(months).filter((k) => months[k]['501'] !== 0 || months[k]['502'] !== 0).sort();
    return ks[0] || null;
  }

  // Merge freshly-read months over the kept (final) ones. Months with no activity are dropped,
  // keeping the cache small (every month in a window is initialised to zero by the reader).
  function merge(keep, fresh) {
    const out = { ...keep };
    for (const [k, v] of Object.entries(fresh)) out[k] = { '501': r2(v['501']), '502': r2(v['502']) };
    return out;
  }

  root.DWH = { splitYears, planRead, contiguousEnd, newReadThrough, cumBefore, cumThrough, firstActiveMonth, merge, diffOf, addMonths, lastDay, monthKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.DWH;
})(typeof window !== 'undefined' ? window : globalThis);
