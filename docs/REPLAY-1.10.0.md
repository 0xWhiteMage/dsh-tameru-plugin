# Whole-session replay for plugin 0.2.0 on engine 1.10.0 (replay only)

## Round 2 (2026-11-19): a defect fix, 19 more settings, one frozen

**Short answer.** Round 1 froze nothing. Round 2 found and fixed a defect in policy T, tried 19 new settings declared beforehand (26 tried in all; the declaration is in the engine's `docs/ANALYSIS-PLAN-1.10.md`, section "DeepSeek tuning round 2 (declared before running)", hashed before any grid run), and the pre-registered rule froze **policy `at-trigger` with no confidence gate (arm T-0)**: development (36 scenarios) cost -2.0% vs the 1.9.0-era plugin [-2.8, -1.3] (one-sided upper bound -1.4, margin +1.0), facts kept +10.7 points [+5.4, +16.9] (lower bound +6.1); validation (24 scenarios) cost -1.4% [-2.3, -0.6] (upper -0.7), facts kept +5.4 points [+1.3, +10.8] (lower +1.7). It is the shipped default now (`docs/FROZEN-1.10.0-SETTINGS.md`, setting hash `a8b37679de4825f3f45b58d79105ead58cb3b4acb758c87ceb3c23051e1ed92b`). **Replay only: no real model ran, the facts "kept" are present in the prompt, nobody checked that a model would use them, and the holdout has not been looked at (`holdout_looks.json` is `[]`).** The cost gain is mostly at 128K (-4.0% on development); at 200K the stock pruner almost never fires in these sessions, so T-0 is -0.1% there.

### Why T cost +7% to +11% at 200K in round 1: a defect, not a setting

Traced on `legacy-20` at 200K: stock reaches the trigger once (130K tokens) and its pruner cuts 25 results, leaving 40K, so the next trigger is 20 steps away. Policy T replaced only 10 of the 25 results (the others were declined: extract longer than the stock cut, or not accepted) and that already brought the prompt to 87K, below the trigger, so **the stock pruner did not run and the 15 declined results stayed in full**. The prompt was back at the trigger seven steps later and again a step after that (three triggers, three cache rewrites, +13% cost). At 128K the trigger is at 54K tokens, so the cut rewrites little and the effect was masked. The policy's documented contract was "a declined result gets the stock cut as it would have"; that did not hold when the replacements alone brought the prompt under the trigger. **Fix (a bug fix, shipped with the freeze): T and H write only if the stock pruner will still run afterwards (the projected prompt is at or above the trigger) or no result it would cut is left; otherwise the pass is skipped (`would_leave_cuts`) and the stock cut happens in full.** It is in `src/host/shorten.ts`; the code change was stated in the plan before the grid ran. After it, T gate 0 costs -0.1% at 200K and -4.0% at 128K on development.

### Settings and arithmetic

A prune at position p makes the provider rewrite everything from p to the end; it pays back only if freed/suffix >= (write - read)/(read x remaining requests) = 9/n at the primary price (share 0.35 is about 26 remaining requests, 0.5 about 18, 0.65 about 14). Acting later, or where the pruner or a compaction rewrites the prompt anyway, makes that rewrite shared. The grid follows that, not the generator: G (every-step) at gate 0.85 with share {0.35, 0.5, 0.65}, activation {0.75, 0.9, 1.0}, minimum size {6000, 12000}, protectRecent {4, 8}, maxPerPass {24, 8}, and gate 0.7 for two; T at gate 0.85; and H (hybrid: only at the trigger step; an item the pruner would cut is replaced only if its extract is smaller than the cut, no pay-back test; an item beyond the cut keeps the share rule unless it lies after the first replaced cut) at gates 0.85 and 0.7, shares 0.35, 0.5 and 0.65, and protectRecent 8. Round 1's seven settings were candidates too (T gates 0 and 0.7 re-run on the fixed code; the G rows are unchanged code and were reused).

### Development and validation, the best five by facts kept inside both margins on development

| setting | dev cost vs 1.9.0 (upper 1-sided) | dev facts (lower) | validation cost (upper) | validation facts (lower) |
|---|--|--|--|--|
| **T-0** (frozen) | -2.0% (-1.4) | +10.7 (+6.1) | -1.4% (-0.7) | +5.4 (+1.7) |
| G12 (every-step, gate 0.7, share 0.5, act 0.9) | +0.6% (+0.9) | +8.4 (+5.0) | 0.0% (+0.4) | +3.8 (+1.3) |
| G2 (gate 0.85, share 0.5, act 0.75) | -0.1% (0.0) | +4.0 (+0.8) | +0.1% (+0.5) | +3.6 (+0.4) |
| T-0.7 | -0.8% (-0.5) | +3.7 (+1.9) | -0.4% (-0.1) | +1.7 (+0.4) |
| T3 (gate 0.85) | -0.4% (-0.2) | +2.3 (+0.9) | -0.4% (-0.2) | +1.7 (+0.4) |

Chosen on development per policy: G12, T-0, H5 (H1 to H5 lose at most 0.3 points of facts against the 1.9.0-era plugin, so H adds nothing). Validation compared these three by the same rule; the winner is T-0. Everything else is in `docs/results/replay-1.10.0-report.md` (every arm, both splits, 36 and 24 clusters, window split and the 1.25 write price: no sign flip for the frozen setting). Rows: `replay-1.10.0-rows.jsonl` (3,360 = 28 arms x 120), selection `replay-1.10.0-selection.json`; round 1 is kept as `replay-1.10.0-round1-*` (its T rows were produced by the code before the fix).

What the grid shows: the G settings with a later activation, a larger share or a larger minimum size are cost-neutral because they do almost nothing (they shorten zero to 0.4 results per session on development, against 7.2 for the shipped round 1 setting); the ones that do act (G1, G12) cost more or equal; the way to keep more facts at no extra cost was to act where the cut already rewrites the prompt. H does nothing here because at the trigger the extracts T already takes cover what H adds. The frozen setting's quality gates on these sets: accepted extracts keep their facts on 97.8% (cluster lower bound 93.6%) on development and 94.9% (lower 86.4%) on validation, above the 85% bar; second rewrites 0. The confidence is not checked (gate 0) because the cut being replaced has no check either, which also means the panel's strength menu does not describe the unset default (its Less, Normal and More set a gate of 0.85, 0.7 and 0.55 for T).

**Not shown:** whether a real model answers better with these extracts than with the stock cut; sessions longer than 60 steps; any real provider's cache; the fresh holdout (the single look is still unspent).

The sections below are round 1 as written (its "nothing frozen" conclusion and the T cost at 200K are superseded by the fix above).

**Short answer.** Neither candidate policy meets the pre-registered margins, so **nothing is frozen and the shipped default stays** (policy `every-step`, confidence floor 0.7). Both policies keep clearly more required facts than the 1.9.0-era plugin, which on these sessions never shortened anything (cost identical to stock in all 120 runs), but both cost more than stock: the cheapest of the seven settings, gate 0.85 under the every-step policy, costs +1.4% on development (one-sided upper bound +2.1) against a margin of +1.0. The trigger policy keeps far more facts (+46 points) and is close to cost-neutral at the 128K window, but costs +7% to +11% at 200K. **No real model ran: every number here is a simulation of cache pricing and of a model that only issues tool calls. It supports no claim about answer quality, the provider's cache behaviour or a bill.**

Files: rows `docs/results/replay-1.10.0-rows.jsonl` (1,080 rows, shared format), full tables `docs/results/replay-1.10.0-report.md`, selection `docs/results/replay-1.10.0-selection.json`. The procedure, margins and the seven settings were registered before the runs in the engine's `docs/ANALYSIS-PLAN-1.10.md` (section "the DeepSeek fresh holdout is registered"), together with the holdout hash.

## What was run

`scripts/replay.ts` (with `scripts/replay/`), 60 development scenarios x 2 windows (128K, 200K) x 9 arms = 1,080 runs, split 36 development / 24 validation scenarios (60/40 within each family by a hash of the scenario id). The holdout was **not** run (see below).

- **Real:** the Harness's session log, token meter and tool-result pruner (0.2.2-rc.5 packages in `dev/harness`), this plugin's own step pass (`onPreStep`), and the vendored engine 1.10.0 through the real worker (`vendor/run_worker.py`, protocol 2, `decide()` in the worker). The baseline arm uses the 1.9.0-era worker and engine (`git archive 922d171 vendor`, protocol 1) through the current host code, which gives it the old rule through `legacyDecision`: gate 0.7, the host's own query, no redaction.
- **Simulated:** the model (it only issues tool calls) and the summary compaction (a fixed 2,000-token summary that keeps no facts, the same in every arm).
- **Cost:** input-token equivalents; each request pays `read` for the prefix identical to the previous request's and `write` for the rest; a compaction also pays to replay its span and 4x its summary. Primary price read 0.1 / write 1.0 (DeepSeek-like); read 0.1 / write 1.25 as the sensitivity. **These prices are assumptions from public pricing, not read from a provider.**
- **Statistics:** rows in the shared jsonl shape (`bench, engine, split, scenario, cluster, arm, window, seed, cost, facts_held, shortened, compactions, rewrites, ...`); paired differences matched on scenario, window and seed; a seeded cluster bootstrap by scenario (2,000 draws, seed 20261118), not by seed. Two-sided 95% intervals are shown; margins use the one-sided 95% bound. The number of clusters is printed in every table. `rewrites` is the number of requests whose prompt no longer began with everything the previous request had sent. The arm-against-itself check returns exactly 0 on every metric (mean and all four bounds) for every arm; it is a test (`test/replay-stats.test.ts`) and `node scripts/replay.ts --selfcheck`. A rerun of 36 rows reproduced them field for field (apart from the timing column).

### Scenario families

| Set | Families | Scenarios | Clusters |
|---|---|--:|--:|
| development | `legacy` (the original generator, 40 seeds, query style alternating), `gradle` (English), `ansible` (Chinese user messages) | 36 | 36 |
| validation | the same three families | 24 | 24 |
| **fresh holdout (not run)** | `pytest-zh`, `maven-en`, `kubectl-zh`, `sql-en`, `jest-en`, `gotest-zh`, `cargo-en`, `metrics-zh` (other filler, tools, fact formats, value shapes; 24 scenarios have Chinese user messages and Chinese output lines) | 48 | 48 |

Holdout hash (sha256 over the canonical text of all 48 scenarios): `ac9e77dd723d3755b8238c4a1e60d6947e798ddcc0ee489e9d2c10f2b5ca1489`, committed in `test/fixtures/replay/HOLDOUT.sha256` and registered in the engine's analysis plan. The normal runner cannot read it: `--split holdout` is refused, `--holdout` needs `docs/FROZEN-1.10.0-SETTINGS.md` (round 2 created it) and a matching hash, and every look is appended to `test/fixtures/replay/holdout_looks.json` (date, plugin commit, engine commit, setting hash) before it starts. `holdout_looks.json` is `[]`.

### The two policies and the seven settings (declared before the runs)

- **G, `policy: every-step`** (the shipped structure): at each step once the chat is 0.75 of the way to the Harness's trigger, old read results (not the newest four, not unread ones) of 6,000 characters or more, accepted by the engine's `decide()` at the confidence floor, written only if the batch frees at least 0.35 of what it makes the provider rewrite. Gates 0.5, 0.6, 0.7, 0.8, 0.85 (5 settings). Gates 0.8 and 0.85 gave identical results: the engine's confidence takes no value between them on these outputs, so there are effectively four distinct G settings.
- **T, `policy: at-trigger`** (opt-in, new): acts only at a step where the prompt is at the Harness's own trigger, i.e. where its pruner is about to cut. Every result that pruner would cut is eligible (above 8,192 characters, **the unread newest included**, nothing protected), the 0.35 pay-back rule does not apply (the cut rewrites the prompt from the same place), and an extract longer than the stock cut would leave (4,096 + marker + 1,024 characters) is declined so the stock cut happens as it would have. If replacing brings the prompt under the trigger the Harness's pruner does not run, as in the real Harness. Gates 0 and 0.7 (2 settings): 0 because the cut it replaces has no confidence check at all.
- **Settings tried: 7.** The 1.9.0-era plugin and the stock Harness are references, not tried settings.

## Results

Cost and facts are paired against stock on the same scenario and window. "Facts kept" is the share of the needed values still in the prompt at the end of the session (the replay's compaction summary keeps none, so stock holds few). Intervals are two-sided 95%, cluster bootstrap by scenario. In every cell the 1.9.0-era plugin is identical to stock, so "vs stock" and "vs 1.9.0" are the same numbers here.

### Development (36 scenarios, 72 runs per arm)

| arm | cost vs stock | facts kept | facts vs stock (pts) | shortened / session | rewrites / session | compactions / session | accepted share of results asked about |
|---|--|--:|--|--:|--:|--:|--:|
| stock | | 30.7% | | 0 | 4.6 | 0.5 | |
| 1.9.0-era plugin (gate 0.7) | +0.0% [0.0, 0.0] | 30.7% | 0.0 | 0.0 | 4.6 | 0.5 | 3.9% |
| G, gate 0.5 | +3.8% [+2.5, +5.2] | 50.3% | +18.5 [+11.7, +25.5] | 8.4 | 5.3 | 0.4 | 45.0% |
| G, gate 0.6 | +4.1% [+2.8, +5.5] | 50.0% | +18.2 [+11.3, +25.1] | 8.2 | 5.4 | 0.4 | 43.6% |
| G, gate 0.7 | +3.6% [+2.3, +4.9] | 47.6% | +16.0 [+9.7, +22.7] | 7.2 | 5.3 | 0.5 | 41.7% |
| G, gate 0.8 (= 0.85) | +1.4% [+0.7, +2.2] | 39.3% | +8.2 [+3.9, +12.7] | 2.9 | 4.9 | 0.5 | 24.3% |
| T, gate 0 | +2.5% [-0.5, +5.3] | 79.5% | +46.3 [+32.0, +58.2] | 19.2 | 5.0 | 0.1 | 52.0% |
| T, gate 0.7 | +7.9% [+6.5, +9.4] | 80.1% | +46.9 [+33.2, +58.7] | 16.1 | 5.5 | 0.1 | 42.0% |

### Validation (24 scenarios, 48 runs per arm; every 1.10.0 arm shown for information, selection used development only)

| arm | cost vs stock | facts kept | facts vs stock (pts) | shortened / session | rewrites / session | compactions / session | accepted share |
|---|--|--:|--|--:|--:|--:|--:|
| stock | | 30.9% | | 0 | 4.5 | 0.5 | |
| 1.9.0-era plugin (gate 0.7) | +0.0% [0.0, 0.0] | 30.9% | 0.0 | 0.0 | 4.5 | 0.5 | 2.3% |
| G, gate 0.5 | +4.0% [+2.6, +5.3] | 44.5% | +13.6 [+5.7, +21.4] | 6.9 | 5.4 | 0.5 | 43.3% |
| G, gate 0.6 | +3.7% [+2.3, +5.0] | 44.5% | +13.6 [+5.7, +21.4] | 6.2 | 5.3 | 0.5 | 41.3% |
| G, gate 0.7 | +3.2% [+1.9, +4.6] | 43.2% | +12.4 [+5.0, +19.9] | 5.3 | 5.3 | 0.5 | 39.6% |
| G, gate 0.8 (= 0.85) | +1.5% [+0.4, +2.9] | 38.6% | +7.8 [+3.6, +12.4] | 2.4 | 4.9 | 0.5 | 23.3% |
| T, gate 0 | +5.6% [+1.7, +9.4] | 70.3% | +39.2 [+23.9, +53.7] | 18.3 | 5.3 | 0.1 | 48.3% |
| T, gate 0.7 | +9.4% [+7.3, +11.7] | 66.1% | +35.8 [+19.7, +51.1] | 15.2 | 5.9 | 0.1 | 39.4% |

The 1.9.0-era plugin was asked about 3,224 results over the 120 runs and its engine accepted 105 of them (3.3%); the 0.35 pay-back rule then wrote none of them, which is why it is cost-identical to stock. Engine 1.10.0's confidence accepts about ten times as many (G at gate 0.7: 41.7% on development), which is what moves the facts, and the cost.

### The pre-registered selection

A candidate is inside the margins when the one-sided 95% upper bound of its cost difference to the 1.9.0-era plugin is at most +1.0 point and the lower bound of its facts-kept difference is at least -1.0 point (the engine's analysis plan). On development:

| setting | cost upper bound (1-sided) | facts lower bound (1-sided) | inside |
|---|--:|--:|---|
| G 0.5 / 0.6 / 0.7 | +5.0 / +5.3 / +4.7 | +12.9 / +12.5 / +10.7 | no (cost) |
| G 0.8 and 0.85 | +2.1 | +4.7 | no (cost) |
| T 0 | +5.0 | +34.4 | no (cost) |
| T 0.7 | +9.2 | +35.5 | no (cost) |

**No setting is inside the cost margin on development, so neither policy has a chosen setting, validation compares nothing, and no winner is declared. `docs/FROZEN-1.10.0-SETTINGS.md` is not written.** The same holds on validation for every arm (best: G 0.8, upper bound +2.7). The settings-tried count (7) is logged in the engine's analysis plan.

### Cost by window and the 1.25 write price

| arm | development 128K | development 200K | validation 128K | validation 200K |
|---|--|--|--|--|
| G 0.7 | +2.3% [+1.2, +3.4] | +4.8% [+2.9, +6.9] | +2.5% [+1.2, +4.0] | +3.9% [+1.9, +6.1] |
| G 0.8 | +0.8% [+0.3, +1.4] | +2.1% [+1.0, +3.2] | +1.5% [+0.5, +2.9] | +1.5% [-0.1, +3.7] |
| T 0 | -2.2% [-4.7, +0.4] | +7.1% [+3.5, +10.8] | +0.4% [-3.0, +3.6] | +10.7% [+5.9, +15.7] |

With write 1.25 every mean keeps its sign (no sign flip anywhere; every figure is 0.1 to 1.2 points higher). The only change in what an interval excludes is G 0.8 at 200K on validation, whose interval moves from [-0.1, +3.7] to [+0.1, +4.4]. The T policy's cost depends on the window, not on the price: near neutral at 128K, clearly worse at 200K. (Round 1 did not test why; round 2 found a defect, see the section above, and the round 1 T rows in this table are from the code before that fix.) A likely cause (untested): after T replaces the results it can, the prompt falls below the trigger, the stock pruner does not run, and the results T left (declined, over the per-pass cap, or under the stock threshold) stay full instead of being cut, so the prompt stays near the trigger and rewrites the cache repeatedly. A rule that acts at 128K only was not among the seven settings and would be a new experiment on a new holdout.

### Gate 8, the parts that can be read on these sets

- **8(b), not inert.** G: the share of results asked about that were accepted is higher than under the 1.9.0-era plugin by +37.8 points [+32.1, +42.6] at gate 0.7 on development (one-sided lower bound +33.1; validation +37.3 [+31.0, +43.2], lower bound +32.0); the lower bound excludes zero at every gate. T: the extract replaced the stock cut at 71.3% of the steps where the pruner was about to cut, gate 0 (one-sided lower bound 65.1%; validation 69.2%, lower 64.0%), and replaced 29.0% of the individual cuts (lower 23.5%). Both policies pass the non-inert test as defined. The raw act count is report-only.
- **8(a), extracts keep their facts.** Required facts present in an accepted extract's original that its extract kept: development 98.3% to 98.6% for G (cluster one-sided lower bound at least 94.8%) and 97.7% for T gate 0 (lower 93.3%). On validation G 0.7 keeps 94.9% (lower 87.5%, above the 85% bar), but G 0.8 keeps 93.5% (lower 83.9%), T gate 0 91.8% (lower 81.5%) and T gate 0.7 92.2% (lower 82.6%), below it. Only a frozen setting is tested on the holdout; round 2 froze T gate 0, and 8(a) and 8(b) are read for it at the holdout look (on validation its 8(a) lower bound in this round 1 table, 81.5%, is under the 85% bar, so that part can fail there).
- **Second rewrites (gate 1):** 0 in all 1,080 runs.

## The holdout look (2026-11-19, one look at the frozen setting T-0; replay only)

48 scenarios in 8 families that share no filler, tool, fact format or generator with the development pool (24 with Chinese user messages), engine 1.10.0 (`df30e1f`),
plugin commit `7f70448`, setting hash `a8b37679...`. `test/fixtures/replay/holdout_looks.json` has **two** entries: the first run stopped at once because the 1.9.0-era baseline arm needs
`--baseline-vendor`, and read no result; the second is the look whose rows are in `docs/results/replay-1.10.0-holdout-rows.jsonl` (288 rows). Computed by
`scripts/replay/holdout_report.py` (output in `docs/results/replay-1.10.0-holdout-report.txt`), paired cluster bootstrap by scenario, 48 clusters.

| Quantity | Result | Margin | Met |
|---|---|---|---|
| Cost vs the 1.9.0-era plugin | -0.03% [-0.51, +0.44], one-sided upper +0.36 | upper <= +1.0 | yes |
| Cost vs stock | -1.27% [-1.83, -0.77], upper -0.85 (write 1.25: -1.40%, no sign flip) | reported | |
| Facts kept vs stock | +5.00 pts [+2.36, +7.92], lower +2.74 | reported | |
| **Facts kept vs the 1.9.0-era plugin** | **-0.50 pts [-2.68, +1.41], one-sided lower -2.27** | lower >= -1.0 | **no** |
| **8(a) accepted extracts keep their facts** | **90.2% [81.0, 97.4], one-sided lower 82.5** | point >= 90, lower >= 85 | **no (lower bound)** |
| 8(b) not inert: extract replaced the stock cut on trigger events | 22.9% [18.0, 28.0], lower 18.8 | lower bound above 0 | yes |
| Second rewrites of an item | 0 | 0 | yes |

Per family, cost and facts against the 1.9.0-era plugin are 0 or within 1.1% except `jest-en` (facts -10.0 points, cost +1.1%) and `cargo-en` (facts +6.0, cost -2.1%).
In this holdout the 1.9.0-era plugin held more facts than stock (51.8% against 46.2%), unlike on the development pool, so the new default is no better than it on facts.

**Gate 8 is not met**: the facts-kept margin against the 1.9.0-era plugin and the lower bound of 8(a) both fail, and the single look is spent. A further change of setting needs a new sealed holdout
registered before it is tuned. What the data supports: against stock, the default holds about 5 more facts per hundred at about 1.3% lower cost in this replay; against the previous
plugin it is cost-neutral with no demonstrated fact gain. No real model ran.

## What this does not show

- **Real model behaviour.** A fact "kept" is present in the prompt; whether a model uses it, or would have recovered it by reading the original back, is not measured (the replay model never reads originals).
- **Summaries that keep facts.** Real summaries keep some of what they cover, which would narrow the facts advantage in the stock arm.
- **Real outputs.** The sessions are synthetic: five to six one-line facts among routine filler, 40 to 60 steps. The needle lines are easy for a query-aware extractor; the holdout families use other formats but are generated by the same author, so they are not a sample of real work.
- **Prices and cache rules** beyond the two-price model (expiry, minimum cacheable length, per-provider prefix units).
- **The holdout.** It was registered and not run, so nothing here is confirmed on fresh scenarios. Development and validation were used to choose the frozen setting in round 2 (26 settings tried in all), which is why the one look at the holdout is kept for that setting.
- **No saving is claimed.** The round 2 default (policy `at-trigger`, no gate) is cheaper than the 1.9.0-era plugin in this replay, but the replay is synthetic, uses an assumed two-price cache and no real model ran.

## Reproducing

```
git archive 922d171 vendor | tar -x -C <scratch>/engine-1.9.0          # the 1.9.0-era worker and engine
node scripts/replay.ts --split dev+validation --baseline-vendor <scratch>/engine-1.9.0/vendor --out rows.jsonl   # 2 to 6 s per run, shardable with --shard k/n
node scripts/replay.ts --report rows.jsonl --selection selection.json
node scripts/replay.ts --selfcheck rows.jsonl
```
