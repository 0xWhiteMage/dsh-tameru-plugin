# Whole-session replay, re-priced under every dated price profile (round 2, P1b; replay only)

**Replay only.** No real model ran and no provider cache was probed. Every cost below comes from a simulated session priced with
the engine's dated price profiles (`src/tameru/prices.json` at engine commit `7a7bb83`; committed copy
[`results/prices-2026-11-19.json`](results/prices-2026-11-19.json), sha256 `070dcfa3...` pinned in `test/replay-pricing.test.ts`).
Until live billed probes land within 10% of these figures, no dollar or saving claim is made. "Facts kept" means present in the
prompt at the end of the session, not used by a model.

## Short answer

- **Re-pricing changes no sign under the DeepSeek plugin's registered profiles on the 60 development scenarios.** It makes every
  difference larger: whole-session cost is mostly cache *writes* (about 80% under DeepSeek pro), and DeepSeek reads are much cheaper
  than the old replay assumed (1/30 and 1/50 of a miss, against 0.1), so whatever causes extra rewrites costs more, and whatever
  avoids them saves more.
- **T-0 (at-trigger, no gate) vs the 1.9.0-era plugin, restated:** development −2.04% (legacy pricing, reproduced exactly) becomes
  **−2.77% [−3.73, −1.87] under DeepSeek pro and −3.11% [−4.20, −2.09] under DeepSeek flash**; validation −1.40% becomes
  **−2.00% [−3.23, −0.90] (pro) and −2.28% [−3.68, −1.02] (flash)** (128K + 200K, mean of per-scenario ratios as before; pooled
  figures in the report). Same sign, larger.
- **Sign changes exist only under sensitivities, and in one place on the burned round-1 set:** the Haiku 5.5 long-context tier
  (×5 above 100K) flips several 200K/252K results; and on the burned round-1 set at 252K, G-0.7 vs the 1.9.0-era plugin goes from
  −0.46% (legacy) to +1.62% (pro) / +2.45% (flash). Full list below.
- **The corrected baseline changes no development number:** the 1.9.0-era arm now states every-step, gate 0.7, activation 0.75,
  share 0.35. Before, it stated gate 0.7 only, and the other values came from the shipped defaults. Those defaults are the same
  values, so the 720 overlapping development rows are identical to the committed round-2 rows on cost, facts, shortenings,
  compactions, rewrites and acceptances.
- **T-0 does nothing at 200K and 252K:** across 218 trigger crossings it skipped 204 times with `would_leave_cuts` (the round-2
  defect fix) and applied an extract at only 4 steps. So at the gated 252K window T-0 equals stock on development data. The policy only helps
  at 128K here.

## What changed in the replay

1. **Each row records what pricing needs.** For each model request it logs the cached shared prefix (message-granular), the whole
   prompt and the idle gap before the request. For each compaction request it logs the context re-read, plus the summary's output
   tokens (2,000). Cost under any profile is then a pure function of the row (`scripts/replay/pricing.ts`), in miss-units: one
   uncached input token = 1, so cost = r · read + w · written + o · output.
   - **TTL:** a request after an idle gap longer than the TTL has its whole prefix written again. If a compaction request comes
     first in that step, it pays the rewrite.
   - **Prefix unit:** a request that diverges before the end of the previous prompt hits only whole units of the shared prefix.
     The unit is **64 tokens, assumed and unverified**; 1,024 is a sensitivity.
   - **Long-context tiers:** Haiku 5.5 pays ×5 on every price above 100K. The OpenAI tier (GPT-5.4 ×2 above 272K) applies to input
     only.
   - **Output:** generic OpenAI has no output price, so it is priced at o = 5 (an assumption, per the analysis plan).
   - **Self-check:** the legacy profile (read 0.1, write 1.0, output 4, no expiry, unit 1) reproduces the old `cost` field exactly
     (tested). `cost` and `cost_w125` stay in the rows for the sign-change comparison.
2. **Idle gaps are synthetic.** The simulated sessions have no clock, so each gap is generated from the scenario seed: 4 s plus an
   exponential with mean 20 s, and with probability 0.03 per step a log-uniform 2 min to 3 h away. That gives about 1.3 gaps over
   5 min and 0.3–0.5 over 1 h per session. Gaps depend only on scenario and step, never on the arm, so arms stay paired.
   **Profiles with a fixed TTL (Anthropic 5 min / 1 h, OpenAI 30 min / 12 h) therefore depend on an assumed gap distribution.**
   DeepSeek has no fixed TTL, so its primary is no expiry, with 5 min and 1 h as sensitivities.
3. **Baseline arm fixed:** the arm now carries explicit settings and runs on the 1.9.0 worker (`git archive 922d171 vendor`).
   - A test fails if any arm has empty settings. Stock now states `shorten: false`.
   - The 1.10.0 stable default runs as its own arm (`default-1.10.0`, stable channel, the settings table's numbers in full). It is
     row-for-row identical to G-0.7, and the ledger records it as the same setting.
4. **Settings-tried ledger enforced.** The runner refuses any non-reference arm whose `ledgerId` is not in the ledger. It reads the
   ledger from `REPLAY_LEDGER`, or falls back to the committed copy `results/settings-tried-ledger.json` (tested to be a prefix of
   the engine file). This re-pricing adds **no new setting**: every arm run is G-gate0.7, G-gate0.85, T-gate0 or T-gate0.7. The
   ledger is unchanged at 26.
5. **Burned round-1 holdout as development data.** `--split dev+validation+burned-r1` loads it through `loadBurnedAsDev()`, which
   refuses unless its hash is listed in `BURNED-HOLDOUTS.md`. It logs no look, leaves `holdout_looks.json` untouched (tested), and
   labels its rows `split: burned-r1`.
6. **Windows:** 252K is added because these scenarios reach its stock trigger (178,464 tokens). 200K is kept for continuity with
   round 1.

Arms: stock, baseline-1.9.0 (fixed), G-0.7, default-1.10.0, G-0.85, T-0, T-0.7. Data: 60 development scenarios (dev 36 +
validation 24) and the burned round-1 set (48), at 128K / 200K / 252K, giving 2,268 rows
([`results/replay-repriced-1.10.0-rows.jsonl`](results/replay-repriced-1.10.0-rows.jsonl); per-act records dropped to keep the file
small). Full report: [`results/replay-repriced-1.10.0-report.md`](results/replay-repriced-1.10.0-report.md); machine-readable:
[`results/replay-repriced-1.10.0.json`](results/replay-repriced-1.10.0.json).

## Integrity

**Arm vs itself is exactly zero** at every window and under every price config. That covers 4 registered profiles, 16 sensitivities
and the weighted D, in both groups and on every legacy metric, with mean and all four bounds equal to 0 (checked on the real rows by
`--reprice`, and in a test at 128K / 252K / 500K / 1M). Rows are paired on scenario, window and seed; intervals come from a cluster
bootstrap by scenario (10,000 draws for the weighted D, 2,000 per profile), and every table header names its cluster count.

## Trigger crossings (stock arm)

| group | window | crossed ≥1 | crossed ≥2 | crossings / session |
|---|--:|--:|--:|--:|
| dev+validation (60) | 128K | 100% | 100% | 8.8 |
| dev+validation (60) | 200K | 100% | 58% | 1.6 |
| dev+validation (60) | 252K | 72% | **0%** | 0.7 |
| burned-r1 (48) | 128K | 100% | 100% | 7.9 |
| burned-r1 (48) | 200K | 98% | 17% | 1.1 |
| burned-r1 (48) | 252K | **52%** | **0%** | 0.5 |

At 252K neither set meets the round-2 plan's trigger-crossing rule (≥70% cross once and ≥30% twice in every split), so **252K
cannot be gated with these scenarios**. Longer sessions are P2.

## Cost, pooled % (registered weighted D = 1/4 each of DeepSeek pro, DeepSeek flash, Anthropic Sonnet 5.5 5 min, OpenAI 30 min)

Each cell is the pooled difference D = 100 × (Σ arm − Σ reference) / Σ reference. The weighted column gives the 95% CI and, in
parentheses, the one-sided 95% upper bound.

### 60 development scenarios, vs the 1.9.0-era plugin (identical to "vs stock" here: the 1.9.0-era plugin shortens nothing on these families)

| arm | window | weighted D [95% CI] (upper) | pro | flash | sonnet 5m | openai 30m | opus 5m | haiku 5m | pro TTL 5 min | legacy |
|---|--:|--|--:|--:|--:|--:|--:|--:|--:|--:|
| G-0.7 (= default) | 128K | +2.93 [+1.86, +4.10] (+3.89) | +3.8 | +4.1 | +2.0 | +1.9 | +2.0 | +1.6 | +2.1 | +2.4 |
| G-0.7 (= default) | 200K | +7.93 [+5.79, +10.19] (+9.80) | +9.1 | +10.7 | +6.6 | +5.3 | +6.6 | −9.1 | +7.0 | +4.6 |
| G-0.7 (= default) | 252K | +6.38 [+4.68, +8.18] (+7.86) | +7.8 | +9.4 | +4.6 | +3.7 | +4.6 | +4.1 | +5.0 | +3.8 |
| G-0.85 | 128K | +1.38 [+0.69, +2.23] (+2.08) | +1.7 | +1.9 | +1.0 | +1.0 | +1.0 | +0.8 | +1.1 | +1.1 |
| G-0.85 | 200K | +3.40 [+1.92, +5.04] (+4.77) | +3.9 | +4.7 | +2.8 | +2.2 | +2.8 | −2.7 | +3.0 | +1.9 |
| G-0.85 | 252K | +4.57 [+2.88, +6.37] (+6.09) | +5.1 | +5.8 | +4.3 | +3.1 | +4.3 | +8.1 | +4.5 | +3.2 |
| T-0 | 128K | −4.45 [−5.85, −3.09] (−3.29) | −4.9 | −5.6 | −3.8 | −3.5 | −3.8 | −3.2 | −3.8 | −3.5 |
| T-0 | 200K | −0.19 [−0.47, 0.00] (0.00) | −0.2 | −0.2 | −0.2 | −0.2 | −0.2 | −0.1 | −0.2 | −0.1 |
| T-0 | 252K | 0.00 [0.00, 0.00] (0.00) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| T-0.7 | 128K | −2.15 [−3.04, −1.31] (−1.44) | −2.5 | −2.8 | −1.9 | −1.4 | −1.9 | −1.3 | −2.0 | −1.3 |
| T-0.7 | 200K / 252K | 0.00 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |

### Burned round-1 set (48, development data)

| arm | window | vs stock: weighted D (upper) | vs 1.9.0: weighted D [95% CI] (upper) | vs 1.9.0: pro / flash | vs 1.9.0: legacy |
|---|--:|--|--|--|--:|
| baseline-1.9.0 | 128K | +2.80 (+3.99) | reference | | |
| baseline-1.9.0 | 200K | +3.45 (+5.42) | reference | | |
| baseline-1.9.0 | 252K | +4.02 (+5.65) | reference | | |
| G-0.7 | 128K | +6.57 (+8.49) | +3.66 [+1.86, +5.71] (+5.37) | +4.4 / +4.8 | +2.2 |
| G-0.7 | 200K | +5.90 (+8.40) | +2.35 [−0.62, +5.17] (+4.69) | +3.0 / +3.9 | +0.5 |
| G-0.7 | 252K | +4.81 (+6.78) | +0.74 [−1.07, +2.52] (+2.20) | **+1.6 / +2.4** | **−0.5** |
| G-0.85 | 128K | +3.41 (+4.69) | +0.59 [−0.76, +2.03] (+1.78) | +0.4 / +0.5 | +0.2 |
| G-0.85 | 200K | +7.56 (+9.80) | +3.96 [+1.33, +6.57] (+6.20) | +4.3 / +4.7 | +3.1 |
| G-0.85 | 252K | +4.92 (+6.45) | +0.86 [−1.16, +2.76] (+2.47) | +1.3 / +1.6 | +0.7 |
| T-0 | 128K | −3.98 (−2.84) | −6.57 [−8.58, −4.71] (−4.99) | −7.6 / −8.4 | −4.9 |
| T-0 | 200K | −0.01 (0.00) | −3.33 [−5.48, −1.15] (−1.49) | −4.1 / −5.1 | −1.6 |
| T-0 | 252K | 0.00 (0.00) | −3.82 [−5.57, −2.13] (−2.39) | −4.9 / −6.4 | −1.0 |
| T-0.7 | 128K | −3.38 (−2.38) | −6.00 [−7.76, −4.34] (−4.60) | −7.0 / −7.8 | −4.4 |

On this set the corrected 1.9.0-era plugin does shorten (3.5 to 8.8 results per session) and costs more than stock at every window.
T-0's gain against it at 200K/252K therefore comes from the baseline's extra rewrites, not from anything T-0 did.

### Facts kept, compactions, rewrites, cost split (60 development scenarios, 128K; other windows in the report)

| arm | facts kept | vs 1.9.0 (pts) | compactions / session | rewrites / session | DeepSeek pro read / write / output (k miss-units) |
|---|--:|--|--:|--:|--|
| stock = baseline-1.9.0 | 18.5% | | 1.00 | 7.57 | 62.2 / 246.9 / 6.0 |
| G-0.7 (= default) | 18.2% | −0.6 [−3.8, +3.7] | 0.97 | 8.02 | 61.7 / 259.4 / 5.8 |
| G-0.85 | 17.8% | −0.9 [−2.6, +0.4] | 0.98 | 7.77 | 61.9 / 252.7 / 5.9 |
| T-0 | 34.6% | +15.5 [+9.2, +22.8] | 0.67 | 7.53 | 62.4 / 233.2 / 4.0 |
| T-0.7 | 24.5% | +5.8 [+2.9, +9.0] | 0.97 | 7.75 | 63.1 / 238.4 / 5.8 |

At 200K and 252K, G-0.7 keeps far more facts than the 1.9.0-era plugin (+29.7 and +29.1 points) at +9.1% / +7.8% cost under
DeepSeek pro.

## Sign changes against the original pricing (read 0.1, write 1.0, output 4)

Under the four **registered** profiles and the DeepSeek TTL/unit sensitivities, **no sign changes on the 60 development
scenarios**. Every change:

- **Anthropic Haiku 5.5 (5 min and 1 h), dev+validation at 200K:** G-0.7 / default vs stock and vs 1.9.0 go from +4.65% to −9.12% (5 min) and −3.40% (1 h); G-0.85 goes from +1.90% to −2.66% (5 min). The cause is the ×5 tier above 100K: shortening keeps more requests under 100K.
- **Haiku, burned-r1 at 200K/252K:** the same mechanism, in both directions. It flips the 1.9.0-era plugin, G-0.7 and G-0.85 vs stock (+0.6 to +4.8% become −2.2 to −23.3%), and T-0/T-0.7 vs 1.9.0 (−1.59% becomes +12.05% at 200K; −1.01% becomes +2.95% at 252K).
- **burned-r1 at 252K, G-0.7 (and default) vs the 1.9.0-era plugin:** −0.46% (legacy) becomes +1.62% (pro) and +2.45% (flash), and
  also turns positive under pro/flash at TTL 5 min / 1 h / unit 1024, Sonnet 5 min with no expiry, Opus/Sonnet 1 h and OpenAI 12 h.
  Its CI covers zero under every one of them.

## What is still unverified

- **DeepSeek prefix-unit size** ("fixed token intervals", size not published): modelled as 64 tokens; 1,024 changes no sign against 64.
- **DeepSeek hit rate as a function of the idle gap** (best-effort eviction, hours to days): primary is no expiry; 5 min and 1 h are
  sensitivities.
- **The idle-gap distribution itself is synthetic.** No real session timings were logged, so the Anthropic and OpenAI TTL results rest
  on an assumed model.
- **Anthropic breakpoint placement and OpenAI prefix increments** are modelled by the same prefix rule. Whether a read refreshes a
  1-hour entry is unknown; every profile is treated as refresh-on-use.
- **The OpenAI profiles are generic and secondary-sourced** (output at o = 5, the 272K tier not re-read).
- **The model's own output tokens are not priced.** They are identical across arms in this replay, which only issues tool calls.
- **No live probes.** Every figure is replay-only.

## Reproducing

```
git archive 922d171 vendor | tar -x -C <scratch>/engine-1.9.0
node scripts/replay.ts --split dev+validation+burned-r1 --arms stock,baseline-1.9.0,G-0.7,G-0.85,T-0,T-0.7,default-1.10.0 \
  --baseline-vendor <scratch>/engine-1.9.0/vendor --out rows.jsonl [--shard k/n]
node scripts/replay.ts --reprice rows.jsonl --json out.json      # exit 1 if any arm-vs-itself check is not exactly 0
```

`REPLAY_PRICES` and `REPLAY_LEDGER` point at other price or ledger files. Twelve shards took about 12 minutes on one 16-core PC.
