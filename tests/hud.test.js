/**
 * HUD harness for LifelogOS/index.html — the pure client helpers that carry the
 * hour-block and week-view logic. No DOM: the functions under test are extracted from
 * the shipped file by balanced-brace scan, so the test can never drift from the source.
 *
 * Run: node tests/hud.test.js
 * TZ is forced to IST so isoWithOffset / lastClosedBlock are deterministic off the user's box.
 */
process.env.TZ = 'Asia/Kolkata';

var fs = require('fs');
var path = require('path');
var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// the app script is the <script> block with no src=
var scripts = [];
html.replace(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g, function (_, body) { scripts.push(body); return _; });
var js = scripts.sort(function (a, b) { return b.length - a.length; })[0];

/** Return the source of `function NAME(...){...}`, brace-balanced, skipping strings/comments. */
function extract(src, name) {
  var start = src.search(new RegExp('function\\s+' + name + '\\s*\\('));
  if (start < 0) throw new Error('function not found: ' + name);
  var i = src.indexOf('{', start), depth = 0, mode = null;
  for (; i < src.length; i++) {
    var c = src[i], n = src[i + 1];
    if (mode === 'line') { if (c === '\n') mode = null; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = null; i++; } continue; }
    if (mode === 'str') { if (c === '\\') { i++; continue; } if (c === mode.q) mode = null; continue; }
    if (mode && mode.q) { if (c === '\\') { i++; continue; } if (c === mode.q) mode = null; continue; }
    if (c === '/' && n === '/') { mode = 'line'; i++; continue; }
    if (c === '/' && n === '*') { mode = 'block'; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { mode = { q: c }; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in: ' + name);
}

var names = ['pad', 'isoWithOffset', 'floorHour', 'h12', 'mer', 'lastClosedBlock', 'rangeLabel', 'segmentDays'];
var combined = 'var HOUR = 3600000;\n' + names.map(function (n) { return extract(js, n); }).join('\n') +
  '\nreturn {' + names.join(',') + '};';
var F = (new Function(combined))();

var pass = 0, fail = 0;
function ck(cond, label, got) {
  if (cond) { console.log('  ok   ' + label); pass++; }
  else { console.log('  FAIL ' + label + (got !== undefined ? '   got: ' + JSON.stringify(got) : '')); fail++; }
}
function group(n) { console.log('\n' + n); }
function at(h, m) { return new Date(2026, 7, 23, h, m || 0, 0); } // local (IST) wall-clock

/* ---------------------------------------------------------------- */
group('time primitives');
ck(F.pad(3) === '03' && F.pad(12) === '12', 'pad zero-fills below 10 only');
ck(F.h12(at(16)) === 4 && F.mer(at(16)) === 'PM', '16:00 is 4 PM');
ck(F.h12(at(0)) === 12 && F.mer(at(0)) === 'AM', 'midnight is 12 AM');
ck(F.h12(at(12)) === 12 && F.mer(at(12)) === 'PM', 'noon is 12 PM');
var fl = F.floorHour(at(17, 49));
ck(fl.getMinutes() === 0 && fl.getSeconds() === 0 && fl.getHours() === 17, 'floorHour zeroes min/sec, keeps the hour');
ck(F.isoWithOffset(new Date(2026, 7, 23, 14, 3, 11)) === '2026-08-23T14:03:11+05:30',
   'isoWithOffset embeds the real IST offset', F.isoWithOffset(new Date(2026, 7, 23, 14, 3, 11)));

/* ---------------------------------------------------------------- */
group('lastClosedBlock  — the block a fresh entry defaults to');
ck(F.lastClosedBlock().getTime() === F.floorHour(new Date()).getTime() - 3600000,
   'is exactly one hour before the top of the current hour');

/* ---------------------------------------------------------------- */
group('rangeLabel  — a 5pm ping is about the "4 – 5 PM" block');
ck(F.rangeLabel(at(16)) === '4 – 5 PM', 'shared meridian collapses to one', F.rangeLabel(at(16)));
ck(F.rangeLabel(at(11)) === '11 AM – 12 PM', 'AM->PM shows both', F.rangeLabel(at(11)));
ck(F.rangeLabel(at(23)) === '11 PM – 12 AM', 'PM->AM across midnight shows both', F.rangeLabel(at(23)));
ck(F.rangeLabel(at(12)) === '12 – 1 PM', 'noon block', F.rangeLabel(at(12)));
ck(F.rangeLabel(at(0)) === '12 – 1 AM', 'midnight block', F.rangeLabel(at(0)));

/* ---------------------------------------------------------------- */
group('segmentDays  — logical days split on the day_start tick, not the calendar');
function r(slot, ds, s) { return { slot: slot, dayStart: !!ds, sentence: s, bucket: 'Needed' }; }
var week = [
  r('2026-08-20T22:00:00+05:30', false, 'leading-untick'),
  r('2026-08-21T07:00:00+05:30', true,  'thu-start'),
  r('2026-08-21T14:00:00+05:30', false, 'thu-mid'),
  r('2026-08-22T06:00:00+05:30', true,  'fri-start'),
  r('2026-08-24T08:00:00+05:30', true,  'sun-start'),
  r('2026-08-24T12:00:00+05:30', false, 'sun-noon')
];
var d = F.segmentDays(week);
ck(d.length === 4, 'four groups: a leading un-ticked run, then one per tick', d.length);
ck(d[0].entries.length === 1 && d[0].entries[0].sentence === 'leading-untick',
   'entries before any tick form their own leading group — nothing hidden');
ck(d[1].entries.map(function (x) { return x.sentence; }).join('+') === 'thu-start+thu-mid',
   'a tick opens a day that runs until the next tick');
ck(d[3].entries.length === 2 && d[3].start === '2026-08-24T08:00:00+05:30',
   'the last day starts at its own tick, spanning the 3-day gap since Friday');
ck(F.segmentDays([]).length === 0, 'empty log yields no days');

console.log('\nHUD: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
