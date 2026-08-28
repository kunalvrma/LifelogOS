# CLAUDE.md — start here

You are an AI (or a human) picking up this repo cold. This file orients you in ~5 minutes.
It tells you what to read, the rules you must not break, how to prove you didn't, and what is
deliberately left out. It does **not** re-explain the reasoning — that lives in `SPEC.md`, and
you should read `SPEC.md` before changing anything. Every "why is it built this weird way?"
is answered there, on purpose.

## What this is

A personal hourly life-logging system. Once an hour a silent phone notification invites one
tap and one sentence: **which of `Needed` / `Wanted` / `Drifted` the last hour was, and one
honest line about it.** That's the whole product. It is a mirror, not a tracker.

The one design test that governs every feature: **if you already know the answer before you're
asked, it's data entry, not the product.** v1 died because it asked four descriptive questions
(category, subtag, energy, location) the user already knew — effort with no self-knowledge
yield. The bucket describes **the hour, not the activity**: client work at 2pm is `Needed`; the
same work at 11pm because it was avoided all day is `Drifted`. The moment it becomes a lookup
table, it's dead. Do not add fields that ask the user to classify facts.

## Architecture

```
MacroDroid (silent hourly ping, holds no state)
   → HUD  (this repo: a single-file PWA on GitHub Pages)
   → IndexedDB  (local source of truth — instant reads/writes)
   → background sync  (fire-and-forget POST to server)
   → Apps Script Web App  (Code.gs, the /exec endpoint)
   → Google Sheet  (one tab, "Log", six columns)
```

Stack: vanilla HTML/CSS/JS (no build step, no framework), IndexedDB, Google Apps Script,
Google Sheets, MacroDroid. Nothing compiles; what you see is what ships.

## Repo map

| File | Responsibility |
|---|---|
| `SPEC.md` | **Read first.** The philosophy and the *why* behind every decision. The durable brain of the project. |
| `Code.gs` | Apps Script backend: validate → dedupe → append/update/delete. Pasted into the Apps Script editor; committed here for version control. Holds **no** secrets. |
| `index.html` | The entire HUD — LIFELOG header with app-icon (opens left Today/Week drawer) and hamburger icon (opens right menu: theme toggle, sync status, reset config), centered hour-block stepper, toast feedback system, IndexedDB offline-first data layer with background sync, light/dark theme. One file, inline CSS/JS. |
| `manifest.webmanifest` | PWA installability + standalone display. |
| `sw.js` | Service worker: cache-first shell so the HUD opens instantly and offline. **Network-only** for the `/exec` endpoint — a cached POST response would be catastrophic. |
| `icon-192.png`, `icon-512.png` | Home-screen icons. |
| `lifelog-ping.macro.json` | MacroDroid export: hourly trigger → silent notification → open HUD. |
| `README.md` | Deployment runbook, in click order. Follow it to stand the system up. |
| `tests/` | Pure-logic harnesses. `bash tests/run.sh`. No Google account or phone needed. |

`CLAUDE.md` (this file) is the router. `SPEC.md` is the why. `README.md` is the how-to-deploy.
Three docs, three jobs — keep them from overlapping.

## Data model (the Sheet, tab `Log`, headers in row 1)

| Col | Field | Notes |
|---|---|---|
| A | `hour_slot` | The one-hour block the entry accounts for. **Stored, not derived.** Text-formatted (`@`). |
| B | `bucket` | Exactly one of `Needed`, `Wanted`, `Drifted`. Server rejects anything else. |
| C | `sentence` | Free text, truncated to 2000 chars. |
| D | `day_start` | Boolean tick: `TRUE` marks the first entry of a logical day. |
| E | `logged_at` | When the user first tapped. Text-formatted (`@`). Never edited, never shown. |
| F | `id` | Client-generated identity. The dedupe key and the edit/delete handle. Text-formatted (`@`). |

Everything else — date, weekday, week number, which logical day a row belongs to, day length,
per-day Needed/Wanted/Drifted balance — is **computed on read, never stored.** v1 stored a
derived summary tab and it silently rotted for three months. Don't store derived data.

## Invariants — do not break these (SPEC.md has the full reasoning)

1. **Timestamps are text with the offset inside the string** (e.g. `2026-08-23T16:00:00+05:30`).
   Columns A/E/F are number-formatted `@` by `bootstrap()`. Never write a `Date` object to the
   sheet — v1 did, and the spreadsheet's timezone reinterpreted all 100 rows by +12:30.
2. **`hour_slot` is floored by string surgery on the ISO text, never by date arithmetic.**
   Flooring a `+05:30` instant in UTC lands on `:30`, not the top of the hour. See `normaliseSlot_`.
3. **Future blocks are refused.** You can only account for a block that has already started.
4. **Reads sort by `hour_slot`, and days segment on the `day_start` tick — in slot order, never
   by row number and never by the clock.** Once entries can be backdated, row order ≠ time order.
   A wrong clock costs one ignored buzz; a wrong *day* assignment corrupts the record silently.
5. **`id` makes the Sheet the dedupe authority.** Check the `CacheService` id (6h TTL) *inside*
   the `LockService` lock, and also scan the sheet for the id — the cache can expire before an
   offline retry arrives.
6. **`logged_at` is preserved across every edit and never surfaced in the UI.** Edits change
   bucket + sentence + tick only.
7. **`mode:'cors'` with `Content-Type: text/plain;charset=utf-8`** (safelisted → no preflight;
   Apps Script handles `OPTIONS` badly). **Never `mode:'no-cors'`** — it makes the response
   opaque, and v1 fired a green checkmark over every failed write. Success UI fires only on a
   parsed `{"ok":true}`; everything else queues and says so.
8. **The repo is public and carries no secrets.** The token lives only in Apps Script Script
   Properties as `LIFELOG_TOKEN`; the HUD asks for the `/exec` URL + token once and keeps them
   in `localStorage`, verified against `?action=health` before saving. Never commit a `/exec`
   URL or token. The secrets scan in `tests/run.sh` is the pre-push gate — run it every time.
9. **IndexedDB is the local source of truth.** All writes go to IndexedDB first (instant), then
   sync to Google Sheets via background `syncQueue()`. Entries carry `_synced` (boolean) and
   `_pendingAction` (`'log'`/`'update'`/`'delete'`) fields. Reads always hit IndexedDB first;
   server data refreshes in background and is merged without overwriting unsynced local edits.
   The server-side dedupe (invariant 5) makes retried syncs safe.

## Endpoints (the wire contract)

- **POST** `{url}` — body is a JSON string sent as `text/plain`. `action` defaults to `log`;
  also `update` and `delete` (both keyed by `id`). Always returns HTTP 200 with JSON
  `{"ok":true,...}` or `{"ok":false,"error":...}` — never an HTML error page (the HUD can't parse one).
- **GET** `{url}?token=…&action=health` → row count + tz. Used to validate first-run config.
- **GET** `…&action=today` → the current logical day's entries (slot-ordered).
- **GET** `…&action=week&days=N` → recent days for the Week view (N clamped 1–31, default 7).

## How to verify

```bash
bash tests/run.sh        # from the repo root
```

Green means: `backend.test.js` 47/47, `hud.test.js` 17/17, the inline HUD script parses and all
`el()` DOM references resolve, and the secrets scan finds no `/exec` URL, token, or UUID in the
repo. The HUD tests **extract the pure functions straight out of `index.html` by brace-scan**, so
they cannot drift from the shipped code. There is no browser in CI — offline/manifest behaviour
is covered by logic, and must still be spot-checked on the phone after a deploy.

## Deploy protocol (the traps that cost real time)

1. **Every redeploy of the Apps Script Web App must select "New version".** Otherwise the live
   `/exec` URL keeps serving old code and you debug a file that isn't running. This is the single
   most expensive mistake in this project's history.
2. Schema (re)provision, in order, from the Apps Script editor: `DANGER_resetLog()` (drops and
   recreates the `Log` tab — destructive) → `bootstrap()` (writes the six headers, sets `@` on
   A/E/F, freezes row 1) → `selfTest()` (must log **PASS** — it round-trips all six columns,
   finds-by-id, edits asserting `logged_at` survives, deletes).
3. `README.md` has the full click-order runbook. Follow it; don't improvise the Sheet setup.

## Deliberately out of scope — do not "helpfully" add these

AI summarisation of entries, sleep-duration derivation, day-length correlations, mood / energy /
location fields, digest/streak mechanics, and migrating v1's old rows (their intent was never
captured, so `Needed`/`Wanted` is unrecoverable). Each was considered and rejected in `SPEC.md`.
If a new need appears, argue it against the design test above before building.

## What lives outside this repo (on purpose)

The implementation plan / build log (`PLAN.md`) and the v1 data export (`Lifelog OS.xlsx`) sit in
the parent folder, **not** in this public repo — the xlsx contains real diary sentences, and the
plan is a private build log. `SPEC.md` + `README.md` + this file are the complete public picture.
