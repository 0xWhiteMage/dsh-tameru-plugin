# Burned holdouts

A holdout whose hash is listed here has been looked at. It is never used for confirmation again: `node scripts/replay.ts --holdout`
refuses to run when the current holdout hashes to a value listed below (checked before any look is logged). A burned set moves into
development and validation for the next round, and the next round needs a new sealed holdout with a new registered hash.

| Hash (sha256, see `HOLDOUT.sha256`) | Burned | Why |
|---|---|---|
| ac9e77dd723d3755b8238c4a1e60d6947e798ddcc0ee489e9d2c10f2b5ca1489 | 2026-11-19 | Round 1 DeepSeek holdout (48 scenarios, 8 families). Looked at once on the frozen setting T-0 (`holdout_looks.json` has two entries: the first run crashed before reading results, the second ran with `plugin_dirty: true` because the first had appended to the log). Gate 8 failed. Moves into dev/validation for round 2. Note: that look's `baseline-1.9.0` arm ran with `settings: {}`, which then meant at-trigger with no gate, not the 1.9.0-era every-step/0.7 behaviour. |

Round 2 reads the burned set as development data only through `loadBurnedAsDev()` (`--split ...+burned-r1`, rows labelled
`burned-r1`), which refuses unless the hash is listed here and never logs a look.
