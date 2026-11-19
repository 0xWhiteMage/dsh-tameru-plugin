# Frozen DeepSeek plugin setting for engine 1.10.0 (round 2, 2026-11-19)

> **This setting is NOT the default.** It was frozen only for the round 1 DeepSeek holdout look, and that look **failed gate 8** (facts
> kept lower bound -2.27 against a -1.0 margin; extract facts kept lower bound 82.5% against an 85% bar). The default is the incumbent
> behaviour on the `stable` channel (every-step, gate 0.7). T-0 is what the `beta` channel runs when no `policy` is set, and it is
> unconfirmed. `test/fixtures/replay/holdout_looks.json` has **two** entries for that one look: the first run crashed (the baseline arm
> needed `--baseline-vendor`) before reading any result; the second has `plugin_dirty: true` because the first run had appended to the
> log. The holdout is burned (`test/fixtures/replay/BURNED-HOLDOUTS.md`) and the runner refuses it. That look's `baseline-1.9.0` arm ran
> with `settings: {}`, which at the time resolved to at-trigger with no gate, not the 1.9.0-era every-step/0.7 behaviour (now explicit).
> This note changes the file's hash; the look was logged with the hash `a8b37679...` of the version in commit `c4ecfbf`.

arm: T-0

Chosen by the pre-registered rule (engine `docs/ANALYSIS-PLAN-1.10.md`, "tuning round 2 (declared before running)"), on development and
validation only, replay only. (Written before the look: at the time no holdout look had been taken.)

- policy: `at-trigger` (act only where the Harness's own pruner is about to cut; the engine's extract replaces its head/tail cut when the
  extract is no longer than that cut; written only if the stock pruner still runs afterwards or no result it would cut is left)
- minConfidence: 0 (the cut being replaced has no confidence check)
- activation: not used (acts at 1.0 of the stock trigger); protectRecent 0, minResultChars 8193, share 0 (all set by the policy)
- engine: 1.10.0 preset `dsh-tool-result@1`, redaction on, anchor_errors on
- Dev: cost -2.0% vs the 1.9.0-era plugin [-2.8, -1.3] (upper bound -1.4), facts kept +10.7 points [+5.4, +16.9] (lower +6.1), 36 clusters.
- Validation: cost -1.4% [-2.3, -0.6] (upper -0.7), facts kept +5.4 points [+1.3, +10.8] (lower +1.7), 24 clusters; extract facts kept 94.9% (lower 86.4%).
- Settings tried in all: 26 (round 1: 7, round 2: 19).

The setting hash is the sha256 of this file with LF line endings; the runner computes it and logs it with any look, and the commit message and `docs/REPLAY-1.10.0.md` state it.
