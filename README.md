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
| `index.html` | the whole HUD — capture screen with hour-block stepper, Today/Week drawer, light-dark toggle, first-run config, retry queue |
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
   Authorise when prompted. It creates the `Log` sheet, writes the six headers, and forces
   columns A, E and F (`hour_slot`, `logged_at`, `id`) to plain-text format.

   > **Re-provisioning an existing sheet?** If you already ran an earlier four-column
   > version, the old `Log` sheet and its rows are incompatible. Run **`DANGER_resetLog`**
   > once — it deletes and recreates the `Log` sheet from scratch — then run `bootstrap`.
   > This wipes all existing rows, so only do it on a sheet whose data you are willing to
   > lose (test rows).

5. Pick **`selfTest`** and **Run.** The execution log must say `PASS`. It writes a probe
   entry, checks all six columns survive the round trip byte-for-byte, finds the row by its
   `id`, edits it (confirming `logged_at` is preserved and the day-start tick clears), then
   deletes it. If it says `FAIL`, the message names the problem — fix it before going further.

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

Six columns. Headers in row 1, data from row 2, no title banner.

| A `hour_slot` | B `bucket` | C `sentence` | D `day_start` | E `logged_at` | F `id` |
|---|---|---|---|---|---|
| `2026-08-23T06:00:00+05:30` | `Needed` | wokeup at 06:24hrs, coffee on the balcony | `TRUE` | `2026-08-23T06:24:03+05:30` | `k7f3…` |
| `2026-08-23T07:00:00+05:30` | `Drifted` | scrolling, meant to be reading | | `2026-08-23T07:10:41+05:30` | `k7f9…` |

`hour_slot` is the one-hour block the entry accounts for, floored to the top of the hour. A
ping at 5pm is about the 4–5pm block, so `hour_slot` is `16:00`. `logged_at` is when you
actually tapped — the two differ whenever pings pile up and you catch up later, which is
exactly why the block has to be stored and not inferred from the tap time.

Columns A, E and F are **text**, with the offset inside the string, so no timezone anywhere
in the stack can reinterpret them. Everything else — date, weekday, week, which logical day
an entry belongs to, how long that day ran, the per-day balance — is derived when you read,
never stored.

`id` is a client-generated identity used for idempotent writes and for edit/delete. `day_start`
marks the first entry of a day. Day *N* ends at the entry before the next ticked entry, **in
slot order** — once entries can be backdated, the newest row is no longer the latest hour, so
every read sorts by `hour_slot` first. Forgot to tick? Tick it later from the Today drawer;
the segmentation is computed on read, so everything re-segments.

## Endpoints

```
POST /exec   {token, action:'log',    id, slot, ts, bucket, sentence, dayStart}  -> {ok:true, row:47}
POST /exec   {token, action:'update', id, slot, bucket, sentence, dayStart}      -> {ok:true, row:47}
POST /exec   {token, action:'delete', id}                                        -> {ok:true}
GET  /exec?action=health&token=…                     -> {ok:true, rows, tz, now, slot}
GET  /exec?action=today&token=…                      -> {ok:true, slot, entries:[…]}  // current logical day
GET  /exec?action=week&token=…&days=7                -> {ok:true, slot, entries:[…]}  // last N days
```

`action` defaults to `log` when omitted. `today` and `week` return entries already sorted by
`hour_slot`; the HUD drawer segments them into logical days on the client.

Sent as `text/plain` under `mode:'cors'` — a safelisted content type, so no preflight, which
Apps Script handles badly. **Never `no-cors`:** it makes the response unreadable, and that is
precisely how v1 showed a green checkmark over writes that never landed. Every
non-`{"ok":true}` answer, including an HTML error page, queues the entry in `localStorage`
and says so on screen. Nothing is ever dropped quietly.

`id` is an idempotency key, held six hours in `CacheService` **and** checked against the
Sheet inside a lock before every append — so a retry after an ambiguous failure cannot
double-write even if it arrives after the cache has expired.

## Reading it

Open the app, tap **DAY**. **Today** is an hour rail for the current logical day — tap a
filled hour to edit or delete it, tap an empty hour to log it. **Week** is the Sunday review:
seven days of Needed/Wanted/Drifted balance with the sentences underneath. The sentences are
the mirror; numbers only tell you where to look.
