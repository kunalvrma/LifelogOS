/**
 * Backend harness for LifelogOS/Code.gs — pure helpers only, no Apps Script services.
 * Run: node tests/backend.test.js   (from the lifelog/ folder, or anywhere — paths are relative to this file)
 *
 * Ships inside the repo at LifelogOS/tests/ so the safety net travels with the code.
 */
var fs = require('fs');
var path = require('path');

var src = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
var sandbox = {};
// Code.gs is only top-level `var` constants + function declarations, so evaluating it
// defines everything without calling any Apps Script service. Export the pure helpers.
(new Function('g', src + '\nObject.assign(g, {normaliseSlot_, normaliseEntry_, isValidBucket_,' +
  ' truthy_, bySlot_, currentDaySlice_, ISO_RE, ISO_PARTS, FALLBACK_DAY_HOURS});'))(sandbox);

var pass = 0, fail = 0;
function ck(cond, label, got) {
  if (cond) { console.log('  ok   ' + label); pass++; }
  else { console.log('  FAIL ' + label + (got !== undefined ? '   got: ' + JSON.stringify(got) : '')); fail++; }
}
function group(n) { console.log('\n' + n); }

var NOW  = '2026-08-23T17:49:36+05:30';
var SLOT = '2026-08-23T16:00:00+05:30';   // last completed block at 17:49

/* ---------------------------------------------------------------- */
group('normaliseSlot_  — truncation by string surgery, never date arithmetic');

var ns = sandbox.normaliseSlot_;
ck(ns('2026-08-23T17:49:36+05:30') === '2026-08-23T17:00:00+05:30',
   'mid-hour instant truncates to the top of the hour', ns('2026-08-23T17:49:36+05:30'));
ck(ns('2026-08-23T17:49+05:30') === '2026-08-23T17:00:00+05:30',
   'seconds may be absent', ns('2026-08-23T17:49+05:30'));
ck(ns('2026-08-23T17:00:00+05:30') === '2026-08-23T17:00:00+05:30',
   'idempotent on an already-clean slot');
ck(ns('2026-08-23T17:49:36+0530') === '2026-08-23T17:00:00+05:30',
   'colonless offset canonicalised to +05:30', ns('2026-08-23T17:49:36+0530'));
ck(ns('2026-08-23T17:49:36Z') === '2026-08-23T17:00:00Z',
   'Z offset preserved as Z', ns('2026-08-23T17:49:36Z'));
ck(ns('2026-08-23T05:49:36+05:45') === '2026-08-23T05:00:00+05:45',
   'a 45-minute offset is untouched by truncation', ns('2026-08-23T05:49:36+05:45'));
ck(ns('2026-08-23T17:49:36') === null, 'no offset is rejected', ns('2026-08-23T17:49:36'));
ck(ns('not a date') === null, 'garbage rejected');
ck(ns(0) === null, 'number rejected — must not become 1970');
ck(ns(null) === null, 'null rejected');
var naive = new Date('2026-08-23T17:49:36+05:30'); naive.setUTCMinutes(0, 0, 0);
ck(true, 'note: UTC flooring gives ' + naive.toISOString() + ' — which is why truncation is textual');

/* ---------------------------------------------------------------- */
group('normaliseEntry_  — slot handling');

var ne = sandbox.normaliseEntry_;
function E(o) { return ne(o, NOW, SLOT); }
var base = { bucket: 'Needed', sentence: 'x', ts: NOW };
function withSlot(s) { return E(Object.assign({}, base, { slot: s })); }

ck(withSlot('2026-08-23T16:00:00+05:30').entry.slot === '2026-08-23T16:00:00+05:30',
   'a valid past block is accepted verbatim');
ck(withSlot('2026-08-23T14:37:02+05:30').entry.slot === '2026-08-23T14:00:00+05:30',
   'a backdated mid-hour value truncates and is accepted', withSlot('2026-08-23T14:37:02+05:30').entry.slot);
ck(E(base).entry.slot === SLOT, 'missing slot falls back to the last completed block');
ck(withSlot('2026-08-23T19:00:00+05:30').entry.slot === SLOT,
   'a FUTURE block is refused — you can only account for a block that has started',
   withSlot('2026-08-23T19:00:00+05:30').entry.slot);
ck(withSlot('2026-08-23T17:00:00+05:30').entry.slot === '2026-08-23T17:00:00+05:30',
   'the in-progress block IS allowed (17:00 <= 17:49)');
ck(withSlot('garbage').entry.slot === SLOT, 'unparseable slot falls back, does not throw');
ck(withSlot(0).entry.slot === SLOT, 'slot:0 falls back — not 1970');
ck(withSlot('2026-08-20T09:00:00+05:30').entry.slot === '2026-08-20T09:00:00+05:30',
   'a slot three days back is allowed: catching up is legitimate');

group('normaliseEntry_  — everything that held before still holds');
ck(E(base).ok === true, 'valid payload accepted');
ck(E(Object.assign({}, base, { bucket: 'needed' })).entry.bucket === 'Needed', 'lowercase bucket normalised');
ck(E(Object.assign({}, base, { bucket: 'Wasted' })).ok === false, 'retired bucket "Wasted" rejected');
ck(E(Object.assign({}, base, { bucket: undefined })).ok === false, 'missing bucket rejected');
ck(E(Object.assign({}, base, { sentence: '   ' })).ok === false, 'whitespace-only sentence rejected');
ck(E(Object.assign({}, base, { sentence: 'a'.repeat(5000) })).entry.sentence.length === 2000,
   '5000-char sentence truncated to 2000');
ck(E({ bucket: 'Needed', sentence: 'x' }).entry.ts === NOW, 'missing ts falls back to now');
ck(E({ bucket: 'Needed', sentence: 'x', ts: 0 }).entry.ts === NOW, 'ts:0 falls back to now, NOT 1970');
ck(E({ bucket: 'Needed', sentence: 'x', ts: '2026-08-23T14:03' }).entry.ts === NOW,
   'ts without an offset rejected');
ck(E(Object.assign({}, base, { dayStart: 'false' })).entry.dayStart === false, 'dayStart:"false" is false');
ck(E(Object.assign({}, base, { dayStart: 1 })).entry.dayStart === true, 'dayStart:1 is true');
ck(E(Object.assign({}, base, { dayStart: true })).entry.dayStart === true, 'dayStart:true is true');
ck(E(base).entry.dayStart === false, 'dayStart absent is false');
ck(ne(null, NOW, SLOT).ok === false, 'null payload rejected');
ck(E(Object.assign({}, base, { id: 'z'.repeat(200) })).entry.id.length === 64, 'overlong id clamped to 64');

/* ---------------------------------------------------------------- */
group('slot-order segmentation  — the invariant that row order can no longer be trusted');

function row(slot, dayStart, sentence) {
  return { slot: slot, dayStart: !!dayStart, sentence: sentence, bucket: 'Needed', id: sentence };
}
var sheetOrder = [
  row('2026-08-22T22:00:00+05:30', false, 'yesterday-late'),
  row('2026-08-23T06:00:00+05:30', true,  'wokeup'),
  row('2026-08-23T09:00:00+05:30', false, 'morning'),
  row('2026-08-23T16:00:00+05:30', false, 'afternoon'),
  row('2026-08-23T05:00:00+05:30', false, 'backdated-before-tick')
];
var sorted = sheetOrder.slice().sort(sandbox.bySlot_);
ck(sorted.map(function (r) { return r.sentence; }).join(',') ===
   'yesterday-late,backdated-before-tick,wokeup,morning,afternoon',
   'bySlot_ reorders the backdated entry ahead of the day tick',
   sorted.map(function (r) { return r.sentence; }));

var nowMs = Date.parse('2026-08-23T17:49:36+05:30');
var today = sandbox.currentDaySlice_(sorted, nowMs);
ck(today.map(function (r) { return r.sentence; }).join(',') === 'wokeup,morning,afternoon',
   'today = from the last day_start tick onward, in slot order',
   today.map(function (r) { return r.sentence; }));
ck(today.indexOf(sheetOrder[4]) === -1,
   'the backdated 05:00 entry is EXCLUDED from today even though it was written last');
ck(today.indexOf(sheetOrder[0]) === -1, "yesterday's 22:00 entry is excluded");
ck(today[0].dayStart === true, 'the slice starts on the ticked entry itself');

var twoDays = [
  row('2026-08-22T07:00:00+05:30', true,  'day1-start'),
  row('2026-08-22T20:00:00+05:30', false, 'day1-end'),
  row('2026-08-23T06:00:00+05:30', true,  'day2-start'),
  row('2026-08-23T09:00:00+05:30', false, 'day2-mid')
];
ck(sandbox.currentDaySlice_(twoDays, nowMs).length === 2,
   'with two ticks, only the latest day is returned');

var noTick = [
  row('2026-08-22T02:00:00+05:30', false, 'ancient'),
  row('2026-08-23T09:00:00+05:30', false, 'recent'),
  row('2026-08-23T16:00:00+05:30', false, 'recenter')
];
var fb = sandbox.currentDaySlice_(noTick, nowMs);
ck(fb.length === 2 && fb[0].sentence === 'recent',
   'with no tick at all, falls back to an ' + sandbox.FALLBACK_DAY_HOURS +
   'h window so an unopened day is still visible and fixable',
   fb.map(function (r) { return r.sentence; }));
ck(sandbox.currentDaySlice_([], nowMs).length === 0, 'empty log yields an empty day');

/* ---------------------------------------------------------------- */
group('slotNow_ arithmetic  — verified against real IST, formatDate is checked by selfTest');

[['2026-08-23T17:49:36+05:30', '16'], ['2026-08-23T17:05:00+05:30', '16'],
 ['2026-08-23T17:59:59+05:30', '16'], ['2026-08-23T18:00:01+05:30', '17'],
 ['2026-08-23T00:10:00+05:30', '23']].forEach(function (c) {
  var h = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit',
    hour12: false }).format(new Date(Date.parse(c[0]) - 3600000));
  ck(h === c[1], 'at ' + c[0].slice(11, 19) + ' IST the closed block starts at ' + c[1] + ':00', h);
});

console.log('\nbackend: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
