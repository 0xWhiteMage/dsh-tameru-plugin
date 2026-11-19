# Frozen DeepSeek plugin setting for engine 1.10.0 (round 2, 2026-11-19)

arm: T-0

Chosen by the pre-registered rule (engine `docs/ANALYSIS-PLAN-1.10.md`, "tuning round 2 (declared before running)"), on development and
validation only, replay only. No holdout look has been taken (`test/fixtures/replay/holdout_looks.json` is `[]`).

- policy: `at-trigger` (act only where the Harness's own pruner is about to cut; the engine's extract replaces its head/tail cut when the
  extract is no longer than that cut; written only if the stock pruner still runs afterwards or no result it would cut is left)
- minConfidence: 0 (the cut being replaced has no confidence check)
- activation: not used (acts at 1.0 of the stock trigger); protectRecent 0, minResultChars 8193, share 0 (all set by the policy)
- engine: 1.10.0 preset `dsh-tool-result@1`, redaction on, anchor_errors on
- Dev: cost -2.0% vs the 1.9.0-era plugin [-2.8, -1.3] (upper bound -1.4), facts kept +10.7 points [+5.4, +16.9] (lower +6.1), 36 clusters.
- Validation: cost -1.4% [-2.3, -0.6] (upper -0.7), facts kept +5.4 points [+1.3, +10.8] (lower +1.7), 24 clusters; extract facts kept 94.9% (lower 86.4%).
- Settings tried in all: 26 (round 1: 7, round 2: 19).

The setting hash is the sha256 of this file with LF line endings; the runner computes it and logs it with any look, and the commit message and `docs/REPLAY-1.10.0.md` state it.
