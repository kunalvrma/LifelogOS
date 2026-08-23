/**
 * Lifelog — Apps Script backend
 *
 * Six columns. A–D is what you read; E–F is machinery. Nothing derived is stored.
 * Both timestamp columns are TEXT with the offset inside the string. See SPEC.md for why.
 *
 *   A hour_slot   the block this entry accounts for, at the top of the hour.
 *                 A ping at 17:00 asks about 16:00–17:00, so its slot is 16:00.
 *   B bucket      Needed | Wanted | Drifted
 *   C sentence    one sentence
 *   D day_start   TRUE on the first entry of a logical day, blank otherwise
 *   E logged_at   when it was actually composed. Never changes, even on edit.
 *   F id          client-generated identity. The dedupe and edit key.
 *
 * Setup (full runbook in README.md):
 *   1. Project Settings -> Script Properties -> LIFELOG_TOKEN = <your token>
 *   2. Run bootstrap()  — creates the sheet, headers, and forces A/E/F to text
 *   3. Run selfTest()   — round-trips a probe row through append, update and delete
 *   4. Deploy -> Web App -> execute as me -> access: Anyone
 *      Every redeploy MUST select "New version" or /exec keeps serving old code.
 *
 * This file contains no secrets and is safe to commit.
 */

var SHEET_NAME = 'Log';
var HEADERS = ['hour_slot', 'bucket', 'sentence', 'day_start', 'logged_at', 'id'];
var COL = { SLOT: 1, BUCKET: 2, SENTENCE: 3, DAY_START: 4, LOGGED_AT: 5, ID: 6 };

var BUCKETS = ['Needed', 'Wanted', 'Drifted'];
var MAX_SENTENCE = 2000;
var DEDUP_TTL_SECONDS = 21600; // 6h cache in front of the sheet; the sheet is the authority
var MAX_ENTRIES_PER_DAY = 30;  // upper bound used to size read windows
var FALLBACK_DAY_HOURS = 18;   // how far "today" reaches back when no day_start tick exists

// An ISO 8601 instant carrying its own offset. The offset is mandatory: a timestamp
// without one is exactly the ambiguity that split v1's columns by 12h30m.
var ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:?\d{2}|Z)$/;

// Same shape, but capturing the date-and-hour and the offset so a slot can be truncated
// to the top of the hour by string surgery instead of by parsing into a Date.
var ISO_PARTS = /^(\d{4}-\d{2}-\d{2}T\d{2}):\d{2}(?::\d{2})?([+-]\d{2}:?\d{2}|Z)$/;

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
 * Truncate a validated ISO string to the top of its hour, textually.
 *
 * Deliberately string surgery, not date arithmetic. Flooring with setMinutes(0,0,0)
 * would be wrong here anyway: this system runs at +05:30, where a local hour boundary
 * is not a UTC hour boundary, so flooring in UTC lands on :30. As a bonus this also
 * canonicalises a colonless offset (+0530 -> +05:30).
 *
 * Returns null if the input isn't a well-formed ISO instant with an offset.
 */
function normaliseSlot_(v) {
  if (typeof v !== 'string') return null;
  var m = ISO_PARTS.exec(v.trim());
  if (!m) return null;
  var off = m[2];
  if (off !== 'Z' && off.indexOf(':') === -1) off = off.slice(0, 3) + ':' + off.slice(3);
  return m[1] + ':00:00' + off;
}

/**
 * Validate and shape an incoming entry.
 *
 * nowIso and nowSlot are passed in rather than computed so this stays pure and testable.
 *
 * Note what this deliberately does NOT do: it never constructs a Date from unvalidated
 * client input. A ts is either a well-formed ISO string with an offset, stored verbatim,
 * or ignored in favour of the server's now. Parsing untrusted input into a Date is how
 * `ts: 0` became a 1970-01-01 row in an earlier draft — 0 survives a null check, fails
 * a `> 0` check, and new Date(0) is a perfectly valid Date.
 *
 * A slot in the future is rejected rather than trusted: you can only account for a block
 * that has started. nowSlot is the last *completed* block, so the in-progress block is
 * still allowed through the `<=` on parsed values below.
 */
function normaliseEntry_(raw, nowIso, nowSlot) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'no payload' };

  var bucket = isValidBucket_(raw.bucket);
  if (!bucket) return { ok: false, error: 'bad bucket' };

  var sentence = (raw.sentence == null ? '' : String(raw.sentence)).trim();
  if (!sentence) return { ok: false, error: 'empty sentence' };
  if (sentence.length > MAX_SENTENCE) sentence = sentence.slice(0, MAX_SENTENCE);

  var ts = nowIso;
  if (typeof raw.ts === 'string' && ISO_RE.test(raw.ts.trim())) ts = raw.ts.trim();

  // Both strings are regex-validated by here, so comparing them as instants is safe.
  var slot = normaliseSlot_(raw.slot);
  if (!slot || Date.parse(slot) > Date.parse(ts)) slot = nowSlot;

  return {
    ok: true,
    entry: {
      id: raw.id == null ? '' : String(raw.id).slice(0, 64),
      slot: slot,
      ts: ts,
      bucket: bucket,
      sentence: sentence,
      dayStart: truthy_(raw.dayStart)
    }
  };
}

/** Sort comparator for entries by the block they account for, oldest first. */
function bySlot_(a, b) {
  return Date.parse(a.slot) - Date.parse(b.slot);
}

/**
 * Given entries sorted by slot, return the current logical day: everything from the last
 * day_start tick onward. Falls back to a rolling window when no tick is present, so a day
 * you forgot to open is still visible and therefore still fixable.
 */
function currentDaySlice_(sorted, nowMs) {
  for (var i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].dayStart) return sorted.slice(i);
  }
  var cutoff = nowMs - FALLBACK_DAY_HOURS * 3600000;
  var out = [];
  for (var j = 0; j < sorted.length; j++) {
    if (Date.parse(sorted[j].slot) >= cutoff) out.push(sorted[j]);
  }
  return out;
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

    var action = (raw && raw.action) || 'log';

    if (action === 'log') {
      var result = normaliseEntry_(raw, nowIso_(), slotNow_());
      if (!result.ok) return json_({ ok: false, error: result.error });
      return json_(commit_(result.entry));
    }

    if (action === 'update') return json_(update_(raw));
    if (action === 'delete') return json_(remove_(raw));

    return json_({ ok: false, error: 'unknown action' });
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
        now: nowIso_(),
        slot: slotNow_()
      });
    }

    if (action === 'today') {
      var recent = readTail_(2 * MAX_ENTRIES_PER_DAY).sort(bySlot_);
      return json_({ ok: true, slot: slotNow_(), entries: currentDaySlice_(recent, Date.now()) });
    }

    if (action === 'week') {
      var days = Math.min(31, Math.max(1, Number(p.days) || 7));
      return json_({ ok: true, slot: slotNow_(), entries: readRecent_(days) });
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
 * Append one entry, at most once per client id, ever.
 *
 * The cache lookup sits inside the lock on purpose: two retries arriving together would
 * both miss a check performed outside it, and both would append.
 *
 * The cache is only a fast path. The sheet is checked too, because the cache expires
 * after six hours and a queued retry can outlive that easily — phone dies at 8pm, queue
 * flushes at 9am. Without the sheet check that produces a silent duplicate.
 */
function commit_(entry) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy' };
  try {
    var sheet = logSheet_();
    var cache = CacheService.getScriptCache();
    var key = entry.id ? 'id:' + entry.id : '';

    if (key) {
      var cached = cache.get(key);
      if (cached) return { ok: true, row: Number(cached), dedup: true };

      var existing = findRowById_(sheet, entry.id);
      if (existing) {
        cache.put(key, String(existing), DEDUP_TTL_SECONDS);
        return { ok: true, row: existing, dedup: true };
      }
    }

    var row = appendEntry_(entry);
    if (key) cache.put(key, String(row), DEDUP_TTL_SECONDS);
    return { ok: true, row: row };
  } finally {
    lock.releaseLock();
  }
}

/** The only place that appends. Six values, in column order. */
function appendEntry_(entry) {
  var sheet = logSheet_();
  sheet.appendRow([
    entry.slot,
    entry.bucket,
    entry.sentence,
    entry.dayStart ? true : '',
    entry.ts,
    entry.id
  ]);
  return sheet.getLastRow();
}

/**
 * Rewrite A–D of an existing entry, found by id. E and F are never touched: logged_at
 * always means when the entry was first composed, and the id is the identity.
 *
 * Slot, bucket, sentence and day_start are all editable. Editing day_start is what makes
 * a missed or misplaced day tick a two-tap fix from the phone instead of a trip to a
 * desk — see SPEC.md on the tradeoff being made here.
 */
function update_(raw) {
  var id = raw && raw.id == null ? '' : String(raw.id);
  if (!id) return { ok: false, error: 'no id' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy' };
  try {
    var sheet = logSheet_();
    var row = findRowById_(sheet, id);
    if (!row) return { ok: false, error: 'not found' };

    var loggedAt = String(sheet.getRange(row, COL.LOGGED_AT).getValue());
    var shaped = normaliseEntry_(
      { id: id, slot: raw.slot, ts: loggedAt, bucket: raw.bucket,
        sentence: raw.sentence, dayStart: raw.dayStart },
      loggedAt,
      slotNow_()
    );
    if (!shaped.ok) return { ok: false, error: shaped.error };
    var entry = shaped.entry;

    sheet.getRange(row, COL.SLOT, 1, 4).setValues([[
      entry.slot, entry.bucket, entry.sentence, entry.dayStart ? true : ''
    ]]);
    return { ok: true, row: row, updated: true };
  } finally {
    lock.releaseLock();
  }
}

/** Hard-delete an entry by id. Also drops the dedupe key so the row number can't go stale. */
function remove_(raw) {
  var id = raw && raw.id == null ? '' : String(raw.id);
  if (!id) return { ok: false, error: 'no id' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy' };
  try {
    var sheet = logSheet_();
    var row = findRowById_(sheet, id);
    if (!row) return { ok: false, error: 'not found' };

    sheet.deleteRow(row);
    CacheService.getScriptCache().remove('id:' + id);
    return { ok: true, deleted: true };
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ *
 * Read path
 *
 * Everything here sorts by hour_slot, never by row position. Once an entry can be
 * assigned to an earlier block than the one it was written in, row order stops being
 * time order, and a reader that trusts row order silently reports the wrong day.
 * ------------------------------------------------------------------ */

/** The last n rows as entry objects, in sheet order. */
function readTail_(n) {
  var sheet = logSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return [];

  var start = Math.max(2, last - n + 1);
  var values = sheet.getRange(start, 1, last - start + 1, HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var slot = String(values[i][0]);
    if (!ISO_RE.test(slot)) continue; // skip anything hand-typed into the sheet badly
    out.push({
      slot: slot,
      bucket: String(values[i][1]),
      sentence: String(values[i][2]),
      dayStart: values[i][3] === true,
      loggedAt: String(values[i][4]),
      id: String(values[i][5])
    });
  }
  return out;
}

/** Entries whose block falls within the last `days` days, oldest first. */
function readRecent_(days) {
  var rows = readTail_(days * MAX_ENTRIES_PER_DAY);
  var cutoff = Date.now() - days * 86400000;
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (Date.parse(rows[i].slot) >= cutoff) out.push(rows[i]);
  }
  return out.sort(bySlot_);
}

/** Row number of an entry by id, or 0. Scans newest first: edits target recent rows. */
function findRowById_(sheet, id) {
  var last = sheet.getLastRow();
  if (last < 2 || !id) return 0;
  var ids = sheet.getRange(2, COL.ID, last - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]) === id) return i + 2;
  }
  return 0;
}

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

function nowIso_() {
  return toIsoWithOffset_(new Date(), Session.getScriptTimeZone());
}

/**
 * The last completed hour block, as an ISO instant at the top of that hour.
 *
 * At 17:49 this is 16:00 — the block that just closed, which is what a 17:00 ping is
 * asking about. Formatting an hour-earlier instant in the target timezone gets the local
 * hour right without any date arithmetic, which matters at +05:30 where local hour
 * boundaries do not line up with UTC ones.
 */
function slotNow_() {
  var oneHourAgo = new Date(Date.now() - 3600000);
  return Utilities.formatDate(oneHourAgo, Session.getScriptTimeZone(),
    "yyyy-MM-dd'T'HH':00:00'XXX");
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
 * Run from the editor
 * ------------------------------------------------------------------ */

function bootstrap() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

  // Text format is load-bearing on both timestamp columns: without it Sheets parses the
  // ISO string into a datetime and throws the offset away, which is v1's +12:30 bug
  // exactly. The id column is text so a numeric-looking id is never coerced.
  sheet.getRange('A:A').setNumberFormat('@');
  sheet.getRange('E:E').setNumberFormat('@');
  sheet.getRange('F:F').setNumberFormat('@');

  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(COL.SLOT, 190);
  sheet.setColumnWidth(COL.BUCKET, 90);
  sheet.setColumnWidth(COL.SENTENCE, 560);
  sheet.setColumnWidth(COL.DAY_START, 90);
  sheet.setColumnWidth(COL.LOGGED_AT, 190);
  sheet.setColumnWidth(COL.ID, 170);

  var msg = 'bootstrap ok — "' + SHEET_NAME + '" ready, ' + HEADERS.length +
            ' columns, tz ' + Session.getScriptTimeZone();
  Logger.log(msg);
  return msg;
}

/**
 * Wipes every entry and rewrites the headers. There is no undo.
 *
 * Named to be unmistakable in the function dropdown, because it sits one click away from
 * bootstrap(). Only needed once, to clear the four-column test rows.
 */
function DANGER_resetLog() {
  var ss = SpreadsheetApp.getActive();
  var old = ss.getSheetByName(SHEET_NAME);
  if (old) ss.deleteSheet(old);
  ss.insertSheet(SHEET_NAME);
  var msg = 'log wiped — ' + bootstrap();
  Logger.log(msg);
  return msg;
}

/**
 * Round-trips a probe entry through the real append, update and delete paths, then
 * confirms it is gone. Run after bootstrap() and after any redeploy.
 *
 * This exists because the failures it catches are invisible: v1's timezone split only
 * became apparent after diffing 100 rows by hand, months later.
 */
function selfTest() {
  var tz = Session.getScriptTimeZone();
  var probeIso = nowIso_();
  var probeSlot = slotNow_();
  var probeId = 'selftest-' + Date.now();
  var problems = [];
  var sheet = logSheet_();

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(probeIso)) {
    problems.push('toIsoWithOffset_ produced "' + probeIso +
                  '" — the XXX pattern is not rendering an offset');
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00[+-]\d{2}:\d{2}$/.test(probeSlot)) {
    problems.push('slotNow_ produced "' + probeSlot + '" — not a clean top-of-hour slot');
  }

  // 1. append
  var row = appendEntry_({
    id: probeId, slot: probeSlot, ts: probeIso,
    bucket: 'Needed', sentence: 'SELFTEST — delete me', dayStart: true
  });

  var slotBack = sheet.getRange(row, COL.SLOT).getValue();
  if (typeof slotBack !== 'string') {
    problems.push('hour_slot came back as ' + (typeof slotBack) +
                  ', not string — Sheets is coercing it; re-run bootstrap()');
  } else if (slotBack !== probeSlot) {
    problems.push('hour_slot round-tripped "' + probeSlot + '" as "' + slotBack + '"');
  }
  if (typeof sheet.getRange(row, COL.LOGGED_AT).getValue() !== 'string') {
    problems.push('logged_at was coerced out of text format — re-run bootstrap()');
  }
  if (sheet.getRange(row, COL.DAY_START).getValue() !== true) {
    problems.push('day_start did not store as boolean TRUE');
  }
  if (String(sheet.getRange(row, COL.ID).getValue()) !== probeId) {
    problems.push('id did not store intact — edit and delete cannot work');
  }

  // 2. find by id, the lookup every edit depends on
  if (findRowById_(sheet, probeId) !== row) {
    problems.push('findRowById_ did not locate the probe row');
  }

  // 3. update
  var upd = update_({ id: probeId, slot: probeSlot, bucket: 'Drifted',
                      sentence: 'SELFTEST — edited', dayStart: false });
  if (!upd.ok) {
    problems.push('update failed: ' + upd.error);
  } else {
    if (sheet.getRange(row, COL.BUCKET).getValue() !== 'Drifted') {
      problems.push('update did not rewrite the bucket');
    }
    if (sheet.getRange(row, COL.DAY_START).getValue() === true) {
      problems.push('update did not clear day_start — a misplaced tick would be unfixable');
    }
    if (String(sheet.getRange(row, COL.LOGGED_AT).getValue()) !== probeIso) {
      problems.push('update overwrote logged_at — it must survive an edit unchanged');
    }
  }

  // 4. delete
  var del = remove_({ id: probeId });
  if (!del.ok) {
    problems.push('delete failed: ' + del.error + ' — REMOVE THE PROBE ROW BY HAND');
  } else if (findRowById_(sheet, probeId)) {
    problems.push('probe row still present after delete');
  }

  var msg = problems.length
    ? 'FAIL:\n- ' + problems.join('\n- ')
    : 'PASS — tz ' + tz + ', logged_at ' + probeIso + ', slot ' + probeSlot +
      ', append/update/delete all clean, probe row removed';
  Logger.log(msg);
  return msg;
}
