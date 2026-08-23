# Lifelog

One sentence an hour, and one honest word about what the hour was.

Read [SPEC.md](SPEC.md) before changing anything — most of what looks like a missing
feature was removed on purpose.

```
MacroDroid  ──ping──▶  HUD (this repo, GitHub Pages)  ──POST──▶  Apps Script  ──▶  Sheet
   no state              no secrets committed              token in Script Properties
```

| File | What it is |
|---|---|
| `index.html` | the whole HUD — capture screen, first-run config, retry queue |
| `Code.gs` | paste into the Apps Script editor bound to your Sheet |
| `sw.js`, `manifest.webmanifest`, `icon-*.png` | offline shell and home-screen install |
| `lifelog-ping.macro.json` | import into MacroDroid |
| `SPEC.md` | why it is shaped like this |

## Setup, in click order

### 1. Sheet and script

1. New blank Google Sheet. Name it whatever you like.
2. **Extensions → Apps Script.** Delete the stub `myFunction`, paste all of `Code.gs`, save.
3. **Project Settings** (gear, left rail) **→ Script Properties → Add property.**
   Name `LIFELOG_TOKEN`, value: any long random string. This is the only secret, and it
   lives only here. Keep a copy — you paste it into the HUD in step 8.
4. Back in the editor, pick **`bootstrap`** from the function dropdown and **Run.**
   Authorise when prompted. It creates the `Log` sheet, writes the four headers, and
   forces column A to text format.
5. Pick **`selfTest`** and **Run.** The execution log must say `PASS`. It writes a probe
   row, checks the timestamp survived the round trip byte-for-byte, and deletes the row.
   If it says `FAIL`, the message names the problem — fix it before going further.

### 2. Deploy

6. **Deploy → New deployment → Web app.** Execute as **Me**, who has access
   **Anyone**. Deploy, then copy the `/exec` URL.

   > **Every time you change `Code.gs` you must Deploy → Manage deployments → edit →
   > Version: New version.** Otherwise the `/exec` URL keeps serving the old code and
   > you will debug a file that is not running. This wasted real hours on v1.

7. Sanity check in a browser — paste the URL with the token appended:
   `…/exec?action=health&token=YOUR_TOKEN` → `{"ok":true,"rows":0,"tz":"Asia/Calcutta",…}`
   If `tz` is not your timezone, fix it in **Project Settings → Time zone**.

### 3. HUD

8. Push this repo, enable **Settings → Pages → Deploy from branch → main / root**, then
   open `https://kunalvrma.github.io/LifelogOS/`. Paste the `/exec` URL and the token.
   It verifies against `health` before saving, so a typo is caught here instead of
   silently queueing every entry forever.
9. Chrome menu → **Add to Home screen.** Log one real entry and confirm one row appears.

### 4. Ping

10. MacroDroid → **⋮ → Import macro** → `lifelog-ping.macro.json`. Or build it by hand in
    about a minute, which is safer than an import that hits an unknown field:

    - **Trigger:** Regular Interval → every 1 hour → reference time 00:00, "align to
      reference" on, "use alarm" on.
    - **Action:** Notification → Display Notification.
      Title `{hour12} {am_pm} — log the hour`, text `Needed, Wanted or Drifted, then one
      sentence.`, channel **Silent**, priority **Low**, overwrite existing on, a fixed
      notification id (so each hour replaces the last instead of stacking).
      On press → `https://kunalvrma.github.io/LifelogOS/`.
    - **Constraint:** Time of Day 06:00–01:00.

11. Two things in the import are guesses and need one look on the phone: the 06:00–01:00
    window crosses midnight, which the schema does not confirm — if pings stop after
    midnight, **just delete the constraint**, the notification is silent so a 3am one
    costs nothing. And the icon name `fa_clock` may not resolve — if it looks blank, pick
    an icon in the UI.
12. Android will throttle this eventually unless MacroDroid is exempt from battery
    optimisation. Settings → Apps → MacroDroid → Battery → Unrestricted.

## Data model

Four columns. Headers in row 1, data from row 2, no title banner.

| A `timestamp` | B `bucket` | C `sentence` | D `day_start` |
|---|---|---|---|
| `2026-08-23T06:24:03+05:30` | `Needed` | wokeup at 06:24hrs, coffee on the balcony | `TRUE` |
| `2026-08-23T07:10:41+05:30` | `Drifted` | scrolling, meant to be reading | |

Column A is **text**, with the offset inside the string, so no timezone anywhere in the
stack can reinterpret it. Everything else — date, hour, weekday, week, which logical day
an entry belongs to, how long that day ran — is derived when you read, never stored.

`day_start` marks the first entry of a day. Day *N* ends at the row before the next ticked
row. Forgot to tick? Tick it later; the segmentation is computed on read, so everything
re-segments.

## Endpoints

```
POST /exec        {token, id, ts, bucket, sentence, dayStart}  ->  {ok:true, row:47}
GET  /exec?action=health&token=…                              ->  {ok:true, rows, tz, now}
GET  /exec?action=week&token=…&days=7                         ->  {ok:true, entries:[…]}
```

Sent as `text/plain` under `mode:'cors'` — a safelisted content type, so no preflight,
which Apps Script handles badly. **Never `no-cors`:** it makes the response unreadable,
and that is precisely how v1 showed a green checkmark over writes that never landed. Every
non-`{"ok":true}` answer, including an HTML error page, queues the entry in `localStorage`
and says so on screen. Nothing is ever dropped quietly.

`id` is an idempotency key, held for six hours in `CacheService`, so a retry after an
ambiguous failure cannot double-write.

## Reading it

Sunday. Open the Sheet, read column C in order. The sentences are the mirror; numbers only
tell you where to look.
