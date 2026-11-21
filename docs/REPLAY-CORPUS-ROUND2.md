# Round-2 session corpus in the DeepSeek replay (P2b, replay only)

**Every figure here is replay-only.** Costs come from a deterministic offline replay of DeepSeek's conversation loop, priced after
the fact under dated price profiles; no live probe has been billed, so nothing below is a dollar claim. "Facts kept" means the fact's
line is in the final prompt of the replay; no model answered any question.

## What was run

- **Corpus.** The engine's host-neutral session corpus (engine `release/1.10.0` at `184a46f`, generator `session-corpus-3`, deal
  attempt 10), **dev (12 families, 132 scenarios) and validation (8 families, 88 scenarios) only**, materialised locally in the
  engine repository with `python -m benchmarks.session_corpus.build --split dev|validation --out <plugin>/dev/session_corpus`
  (ignored, about 1.4 GB, not committed). The sealed holdout was not built, read or run; the loader refuses a `holdout` path, any
  holdout family and any split other than dev/validation.
- **Adapter** (`scripts/replay/corpus.ts`, the engine's ADAPTERS.md mapping): window slice `steps[0 : windows[W].steps]`; questions
  answerable at W have `first_window <= W` (the `absent` question has no fact and is not scored here). A fact is held when its full
  fact line is in the text, or — for a natural/error/buried fact whose whitespace an extract rewrote — when one line holds both its
  key and its value; a real (Squeez) fact is held when its gold `value` line is in the text. `value_present` is a secondary column. A
  superseded question is held only through its newest line; an aggregate question needs every fact. Tests:
  `test/replay-corpus.test.ts` (counts, slicing, the fact check against the corpus gold, determinism, holdout refusal, the subsample
  rule; the export checks run against the local build).
- **Runner** `scripts/replay.ts` (one row per arm, scenario and window) and report `scripts/replay/corpus-report.ts`; summary numbers
  in [`docs/results/replay-corpus-round2.json`](results/replay-corpus-round2.json). The commands:

  ```
  # 128K / 252K / 500K, all 220 scenarios x 6 arms = 3,960 rows, 16 shards
  node scripts/replay.ts --corpus dev/session_corpus --split dev+validation --windows 128000,252000,500000 \
    --arms stock,baseline-1.9.0,default-1.10.0,G-0.85,T-0,T-0.7 \
    --baseline-vendor <scratch>/engine-1.9.0/vendor --shard k/16 --out <tmp>/p2b/runA/rows-k.jsonl

  # 1M, stratified subsample 3 per family (seed p2b-1m-subsample-2026-11-21): 60 scenarios x 6 arms = 360 rows, 16 shards
  node scripts/replay.ts --corpus dev/session_corpus --split dev+validation --windows 1000000 \
    --arms stock,baseline-1.9.0,default-1.10.0,G-0.85,T-0,T-0.7 \
    --baseline-vendor <scratch>/engine-1.9.0/vendor --per-family 3 --subsample-seed p2b-1m-subsample-2026-11-21 \
    --shard k/16 --out <tmp>/p2b/run1m/rows-k.jsonl
  ```

  The 4,320 rows (14 MB; deterministic apart from timing) are kept locally in `dev/replay-corpus-round2/`, not committed:

  | file | rows | sha256 |
  |---|--:|---|
  | `dev/replay-corpus-round2/rows-128k-252k-500k.jsonl` | 3,960 | `8e5daebf8e07dcaa1dddeadf8d01e8c4658c7525d0b0503da0fc6c3de097163b` |
  | `dev/replay-corpus-round2/rows-1m-subsample.jsonl` | 360 | `3a2e8f65d00d047d53036fb13ec675f536fc8175ebffa858f739f49a5fb5b84f` |
  | `dev/replay-corpus-round2/subsample-1m.json` | — | `64a8d6ea07ad3b8295c3e1711cada7a32d07a4c042a8c599220a10df1bf9df18` |

- **Arms**, no new setting (all in the settings-tried ledger), each with its settings stated explicitly (`ARMS` in
  `scripts/replay/run.ts`): `stock` (the Harness alone, never calls the plugin; `shorten: false`); `baseline-1.9.0` (reference: the
  1.9.0-era worker and engine at commit `922d171`, protocol 1 — every-step, gate 0.7, activation 0.75, share 0.35; recreate its
  vendor dir with `git archive 922d171 vendor | tar -x -C <scratch>`, which produces `<scratch>/vendor/run_worker.py` and
  `<scratch>/vendor/tameru/` — pass `<scratch>/vendor` to `--baseline-vendor`);
  `default-1.10.0` (the frozen stable channel, numbers stated in full: every-step, gate 0.7, activation 0.75, share 0.35,
  protectRecent 4, minResultChars 6000, maxPerPass 24); `G-0.85` (the same but gate 0.85); `T-0` and `T-0.7` (at-trigger, gates 0 and
  0.7). `default-1.10.0` is the same setting as `G-0.7` of round 1, run through the stable channel.
- **Windows**: 128K, 252K and 500K ran on the full 220 scenarios (all gated for the DeepSeek plugin in the round-2 plan). The 1M
  window ran on a deterministic stratified subsample of 3 scenarios per family (60 of 220) and is **report-only**, because the full
  1M run would exceed the ~60-minute-per-run-set rule: the 360 subsample runs took 371.6 CPU-minutes over 16 processes (~16 minutes
  wall), so the full 1,320 runs project to roughly 1,360 CPU-minutes, about **85 minutes** at 16 processes.
- **Prices and statistics**: the registered DeepSeek weights are 1/4 each of `deepseek-v4-pro`, `deepseek-flash`,
  `anthropic-sonnet-5.5-5m` and `openai-generic-30m`; every other profile (TTL variants, no-expiry, unit-1024, Opus, Haiku,
  `openai-generic-12h`, the two legacy prices) is a sensitivity, never a gate. Every scenario is one cluster, so intervals are
  cluster bootstraps by scenario: 10,000 draws for the weighted D (2,000 within each split), shared across profiles. All bounds
  reported here are one-sided 95% (α = 0.05). The DeepSeek plugin's next look (the sealed holdout) is judged at α_r = 0.0125
  (r = 2, analysis plan section 6), which is stricter — so nothing that fails a bound here would pass there.

## Trigger crossing

A crossing here is **a step at or above the stock trigger before anything acted** — the moments the stock pruner fires. It is not a
compaction count: on this corpus the stock arm compacts almost never (0.04 compactions per session at 128K, 0.00 at 252K, 0.00 at
500K and 0.00 at 1M), so there are almost no stock compactions to avoid. This differs from the Hermes corpus report, which counts
compactions. The round-2 rule (≥70% of sessions cross once, ≥30% twice, in every split of a gated window) **is met at every window
and split**, including 1M (report-only):

| window | split | sessions | crossed ≥1 | crossed ≥2 | crossings / session | rule | window |
|--:|---|--:|--:|--:|--:|---|---|
| 128K | dev | 132 | 100% | 100% | 4.8 | met | gated |
| 128K | validation | 88 | 100% | 100% | 5.0 | met | gated |
| 252K | dev | 132 | 100% | 87% | 1.9 | met | gated |
| 252K | validation | 88 | 100% | 90% | 1.9 | met | gated |
| 500K | dev | 132 | 100% | 63% | 1.6 | met | gated |
| 500K | validation | 88 | 100% | 75% | 1.8 | met | gated |
| 1M | dev | 36 | 100% | 72% | 1.7 | met | report-only |
| 1M | validation | 24 | 100% | 75% | 1.8 | met | report-only |

## Run time

Mean per run on one PC with 16 processes (median and CPU-process-minutes in the generated report): stock 0.4 / 0.6 / 1.9 / 3.1 s at
128K / 252K / 500K / 1M; baseline-1.9.0 2.4 / 14.5 / 42.7 / 55.2 s; default-1.10.0 2.8 / 26.3 / 90.2 / 138.7 s; G-0.85 2.8 / 26.4 /
86.5 / 152.4 s; T-0 6.4 / 9.1 / 11.4 / 11.2 s; T-0.7 6.2 / 9.0 / 11.4 / 11.0 s. The three full windows (3,960 runs) took about
1,287 CPU-minutes in ~92 minutes of wall time; the 1M subsample (360 runs) took 371.6 CPU-minutes in ~16 minutes.

## Findings

1. **The crossing rule is met at every gated window in both splits** (table above): 128K 100% / 100%, 252K 100% / 87-90%, 500K 100% /
   63-75% (≥1 / ≥2 crossings). At 1M (report-only) it is also met: 100% / 72% dev, 100% / 75% validation.
2. **Arm vs itself is exactly zero** on every metric, price config and the weighted D, at every window, in dev+validation, dev and
   validation (the check printed by the report; a rerun reproduces every field apart from timing).
3. **No arm meets the plan's primary endpoint at every gated window** (one-sided upper bound of weighted D < 0 vs stock and ≤ +1.0
   point vs the 1.9.0-era plugin, at 128K, 252K and 500K):
   - `default-1.10.0` and `G-0.85` **cost more than stock at every gated window** (+2.2 / +7.9 / +5.3 and +1.6 / +7.1 / +4.9 points;
     upper bounds all positive) and are more than +1.0 above the 1.9.0-era plugin everywhere too (+1.5 / +5.7 / +3.7 and +0.9 / +4.9 /
     +3.2; upper bounds +1.3 to +6.7).
   - `T-0` is ≈ stock (−0.17, −0.01, 0.00) and meets the ≤ +1.0 bound vs 1.9.0 at all three windows (upper bounds −0.55, −1.39,
     −1.08), but its vs-stock upper bound is **+0.003 at 500K** — not below zero, so it fails there by a hair (128K −0.03, 252K −0.004
     pass).
   - `T-0.7` is ≈ stock too but fails the vs-stock bound at **128K (+0.06) and 500K (+0.004)**; vs 1.9.0 it passes at all three.
   - The reference `baseline-1.9.0` itself costs **more than stock** at every gated window: +0.75 [+0.37, +1.19] at 128K, +2.07
     [+1.28, +2.93] at 252K, +1.63 [+0.99, +2.33] at 500K (report-only 1M: +0.51 [+0.02, +1.20]).
4. **The every-step arms' extra cost is write cost.** Rewrites per session (requests whose prompt no longer begins with everything
   the previous request sent): stock 4.69 / 1.88 / 1.68 at 128K / 252K / 500K, default-1.10.0 4.80 / 2.71 / 2.94, G-0.85 4.77 / 2.64 /
   2.87 — while read and output barely move (deepseek-v4-pro split at 252K: stock 193.0 read / 415.4 write; default 193.0 / 470.8;
   G-0.85 193.1 / 464.6; at 500K: 881.9 → 985.5 and 976.3 write). They shorten 7.4-12.2 rows per session at 252K and 500K (stock:
   0) and accept 37-47% of the rows they ask about.
5. **The T arms are ≈ stock from 252K up because they skip.** At-trigger passes end as `would_leave_cuts` (a pass outcome, not an
   applied extract): at 252K T-0 applied 13 times in 220 sessions (320 `would_leave_cuts`), at 500K 5 times (291), at 1M once (84).
   Cost −0.01 to 0.00 vs stock; facts kept ≈ stock (≤ +0.2 points from 252K up, but −2.0 to −3.5 points vs the 1.9.0-era plugin).
   At 128K they still act (98 / 93 applied) and keep +2.2 / +1.8 points over stock.
6. **Facts kept** (line check, dev+validation): stock 37.5% / 45.9% / 45.6% / 46.5% at 128K / 252K / 500K / 1M; default-1.10.0
   39.3 / 54.8 / 52.3 / 48.4 (+1.8 / +8.9 / +6.7 / +2.0 points vs stock; +1.0 / +5.3 / +4.6 / +1.5 vs 1.9.0); G-0.85 about a point
   lower (+1.7 / +6.8 / +5.0 / +1.8 vs stock); baseline-1.9.0 +0.8 / +3.6 / +2.1 / +0.5 vs stock; T arms ≈ stock. Worst family is
   `metrics` at 128K-500K for stock and both T arms (stock 18.2 / 37.5 / 37.1; T arms the same). The other arms' worst families
   differ by window: default-1.10.0 `metrics` 22.7 at 128K, `gitlog` 43.2 at 252K, `cmake` 40.2 at 500K; G-0.85 `metrics` 22.7,
   `trace-python` 42.0, `cmake` 40.2; baseline-1.9.0 `metrics` 20.5, `pglog` 38.6, `maven` 39.4. At 1M `cmake` is 33.3 in every
   arm.
7. **8(a) misses the 85% bar everywhere.** Of the needed facts in an accepted result, the share the extract kept (one-sided 95%
   lower bound): no arm reaches 85 at any window. Baseline-1.9.0 is closest (lo 77.2 / 78.7 / 74.4 / 61.0 by window); default-1.10.0
   lo 61.7 / 74.4 / 69.0 / 50.0; G-0.85 lo 60.0 / 72.5 / 67.1 / 49.0; T-0 lo 77.6 / 72.4 / 61.1 / 52.2; T-0.7 lo 77.3 / 73.0 / 61.2 /
   51.8. Lower bounds by style (specific/vague) and language (en/zh/mixed), per arm × window:

   | arm | 128K | 252K | 500K | 1M (report-only) |
   |---|--|--|--|--|
   | baseline-1.9.0 | 82/60 · 84/64/50 | 83/65 · 78/73/75 | 75/67 · 74/69/70 | 57/55 · 45/61/50 |
   | default-1.10.0 | 60/59 · 61/60/47 | 76/67 · 75/71/69 | 69/66 · 68/66/66 | 46/52 · 37/53/43 |
   | G-0.85 | 59/54 · 60/57/42 | 75/62 · 73/70/67 | 67/64 · 67/63/63 | 45/50 · 37/53/36 |
   | T-0 | 80/69 · 77/76/72 | 74/66 · 74/68/67 | 59/59 · 58/57/60 | 47/53 · 38/57/43 |
   | T-0.7 | 79/70 · 75/76/74 | 74/68 · 73/70/66 | 58/61 · 59/55/59 | 46/58 · 38/56/45 |

   (Each cell: specific/vague · en/zh/mixed.) At 1M specific is the weak style for the every-step arms (default-1.10.0 lo 46 spec
   vs 52 vague; G-0.85 45 vs 50); for the T arms zh is the weak language at 500K (T-0 lo 57 zh vs 58 en; T-0.7 55 vs 59) while at
   1M English is the lowest language for every arm (37-45). Worst family by 8(a) point estimate (the report's per-family table;
   n = possible facts): 128K — baseline-1.9.0 `jest` 0.0 (lo 0.0; n 1), default-1.10.0 and G-0.85 `sql` 33.3 (lo 14.3; n 12),
   T arms `metrics` 37.5 (lo 33.3; n 16); 252K — baseline-1.9.0 `jest` 0.0 (n 1), default-1.10.0 `metrics` 40.0 (lo 33.3; n 35),
   G-0.85 `metrics` 38.2 (lo 32.0; n 34), T arms `metrics` 37.0 (lo 28.6; n 27); 500K — baseline-1.9.0 `jest` 0.0 (n 3),
   default-1.10.0 `metrics` 30.4 (lo 21.7; n 46), G-0.85 `metrics` 28.9 (lo 21.4; n 45), T-0 `metrics` 19.2 (lo 8.7; n 26),
   T-0.7 `metrics` 18.5 (lo 8.3; n 27); 1M — baseline-1.9.0 `jest` 0.0 (n 2), every other arm `cargo` 0.0 (n 5-7). At 1M each
   family has only 3 scenarios.
8. **The 1.9.0-era plugin is nearly inert on validation.** Weighted D vs stock, validation: 0.00 at 128K (it shortened nothing there
   — every validation family keeps exactly stock's facts), +0.04 at 252K and 500K, 0.00 at 1M; on dev it is +1.26 / +3.41 / +2.68 /
   +0.84. On validation its pass outcomes are: 128K — applied 0 (below_activation 1,329, no_candidates 1,017, not_worth_it 272,
   not_confident 133); 252K — applied 4 (below_activation 3,763, not_worth_it 1,167, no_candidates 224, not_confident 132);
   500K — applied 5 (below_activation 8,221, not_worth_it 2,668, no_candidates 177, not_confident 92); 1M — applied 1
   (below_activation 4,475, not_worth_it 1,605, not_confident 1). The 1.10.0 every-step arms still cost more on validation (+0.5
   to +5.2 vs stock).
9. **1M (report-only, 60 of 220 scenarios)** reads like 500K but smaller: every-step arms +1.5-1.6 points over stock and +1.0-1.1 over
   1.9.0 (upper bounds +1.6 to +2.5); T arms identical to stock (weighted D 0.00, upper bound 0.00); facts kept +1.8-2.0 vs stock for
   the every-step arms; the crossing rule is met in both splits.
10. **Run-log gap (runner only, not a product bug).** 11 of the 16 1M shard logs (`run1m/log-k.txt`) have no `exit` line because the
    controlling session ended while they ran. The rows are verified complete instead of trusting the logs: every shard printed its
    final `wrote N rows` line (total 360), every row parses, keys (scenario, arm, window) are unique, the 60 scenario ids equal the
    subsample file's `ids`, all 16 per-shard `rows-k.jsonl.subsample.json` files are byte-identical, and every family is a dev or
    validation family of the corpus deal. The 128K-500K run (16 shards, `wrote` total 3,960) has all `exit 0` lines.

## Not verified

- No model answered anything: facts are line presence in the final prompt, and the compaction summary is the replay's fixed
  2,000-token stand-in that keeps no facts (the same in every arm). Costs are miss-units under dated price profiles, not dollars.
- Pricing assumptions, sensitivities only: DeepSeek's prefix unit is assumed 64 tokens; TTL expiry uses the logged synthetic idle-gap
  distribution; a profile with no output price (generic OpenAI) prices output at o = 5.
- 8(a) is measured on the replay's accepted extracts; the report shows it by style, language and family — including each arm's
  worst family — which is not the same partition as the gate's.
- The 1M window is a 60-scenario stratified subsample, report-only and ungated; its intervals are wider (60 clusters) and it says
  nothing about the 160 un-sampled scenarios.
- 11 of the 16 1M shard logs lack an `exit` line (finding 10); completeness was verified from the rows, not the logs.

## What P3 must fix first (facts only; nothing was tuned here)

The largest measured gaps: (a) the every-step default costs +5-8 points over stock at 252K/500K (+2 at 128K); under
deepseek-v4-pro its per-session miss-units vs stock change by read −0.2 / 0.0 / +4.2 / +21.1 and write +5.7 / +55.4 / +103.6 /
+76.3 thousand at 128K / 252K / 500K / 1M — mostly write, because the prompt cache is rewritten from each shortened row onward —
and +3-6 points over the 1.9.0-era plugin, so no tried arm meets the primary endpoint at every gated window; (b) the cheapest
arms (T-0, T-0.7) do meet the ≤ +1.0 bound vs 1.9.0 but are ≈ stock (they skip almost everything with `would_leave_cuts`),
leaving a vs-stock upper bound at 500K of +0.003-0.004 and for T-0.7 +0.06 at 128K; (c) 8(a)'s lower bound is below 85% for every
arm at every window (best 78.7, baseline-1.9.0 at 252K); (d) the 1.9.0-era plugin's weighted D vs stock is 0.00-0.04 on
validation vs +0.84 to +3.41 on dev, and the every-step arms' increase over stock is smaller on validation than on dev
(default-1.10.0 +0.53 to +5.22 on validation vs +1.75 to +9.61 on dev; G-0.85 +0.21 to +4.34 vs +1.50 to +8.91).

## Tables

Generated by
`node scripts/replay.ts --corpus-report dev/replay-corpus-round2/rows-128k-252k-500k.jsonl dev/replay-corpus-round2/rows-1m-subsample.jsonl --json docs/results/replay-corpus-round2.json`
(the full tables are in `dev/replay-corpus-round2/report.md`, ignored). Windows 128K / 252K / 500K are gated (220 clusters); 1M is
report-only (60 clusters, stratified subsample).

### Weighted D vs stock, dev+validation (pooled %, 95% CI; one-sided 95% upper bound)

| arm | 128K | 252K | 500K | 1M (report-only) |
|---|--|--|--|--|
| baseline-1.9.0 | +0.75 [+0.37, +1.19] (ub +1.11) | +2.07 [+1.28, +2.93] (ub +2.79) | +1.63 [+0.99, +2.33] (ub +2.21) | +0.51 [+0.02, +1.20] (ub +1.07) |
| default-1.10.0 | +2.21 [+1.43, +3.11] (ub +2.95) | +7.85 [+6.57, +9.18] (ub +8.96) | +5.33 [+4.33, +6.38] (ub +6.19) | +1.63 [+0.81, +2.68] (ub +2.49) |
| G-0.85 | +1.64 [+1.01, +2.38] (ub +2.24) | +7.09 [+5.80, +8.42] (ub +8.16) | +4.93 [+3.90, +5.97] (ub +5.79) | +1.47 [+0.70, +2.44] (ub +2.27) |
| T-0 | -0.17 [-0.38, 0.00] (ub -0.03) | -0.01 [-0.02, 0.00] (ub -0.004) | 0.00 [-0.01, 0.00] (ub +0.003) | 0.00 [0.00, 0.00] (ub 0.00) |
| T-0.7 | -0.03 [-0.13, +0.09] (ub +0.06) | -0.01 [-0.02, -0.01] (ub -0.01) | 0.00 [-0.01, +0.01] (ub +0.004) | 0.00 [0.00, 0.00] (ub 0.00) |

### Weighted D vs the 1.9.0-era plugin, dev+validation (pooled %, 95% CI; one-sided 95% upper bound)

| arm | 128K | 252K | 500K | 1M (report-only) |
|---|--|--|--|--|
| default-1.10.0 | +1.45 [+0.85, +2.13] (ub +2.02) | +5.66 [+4.45, +6.92] (ub +6.71) | +3.65 [+2.72, +4.61] (ub +4.44) | +1.12 [+0.49, +1.88] (ub +1.74) |
| G-0.85 | +0.88 [+0.43, +1.42] (ub +1.32) | +4.92 [+3.73, +6.15] (ub +5.96) | +3.24 [+2.26, +4.26] (ub +4.09) | +0.96 [+0.38, +1.68] (ub +1.55) |
| T-0 | -0.92 [-1.39, -0.49] (ub -0.55) | -2.03 [-2.85, -1.27] (ub -1.39) | -1.60 [-2.27, -0.98] (ub -1.08) | -0.51 [-1.19, -0.02] (ub -0.06) |
| T-0.7 | -0.78 [-1.24, -0.37] (ub -0.43) | -2.03 [-2.85, -1.28] (ub -1.40) | -1.60 [-2.27, -0.98] (ub -1.07) | -0.51 [-1.19, -0.02] (ub -0.06) |

### Weighted D vs stock by split (point [95% CI]; dev / validation)

| arm | 128K | 252K | 500K | 1M (report-only) |
|---|--|--|--|--|
| baseline-1.9.0 | +1.26 [+0.63, +1.99] / 0.00 [0.00, 0.00] | +3.41 [+2.22, +4.80] / +0.04 [-0.03, +0.13] | +2.68 [+1.68, +3.82] / +0.04 [-0.05, +0.13] | +0.84 [+0.07, +1.98] / 0.00 [0.00, 0.00] |
| default-1.10.0 | +3.35 [+2.10, +4.71] / +0.53 [+0.09, +1.09] | +9.61 [+7.91, +11.42] / +5.22 [+3.51, +7.05] | +6.89 [+5.50, +8.36] / +2.99 [+1.83, +4.30] | +1.75 [+0.74, +3.12] / +1.45 [+0.25, +3.15] |
| G-0.85 | +2.60 [+1.51, +3.78] / +0.21 [0.00, +0.54] | +8.91 [+7.17, +10.77] / +4.34 [+2.76, +6.08] | +6.61 [+5.10, +8.18] / +2.39 [+1.39, +3.44] | +1.50 [+0.61, +2.70] / +1.43 [+0.25, +3.09] |
| T-0 | -0.33 [-0.63, -0.10] / +0.06 [-0.13, +0.30] | -0.01 [-0.02, 0.00] / -0.01 [-0.02, 0.00] | 0.00 [-0.01, +0.01] / 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] / 0.00 [0.00, 0.00] |
| T-0.7 | -0.10 [-0.21, +0.02] / +0.07 [-0.11, +0.29] | -0.01 [-0.01, 0.00] / -0.02 [-0.04, 0.00] | 0.00 [-0.01, +0.01] / 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] / 0.00 [0.00, 0.00] |

### Facts kept % (line check, dev+validation) and change vs stock / vs 1.9.0 in points

| arm | 128K | 252K | 500K | 1M (report-only) |
|---|--|--|--|--|
| stock | 37.5 | 45.9 | 45.6 | 46.5 |
| baseline-1.9.0 | 38.3 (+0.8 [0.0, +1.8]) | 49.5 (+3.6 [+2.2, +5.1]) | 47.7 (+2.1 [+0.9, +3.4]) | 47.0 (+0.5 [0.0, +1.3]) |
| default-1.10.0 | 39.3 (+1.8 [+0.7, +3.1] / +1.0 [+0.3, +1.8]) | 54.8 (+8.9 [+6.8, +11.1] / +5.3 [+3.6, +7.2]) | 52.3 (+6.7 [+4.8, +8.7] / +4.6 [+3.0, +6.3]) | 48.4 (+2.0 [+0.3, +4.0] / +1.5 [-0.1, +3.2]) |
| G-0.85 | 39.2 (+1.7 [+0.7, +3.0] / +0.9 [+0.3, +1.6]) | 52.7 (+6.8 [+4.8, +8.7] / +3.2 [+1.3, +5.1]) | 50.6 (+5.0 [+3.3, +6.8] / +2.9 [+1.2, +4.7]) | 48.2 (+1.8 [+0.3, +3.3] / +1.3 [-0.1, +2.9]) |
| T-0 | 39.7 (+2.2 [+1.1, +3.3] / +1.4 [0.0, +2.7]) | 46.1 (+0.2 [0.0, +0.4] / -3.4 [-5.0, -2.0]) | 45.7 (0.0 [0.0, +0.1] / -2.0 [-3.4, -0.9]) | 46.5 (0.0 [0.0, 0.0] / -0.5 [-1.3, 0.0]) |
| T-0.7 | 39.3 (+1.8 [+0.8, +3.0] / +1.0 [-0.3, +2.5]) | 46.0 (+0.1 [-0.1, +0.3] / -3.5 [-5.1, -2.2]) | 45.6 (0.0 [0.0, 0.0] / -2.1 [-3.5, -0.9]) | 46.5 (0.0 [0.0, 0.0] / -0.5 [-1.3, 0.0]) |

### Per-session counts (shortened / rewrites / compactions / accepted share)

| arm | 128K | 252K | 500K | 1M (report-only) |
|---|--|--|--|--|
| stock | 0.00 / 4.69 / 0.04 / n/a | 0.00 / 1.88 / 0.00 / n/a | 0.00 / 1.68 / 0.00 / n/a | 0.00 / 1.73 / 0.00 / n/a |
| baseline-1.9.0 | 0.23 / 4.72 / 0.03 / 18.8% | 2.65 / 2.20 / 0.00 / 19.7% | 3.51 / 2.16 / 0.00 / 20.2% | 1.78 / 2.07 / 0.00 / 21.0% |
| default-1.10.0 | 0.65 / 4.80 / 0.03 / 40.4% | 8.70 / 2.71 / 0.00 / 41.6% | 12.19 / 2.94 / 0.00 / 45.5% | 6.92 / 2.85 / 0.00 / 47.4% |
| G-0.85 | 0.50 / 4.77 / 0.03 / 37.3% | 7.40 / 2.64 / 0.00 / 38.8% | 10.96 / 2.87 / 0.00 / 42.9% | 5.62 / 2.77 / 0.00 / 45.6% |
| T-0 | 0.64 / 4.67 / 0.03 / 47.1% | 0.08 / 1.88 / 0.00 / 49.1% | 0.02 / 1.68 / 0.00 / 57.9% | 0.02 / 1.73 / 0.00 / 54.5% |
| T-0.7 | 0.58 / 4.67 / 0.04 / 42.6% | 0.09 / 1.88 / 0.00 / 44.3% | 0.04 / 1.68 / 0.00 / 52.9% | 0.02 / 1.73 / 0.00 / 48.4% |

### 8(a): share of needed facts an accepted extract kept (mean %, one-sided 95% lower bound; all / vague)

| arm | 128K | 252K | 500K | 1M (report-only) |
|---|--|--|--|--|
| baseline-1.9.0 | 84.3 (lo 77.2) / 75.0 (lo 60.0) | 82.4 (lo 78.7) / 73.3 (lo 65.0) | 78.9 (lo 74.4) / 74.8 (lo 67.3) | 71.3 (lo 61.0) / 71.8 (lo 55.3) |
| default-1.10.0 | 67.0 (lo 61.7) / 68.4 (lo 58.8) | 77.3 (lo 74.4) / 72.7 (lo 67.1) | 72.4 (lo 69.0) / 72.1 (lo 66.4) | 57.8 (lo 50.0) / 69.6 (lo 51.6) |
| G-0.85 | 65.7 (lo 60.0) / 65.9 (lo 53.8) | 75.6 (lo 72.5) / 68.6 (lo 62.4) | 70.6 (lo 67.1) / 70.0 (lo 63.6) | 56.7 (lo 49.0) / 67.4 (lo 50.0) |
| T-0 | 80.8 (lo 77.6) / 75.4 (lo 68.8) | 75.5 (lo 72.4) / 72.5 (lo 66.3) | 65.4 (lo 61.1) / 67.1 (lo 58.7) | 60.4 (lo 52.2) / 70.0 (lo 52.8) |
| T-0.7 | 80.6 (lo 77.3) / 76.1 (lo 69.6) | 76.1 (lo 73.0) / 74.0 (lo 68.0) | 65.7 (lo 61.2) / 70.1 (lo 61.5) | 60.4 (lo 51.8) / 75.8 (lo 58.1) |

### Pass outcomes (steps summed over sessions; `applied` = an extract was written)

| window | arm | outcomes |
|---|---|---|
| 128K | baseline-1.9.0 | below_activation 3304, no_candidates 2337, not_worth_it 944, not_confident 266, applied 21 |
| 128K | default-1.10.0 | below_activation 3297, not_worth_it 1748, no_candidates 1725, applied 55, not_confident 47 |
| 128K | G-0.85 | below_activation 3308, no_candidates 1746, not_worth_it 1695, not_confident 80, applied 43 |
| 128K | T-0 | below_activation 5803, no_candidates 500, would_leave_cuts 470, applied 98, not_confident 1 |
| 128K | T-0.7 | below_activation 5804, no_candidates 482, would_leave_cuts 397, not_confident 96, applied 93 |
| 252K | baseline-1.9.0 | below_activation 9545, not_worth_it 3135, no_candidates 359, not_confident 185, applied 102 |
| 252K | default-1.10.0 | below_activation 9513, not_worth_it 3404, applied 270, no_candidates 125, not_confident 14 |
| 252K | G-0.85 | below_activation 9471, not_worth_it 3465, applied 241, no_candidates 130, not_confident 19 |
| 252K | T-0 | below_activation 12912, would_leave_cuts 320, no_candidates 81, applied 13 |
| 252K | T-0.7 | below_activation 12912, would_leave_cuts 296, no_candidates 77, not_confident 25, applied 16 |
| 500K | baseline-1.9.0 | below_activation 20685, not_worth_it 6935, no_candidates 271, applied 126, not_confident 113 |
| 500K | default-1.10.0 | below_activation 20922, not_worth_it 6823, applied 342, no_candidates 43 |
| 500K | G-0.85 | below_activation 20907, not_worth_it 6833, applied 317, no_candidates 65, not_confident 8 |
| 500K | T-0 | below_activation 27761, would_leave_cuts 291, no_candidates 73, applied 5 |
| 500K | T-0.7 | below_activation 27761, would_leave_cuts 272, no_candidates 62, not_confident 28, applied 7 |
| 1M | baseline-1.9.0 | below_activation 11507, not_worth_it 4080, no_candidates 25, applied 23, not_confident 3 |
| 1M | default-1.10.0 | below_activation 11488, not_worth_it 4074, applied 76 |
| 1M | G-0.85 | below_activation 11453, not_worth_it 4115, applied 70 |
| 1M | T-0 | below_activation 15534, would_leave_cuts 84, no_candidates 19, applied 1 |
| 1M | T-0.7 | below_activation 15534, would_leave_cuts 78, no_candidates 14, not_confident 11, applied 1 |

### Cost split under deepseek-v4-pro, mean per session in thousand miss-units (read / write / output)

| arm | 128K | 252K | 500K | 1M (report-only) |
|---|--|--|--|--|
| stock | 34.4 / 187.2 / 0.2 | 193.0 / 415.4 / 0.0 | 913.2 / 881.9 / 0.0 | 3780.7 / 1798.4 / 0.0 |
| baseline-1.9.0 | 34.3 / 189.2 / 0.2 | 192.5 / 430.6 / 0.0 | 915.3 / 912.9 / 0.0 | 3786.1 / 1821.0 / 0.0 |
| default-1.10.0 | 34.2 / 192.9 / 0.2 | 193.0 / 470.8 / 0.0 | 917.4 / 985.5 / 0.0 | 3801.8 / 1874.7 / 0.0 |
| G-0.85 | 34.2 / 191.4 / 0.2 | 193.1 / 464.6 / 0.0 | 917.0 / 976.3 / 0.0 | 3803.8 / 1860.7 / 0.0 |
| T-0 | 34.3 / 187.0 / 0.2 | 192.9 / 415.4 / 0.0 | 913.2 / 881.9 / 0.0 | 3780.6 / 1798.4 / 0.0 |
| T-0.7 | 34.3 / 187.3 / 0.2 | 192.9 / 415.4 / 0.0 | 913.2 / 881.9 / 0.0 | 3780.6 / 1798.4 / 0.0 |

### Wall time per run (seconds: mean / median / max; sum in CPU-process minutes)

| arm | 128K | 252K | 500K | 1M (report-only) |
|---|--|--|--|--|
| stock | 0.4 / 0.3 / 1.2 (1.3) | 0.6 / 0.5 / 1.9 (2.2) | 1.9 / 1.2 / 6.8 (6.9) | 3.1 / 3.0 / 7.4 (3.1) |
| baseline-1.9.0 | 2.4 / 1.9 / 11.1 (8.6) | 14.5 / 11.8 / 70.1 (53.3) | 42.7 / 32.8 / 246.1 (156.4) | 55.2 / 33.4 / 279.4 (55.2) |
| default-1.10.0 | 2.8 / 2.2 / 14.0 (10.2) | 26.3 / 18.8 / 108.0 (96.5) | 90.2 / 74.2 / 298.1 (330.9) | 138.7 / 136.0 / 394.5 (138.7) |
| G-0.85 | 2.8 / 2.2 / 11.9 (10.4) | 26.4 / 19.2 / 109.0 (96.8) | 86.5 / 73.5 / 317.3 (317.1) | 152.4 / 142.9 / 428.5 (152.4) |
| T-0 | 6.4 / 5.1 / 19.4 (23.4) | 9.1 / 8.4 / 16.2 (33.5) | 11.4 / 11.0 / 24.4 (41.8) | 11.2 / 11.2 / 17.7 (11.2) |
| T-0.7 | 6.2 / 5.0 / 19.1 (22.8) | 9.0 / 8.7 / 17.2 (33.0) | 11.4 / 10.8 / 27.3 (41.8) | 11.0 / 10.4 / 19.0 (11.0) |
