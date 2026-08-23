# Lifelog — Spec

One sentence an hour, and one honest word about what the hour was.

This document is the reason the code looks the way it does. Read it before changing
anything; most of what looks like a missing feature was removed on purpose.

## What this is for

Not a tracker. A mirror.

The point is not to accumulate numbers about my life, it is to make me notice the hour
while I am still inside it. The Sheet is a byproduct. If the system ever optimises for
better analytics at the cost of a slower capture, it has been broken.

## The design test

**If you know the answer before you're asked, it's data entry. If you have to look
inward for half a second, it's the product.**

Every field is judged by that test. v1 failed it: it asked for category, subtag, energy
and location — four things I already knew the answer to. Descriptive classification is
effort with no self-knowledge yield. It got used nine days out of a hundred and fifteen.

## The one real question

Every entry carries exactly one classification: **Needed / Wanted / Drifted**.

This is borrowed from GYST, where the category encodes *intent, not fact*. Noodles bought
because I skipped lunch are Groceries — survival. The same noodles bought while lunch sits
in my bag are Dining — a want. The classification *is* the intervention; the dashboard is
a byproduct.

Two rules keep it alive:

**The bucket describes the hour, not the activity.** Client work at 2pm is Needed. The
identical client work at 11pm because I avoided it all day is Drifted. The moment it
degrades into a lookup table — *scrolling is always Drifted* — it is dead weight and
should be deleted.

**"Drifted", never "Wasted".** A word that stings gets avoided or quietly relabelled, and
here the author is also the only audience, so I would be lying to the one person the log
exists for. "Drifted" describes what happened — attention leaked — without passing
sentence. Neutral buckets are load-bearing for honesty.

Also: at ping time the verdict often hasn't arrived yet. Wanted-vs-Wasted asks me to
judge an hour I'm still standing in. Hesitation is what killed v1.

## Days don't follow the calendar

A day can run 2pm to 5am. So the day boundary is never inferred from the clock.

The first entry of a day is flagged with an explicit tick in the UI. Day *N* ends at the
entry before the next ticked entry — **in slot order, not the order rows were written.**
One marker, nothing to remember, and a missed tick is recoverable: tick it later (from the
Today drawer) and everything re-segments, because the segmentation is computed on read and
never stored.

Once entries can be backdated, insertion order stops meaning time order. Tap a ping three
hours late, or catch up on yesterday's tail this morning, and the newest *row* is no longer
the latest *hour*. So every read sorts by `hour_slot` before it does anything else, and the
"day ends before the next tick" rule is applied to that sorted sequence. This is the single
most important invariant in the read path: **trust the slot, never the row number.**

> **Clock rules may decide whether the phone buzzes, never what day an entry belongs to.**

A wrong buzz costs one ignored notification. A wrong day assignment corrupts the record
silently. So there is no Start/Stop, no session state, no flag to remember to set.

Rejected, and why:

- *A hardcoded cutoff hour* — I was wide awake at 6:24am. Any constant is wrong sometimes.
- *Inferring from the sentence text* (I habitually open a day with "wokeup at xx:xx…") —
  too clever. "Wokeup from a nap" would split a day in half.
- *A separate DAY STARTED marker row* — creates a second row type that every read has to
  filter, forever.

## The hour a ping accounts for

A ping fires at the top of the hour and asks me to account for the hour that *just closed*.
**A 5pm ping is about the 4–5pm block.** So the unit an entry describes is the one-hour
block ending at the ping, and the default block a fresh entry claims is the last completed
one: at 17:49 that is 16:00–17:00.

This has to be stored, because it cannot be recovered. `logged_at` records when I tapped —
which drifts, and is exactly the thing that drifts most when the system is working as
intended (I glance at the ambient notification and clear it whenever I surface). If pings
pile up and I log three of them at once at 8pm, all three share one `logged_at` neighbourhood
but describe three different hours. A week later, `logged_at` alone cannot tell me which hour
each entry was *about*. The intended block is an irreducible fact, not a derivation, so it
earns a stored column: `hour_slot`.

The capture screen defaults `hour_slot` to the last closed block and lets me step it
backward (▶◀ in the header, labelled as a range like "4 – 5 PM") to catch up on a block I
missed. Stepping forward past the block in progress is refused — you can only account for an
hour that has already begun.

Two guards live in the write path. The slot is floored to the top of its hour by **string
surgery on the ISO text, never by date arithmetic** — flooring a `+05:30` instant in UTC
lands on `:30`, not `:00`, which would silently shift every Indian entry half an hour. And a
slot in the future is rejected and replaced with the last closed block.

## Identity is separate from time

Every entry carries a client-generated `id`. Timestamps are unique in practice, so the id
looks redundant — but it does two things a timestamp cannot.

It makes **the Sheet the dedupe authority.** A queued offline entry can be retried after the
in-memory idempotency cache has expired (the cache lives ~6h; a phone can be offline
longer). Without a stable id checked against the Sheet itself, that retry writes a silent
duplicate under a green tick. The commit path checks the cache *and* scans the Sheet for the
id inside a lock before appending.

And it gives **edit and delete something stable to name.** Editing by "the 4pm row" breaks
the instant a backdated entry reorders the rows; editing by id does not.

## Editing is allowed — a deliberate exception

Capture is meant to be frictionless and final. But the Today drawer lets me edit an existing
entry's bucket, sentence and day-start tick, and delete it outright. This is a considered
exception, not a walk-back of "no session state":

- A mistapped bucket or a missed day tick is a real, frequent error, and the two-tap fix (open
  the drawer, retick) is what makes "a missed tick is recoverable" actually true rather than
  aspirational.
- Editability is confined to the *review* surface (the drawer), never the capture screen. The
  capture screen still does one thing.
- `logged_at` is never editable and never shown. An edit rewrites the meaning of an hour, not
  the record of when I first noticed it. The write path preserves the original `logged_at`
  through every update.

## Data model

Store only irreducible facts. Six columns, and nothing else is ever added.

| Column | Type | Notes |
|---|---|---|
| A `hour_slot` | **text** | ISO 8601 at the top of the hour, e.g. `2026-08-23T16:00:00+05:30` — the block this entry accounts for |
| B `bucket` | text | exactly one of `Needed`, `Wanted`, `Drifted` |
| C `sentence` | text | free text, one line |
| D `day_start` | boolean | `TRUE` on the first entry of a day, otherwise blank |
| E `logged_at` | **text** | ISO 8601 with offset — when I first interacted, captured at first tap |
| F `id` | text | client-generated, ≤64 chars — identity for dedupe, edit and delete |

Headers in row 1. Data from row 2. **No title banner** — v1 had one, which pushed data to
row 3 and made every hand-written range off by two.

`hour_slot`, `logged_at` and `id` are the only irreducible facts. Date, hour, weekday, week
number, logical day, day length, and the whole per-day balance are **derived at read time**.
Never stored.

v1 stored six *derived* columns computed once at write time. They rotted. A week number
computed with a locale-dependent format string and no year component would have collided
January 2027 with January 2026. Derived data that is frozen is just a lie with a timestamp on
it. Note the distinction: `hour_slot` is stored not because it is convenient but because it
is *not derivable* — `logged_at` genuinely does not tell you the intended block.

**Columns A, E and F must be text, not Dates.** v1 wrote its timestamp as a Date object,
which Sheets rendered in the *spreadsheet's* timezone while the other columns were strings
built from the *script's* timezone — a constant +12:30 split across all 100 rows. Storing the
offset inside the string makes each value self-describing and removes both timezones from the
equation. The bootstrap forces the `@` (plain-text) number format on A, E and F so Sheets
cannot silently coerce them back into dates and throw the offset away.

## Capture flow

1. The screen opens already claiming **the last closed block** (e.g. "4 – 5 PM"). Step it
   back only if I'm catching up on an earlier hour.
2. Optional tick: **first entry of the day**.
3. One tap: **Needed / Wanted / Drifted**.
4. One sentence.
5. Send.

The block is a default, not a question — most of the time I never touch it. The bucket tap
comes *before* the text box. It is the frictionless start that builds momentum, and it
pre-frames the sentence — having just called the hour Drifted, the sentence I write about it
is a different and more truthful sentence.

**`logged_at` is captured at first interaction, not at send.** The moment I sat down to log
is recorded; the *hour I'm accounting for* is `hour_slot`, chosen separately. An entry I
start typing at 2:58 and send at 3:01 has a `logged_at` of 2:58, independent of whichever
block it claims.

Nothing else is ever added to this screen. Editing and review live in the drawer, one swipe
away, never here.

## Pings

MacroDroid fires a silent, persistent, self-replacing notification naming the hour to log.
Tapping it opens the HUD.

MacroDroid holds no state and never captures data. It is a dumb alarm clock. That division
is what keeps *clock rules never decide the day* structurally true rather than merely
intended.

Silent by default, not buzzing: ESM research puts compliance decay past roughly 6–8
prompts a day, and this is a ~20-prompt-a-day system. An ambient notification I can glance
at costs nothing to ignore. If I find myself ignoring it entirely, the fix is to narrow
the window — not to abandon the system.

## Reading is half the system

v1 was write-only. Its summary tab was broken and three months stale and I never noticed,
because nothing ever asked me to look. No reward loop, so it died.

So reading is built into the HUD, not bolted on as a spreadsheet tab. The drawer has two
faces: **Today** draws an hour rail for the current logical day — one row per hour from the
day's first block to the hour in progress, filled rows in the bucket's colour, empty hours as
dashed hairlines I can tap to fill. **Week** lays out the last seven days as cards, each with
a Needed/Wanted/Drifted balance bar and its sentences underneath.

Both are **computed on read** — `?action=today` and `?action=week` segment and summarise
live from the log every time. There is deliberately no stored week tab. v1's summary was a
stored, write-time computation, and that is precisely what rotted; recomputing on every read
cannot go stale. The Sheet stays six clean columns.

Sunday: read the week's sentences in order. **The sentences are the mirror. Numbers only
tell me where to look.** Bucket ratios sliced by hour-of-day and weekday are the only
arithmetic that earns its place, and even those exist to point at a stretch of sentences.

Money is fungible and invisible, so it needs arithmetic. Time is experienced, so it needs
recall.

## Out of scope

Not "later" — out. Each of these was considered and cut.

AI summarisation. Sleep-duration derivation. Day-length correlations. Mood, energy or
location fields. Digest emails. Streaks, scores or gamification. Migrating v1's rows —
their intent was never captured, so Needed/Wanted is unrecoverable from them.

## Secrets

The repo is public and serves the HUD from GitHub Pages, so **the repo contains no
endpoint URL and no token.** The HUD asks for both once on first run and keeps them in
`localStorage`. v1 hardcoded its live `/exec` URL into a public repo; anyone who found it
could write to the Sheet.

The shared token lives in Apps Script **Script Properties** as `LIFELOG_TOKEN`, never in
source.
