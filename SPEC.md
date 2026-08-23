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
row before the next ticked row. One marker, nothing to remember, and a missed tick is
recoverable — tick it later and everything re-segments, because the segmentation is
computed on read and never stored.

> **Clock rules may decide whether the phone buzzes, never what day an entry belongs to.**

A wrong buzz costs one ignored notification. A wrong day assignment corrupts the record
silently. So there is no Start/Stop, no session state, no flag to remember to set.

Rejected, and why:

- *A hardcoded cutoff hour* — I was wide awake at 6:24am. Any constant is wrong sometimes.
- *Inferring from the sentence text* (I habitually open a day with "wokeup at xx:xx…") —
  too clever. "Wokeup from a nap" would split a day in half.
- *A separate DAY STARTED marker row* — creates a second row type that every read has to
  filter, forever.

## Data model

Store only irreducible facts. Four columns, and nothing else is ever added.

| Column | Type | Notes |
|---|---|---|
| A `timestamp` | **text** | ISO 8601 with offset, e.g. `2026-08-23T14:03:11+05:30` |
| B `bucket` | text | exactly one of `Needed`, `Wanted`, `Drifted` |
| C `sentence` | text | free text, one line |
| D `day_start` | boolean | `TRUE` on the first entry of a day, otherwise blank |

Headers in row 1. Data from row 2. **No title banner** — v1 had one, which pushed data to
row 3 and made every hand-written range off by two.

Date, hour, weekday, week number, logical day and day length are **all derived at read
time**. Never stored.

v1 stored six derived columns computed once at write time. They rotted. A week number
computed with a locale-dependent format string and no year component would have collided
January 2027 with January 2026. Derived data that is frozen is just a lie with a
timestamp on it.

**Column A must be text, not a Date.** v1 wrote column A as a Date object, which Sheets
rendered in the *spreadsheet's* timezone, while the other columns were strings built from
the *script's* timezone — a constant +12:30 split across all 100 rows. Storing the offset
inside the string makes the value self-describing and removes both timezones from the
equation. The bootstrap forces column A's number format to `@` so Sheets cannot silently
coerce it back into a date and throw the offset away.

## Capture flow

1. Optional tick: **first entry of the day**.
2. One tap: **Needed / Wanted / Drifted**.
3. One sentence.
4. Send.

The tap comes *before* the text box. It is the frictionless start that builds momentum,
and it pre-frames the sentence — having just called the hour Drifted, the sentence I write
about it is a different and more truthful sentence.

**The timestamp is captured at first interaction, not at send.** The moment I sat down to
log is the hour being logged. An entry started at 2:58 and sent at 3:01 belongs to the two
o'clock hour.

Nothing else is ever added to this screen.

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
