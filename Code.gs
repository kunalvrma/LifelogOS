/**
 * Lifelog — Apps Script backend
 *
 * Four columns, nothing derived, timestamp stored as TEXT. See SPEC.md for why.
 *
 * Setup (full runbook in README.md):
 *   1. Project Settings -> Script Properties -> LIFELOG_TOKEN = <your token>
 *   2. Run bootstrap()  — creates the sheet, headers, and forces column A to text
 *   3. Run selfTest()   — proves the timestamp survives a round trip
 *   4. Deploy -> Web App -> execute as me -> access: Anyone
 *      Every redeploy MUST select "New version" or /exec keeps serving old code.
 *
 * This file contains no secrets and is safe to commit.
 */

var SHEET_NAME = 'Log';
var HEADERS = ['timestamp', 'bucket', 'sentence', 'day_start'];
var BUCKETS = ['Needed', 'Wanted', 'Drifted'];
var MAX_SENTENCE = 2000;
var DEDUP_TTL_SECONDS = 21600; // 6h: covers any realistic retry, stays inside cache limits
var MAX_ENTRIES_PER_DAY = 30;  // upper bound used to size the read window

// An ISO 8601 instant that carries its own offset. Offset is mandatory: a timestamp
// without one is exactly the ambiguity that split v1's columns by 12h30m.
var ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:?\d{2}|Z)$/;

/* ------------------------------------------------------------------ *
 * Pure helpers — no Apps Script services, unit-tested outside the IDE
 * ------------------------------------------------------------------ */

/** Canonicalise a bucket, or null if it isn't one of the three. */
function isValidBucket_(v) {
  if (typeof v !== 'string') return null;
  var want = v.trim().toLowerCase();
  for (var i = 0; i < BUCKETS.length; i++) {
    if (BUCKETS[i].toLowerCase() === want) return BUCKETS[i];
  }
  return null;
}

/** Boolean coercion that knows "false" is false. Boolean("false") is true in JS. */
function truthy_(v) {
  if (v === true) return true;
  if (typeof v === 'number') return v > 0;
  if (typeof v === 'string') {
    var s = v.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  return false;
}

/**
 * Validate and shape an incoming payload.
 *
 * nowIso is passed in rather than computed so this stays pure and testable.
 *
 * Note what this deliberately does NOT do: it never constructs a Date from client
 * input. A client ts is either a well-formed ISO string with an offset, in which case
 * it is stored verbatim, or it is ignored in favour of the server's now. Parsing
 * untrusted input into a Date is how `ts: 0` became a 1970-01-01 row in an earlier
 * draft — 0 survives a null check, fails a `> 0` check, and new Date(0) is a
 * perfectly valid Date.
 */
function normaliseEntry_(raw, nowIso) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'no payload' };

  var bucket = isValidBucket_(raw.bucket);
  if (!bucket) return { ok: false, error: 'bad bucket' };

  var sentence = (raw.sentence == null ? '' : String(raw.sentence)).trim();
  if (!sentence) return { ok: false, error: 'empty sentence' };
  if (sentence.length > MAX_SENTENCE) sentence = sentence.slice(0, MAX_SENTENCE);

  var ts = nowIso;
  if (typeof raw.ts === 'string' && ISO_RE.test(raw.ts.trim())) ts = raw.ts.trim();

  return {
    ok: true,
    entry: {
      id: raw.id == null ? '' : String(raw.id).slice(0, 64),
      ts: ts,
      bucket: bucket,
      sentence: sentence,
      dayStart: truthy_(raw.dayStart)
    }
  };
}

/* ------------------------------------------------------------------ *
 * Endpoints
 * ------------------------------------------------------------------ */

function doPost(e) {
  try {
    var raw;
    try {
      raw = JSON.parse(e && e.postData ? e.postData.contents : '');
    } catch (parseErr) {
      return json_({ ok: false, error: 'bad json' });
    }

    if (!checkToken_(raw && raw.token)) return json_({ ok: false, error: 'bad token' });

    var result = normaliseEntry_(raw, nowIso_());
    if (!result.ok) return json_({ ok: false, error: result.error });

    return json_(commit_(result.entry));
  } catch (err) {
    // Never let this throw. An uncaught error returns an HTML error page, and the HUD
    // would read that as an unparseable success.
    return json_({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (!checkToken_(p.token)) return json_({ ok: false, error: 'bad token' });

    var action = p.action || 'health';

    if (action === 'health') {
      return json_({
        ok: true,
        rows: Math.max(0, logSheet_().getLastRow() - 1),
        tz: Session.getScriptTimeZone(),
        now: nowIso_()
      });
    }

    if (action === 'week') {
      var days = Math.min(31, Math.max(1, Number(p.days) || 7));
      return json_({ ok: true, entries: readRecent_(days) });
    }

    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/* ------------------------------------------------------------------ *
 * Write path
 * ------------------------------------------------------------------ */

/**
 * Append one entry, at most once per client id.
 *
 * The cache lookup sits inside the lock on purpose: two retries arriving together
 * would both miss a check performed outside it, and both would append.
 */
function commit_(entry) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy' };
  try {
    var cache = CacheService.getScriptCache();
    var key = entry.id ? 'id:' + entry.id : '';

    if (key) {
      var seen = cache.get(key);
      if (seen) return { ok: true, row: Number(seen), dedup: true };
    }

    var row = appendEntry_(entry);
    if (key) cache.put(key, String(row), DEDUP_TTL_SECONDS);
    return { ok: true, row: row };
  } finally {
    lock.releaseLock();
  }
}

/** The only place that writes to the sheet. Four values, in column order. */
function appendEntry_(entry) {
  var sheet = logSheet_();
  sheet.appendRow([entry.ts, entry.bucket, entry.sentence, entry.dayStart ? true : '']);
  return sheet.getLastRow();
}

/* ------------------------------------------------------------------ *
 * Read path
 * ------------------------------------------------------------------ */

/** Recent entries, newest last. Logical days are segmented by the reader, not here. */
function readRecent_(days) {
  var sheet = logSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return [];

  var start = Math.max(2, last - (days * MAX_ENTRIES_PER_DAY) + 1);
  var values = sheet.getRange(start, 1, last - start + 1, 4).getValues();
  var cutoffMs = Date.now() - days * 86400000;
  var out = [];

  for (var i = 0; i < values.length; i++) {
    var ts = String(values[i][0]);
    var parsed = Date.parse(ts);
    if (!isNaN(parsed) && parsed < cutoffMs) continue;
    out.push({
      ts: ts,
      bucket: String(values[i][1]),
      sentence: String(values[i][2]),
      dayStart: values[i][3] === true
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

function nowIso_() {
  return toIsoWithOffset_(new Date(), Session.getScriptTimeZone());
}

/** Java SimpleDateFormat: XXX renders the offset as +05:30. selfTest() verifies it. */
function toIsoWithOffset_(date, tz) {
  return Utilities.formatDate(date, tz, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function logSheet_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('no "' + SHEET_NAME + '" sheet — run bootstrap()');
  return sheet;
}

function checkToken_(supplied) {
  var expected = PropertiesService.getScriptProperties().getProperty('LIFELOG_TOKEN');
  if (!expected) throw new Error('LIFELOG_TOKEN is not set in Script Properties');
  return typeof supplied === 'string' && supplied === expected;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ *
 * Run once from the editor
 * ------------------------------------------------------------------ */

function bootstrap() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

  // Text format on column A is load-bearing: without it Sheets parses the ISO string
  // into a datetime and throws the offset away, which is v1's +12:30 bug exactly.
  sheet.getRange('A:A').setNumberFormat('@');

  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 90);
  sheet.setColumnWidth(3, 620);
  sheet.setColumnWidth(4, 90);

  var msg = 'bootstrap ok — sheet "' + SHEET_NAME + '" ready, tz ' + Session.getScriptTimeZone();
  Logger.log(msg);
  return msg;
}

/**
 * Writes a probe row through the real append path, checks it round-tripped intact,
 * then deletes it. Run after bootstrap() and after any redeploy.
 *
 * This exists because the failure it catches is invisible: v1's timezone split only
 * became apparent after diffing 100 rows by hand, months later.
 */
function selfTest() {
  var tz = Session.getScriptTimeZone();
  var probeIso = nowIso_();
  var problems = [];

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(probeIso)) {
    problems.push('toIsoWithOffset_ produced "' + probeIso +
                  '" — the XXX pattern is not rendering an offset');
  }

  var sheet = logSheet_();
  var row = appendEntry_({
    ts: probeIso, bucket: 'Needed', sentence: 'SELFTEST — delete me', dayStart: true
  });

  var readBack = sheet.getRange(row, 1).getValue();
  if (typeof readBack !== 'string') {
    problems.push('column A came back as ' + (typeof readBack) +
                  ', not string — Sheets is coercing the timestamp; re-run bootstrap()');
  } else if (readBack !== probeIso) {
    problems.push('column A round-tripped "' + probeIso + '" as "' + readBack + '"');
  }
  if (sheet.getRange(row, 4).getValue() !== true) {
    problems.push('day_start did not store as boolean TRUE');
  }

  sheet.deleteRow(row);

  var msg = problems.length
    ? 'FAIL:\n- ' + problems.join('\n- ')
    : 'PASS — tz ' + tz + ', timestamp ' + probeIso + ', probe row removed';
  Logger.log(msg);
  return msg;
}
