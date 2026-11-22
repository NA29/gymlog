# gymlog

Phone-first logger for a coach-written 12-week push/pull/legs plan, deployed as a private Claude artifact.

- **Next session, not today's date:** the plan advances by sessions, so a skipped day skips nothing.
- **Pre-filled sets:** last time's weight and reps, with the coach's double-progression rule (top of the range on every set → add weight).
- **Plan board** (72 sessions, crossed out when done), **calendar**, rest timer, lighter-week option for weeks 4/8/12.
- **Weekly check-in** pre-filled from the logs (readiness average, performance, wins, next-week adjustment).
- **Google Sheets sync:** each finished session writes Sets done / Avg reps / Weight / Notes into the coach's sheet through the viewer's Google Sheets connector. Rows are found by label, and nothing is written if the layout doesn't match. The Volume formula column is never touched.

## Data

The artifact's database holds the record: `sessions/<wNN-sessionId>`, `checkins/wNN`, `meta/settings` (sheet ID). Access rules are owner-only. The sheet is a copy of that data.

## Develop

```sh
npm test               # logic + headless UI tests (node:test, no dependencies)
node build.js [out]    # inline src/ into one page (default dist/index.html)
```

Deploy by publishing the built page to the existing artifact URL. Don't create a new artifact: a new one starts with an empty database.

## Coach rules applied on export

- Two-dumbbell lifts: log one dumbbell's weight; the sheet gets the combined weight.
- One-sided moves (`Single-Arm`, `Single-Leg`, `/ leg` ranges): log reps per side; the sheet gets both sides.
- Weight is the rep-weighted average across ticked sets, so sets × avg reps × weight equals real tonnage.
