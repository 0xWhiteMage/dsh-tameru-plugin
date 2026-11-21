# P3: policy `plan` — the engine's `plan()` at the stock trigger (beta, replay only)

Round 3 session-corpus replay, development split only (132 scenarios at 128K / 252K / 500K). **Replay only: no real model
ran; the corpus holdout is sealed and was never read; validation is touched only through thresholdout, and none ran here.**
The setting is registered in the engine's settings-tried ledger as `P1` (`docs/SETTINGS-TRIED-LEDGER.json`, n=31).

## The problem `plan` answers

`at-trigger` (T-0) is inert: it skips with `would_leave_cuts` on most trigger moments, because its write is all-or-nothing —
any result stock would cut that the engine cannot cover (fail-open, longer than the stock cut, over the per-pass cap) blocks
the whole pass, and the stock cut happens alone. `plan` removes the all-or-nothing rule: the engine's `plan()` maps *every*
result stock would cut to either `extract` (a candidate that passes the hard vetoes and the EV rule, and fits the stock cut)
or `stub` — the stock pruner's own head/marker/tail cut, byte-identical. Coverage is total by construction; a partial
replacement cannot happen, so `would_leave_cuts` cannot occur.

## The stock pruner's exact behaviour (authority: `dev/harness` packages)

Source: `dev/harness/node_modules/@deepseek-ai/dsh-compaction-tool-result-pruner/lib/index.js`, invoked by the backend at
`@deepseek-ai/dsh-compaction-basic/lib/index.js:954-963` (`compactPressure`: when `measurement.totalTokens >= spec.thresholdTokens`,
call `prune.pruneSession` then re-measure) and `:938` (context-overflow path).

- **Cut set** — `pruneSession` (index.js:137-183) iterates *every* `tool/result` event on `session.surface.nodes`: no
  read/unread split, no recency protection, no per-pass cap. A result is cut when `measureContent` (index.js:79-83: Unicode
  code points across `type === 'text'` blocks; non-text blocks cost zero) exceeds `thresholdChars`, default **8,192**
  (index.js:10-14).
- **Replacement text** — `pruneContent` (index.js:91-123): `headChars` **4,096** + `PRUNE_MARKER`
  (`"\n\n[... tool result middle pruned ...]\n\n"`, index.js:8) + `tailChars` **1,024**, spliced per text block by code point
  (surrogate pairs kept whole), non-text blocks kept in order. What stock leaves is `stockKeptChars` = 4,096 + 39 + 1,024 =
  **5,159 code points**.
- **The write** — `compaction/prune` price event (`shadowedSeqs: [seq]`, `shadowedTokenCount` from the token meter), then the
  `tool/result` replacement `{...event.data, message: freezeMessage({...original, content})}` with
  `surfaceOp: {op:'replace', startSeq, endSeq}` and `sourceEventSeqs: [seq]` (index.js:152-168).

`src/host/stub.ts` replicates `pruneContent` line for line (the function is exported but constructing the cordis `Service`
outside a `Context` is not supported, so the port is verified instead of called): `test/stub.test.ts` compares it to the real
package's `pruneContent` on 11 fixture shapes — multi-block, surrogate-pair boundaries, block-boundary edges, non-text blocks —
and to a real `pruneSession` run on a live session, content byte-for-byte plus every other message field. Byte-identical on all.

## The `plan` pass (`src/host/plan.ts`, beta only)

At the pre-step where the prompt is at or above the stock trigger (`pressure.stockTrigger`), the pass:

1. Lists **every** tool result on the surface as a `PlanItem` (prune mode): `stock_action: 'cut'` +
   `stock_kept_chars` = 5,159 when `measureContent > 8,192`, else `'keep'`. `id` is the plugin's `seq:length` key;
   `position` the surface index; `tokens`/`chars` the meter's node tokens / code points; `stratum: 'deepseek'`.
2. Asks the engine for one extract per cut item, longest first inside the step's time budget — the same candidate rules as
   the ordinary pass (text only, not an error/read-tool result, not already shortened/spilled, ≤ 2M chars, restored results
   extract from their original). Compress requests carry `query_parts` and **`derive_selector_query`** (protocol 3): the
   worker builds the selector query from the same parts via `transcript.build_selector_query`, so the destructive
   pre-filters gate on the user's question, not the producing call's arguments. A result the engine answered for becomes
   `candidate: {compressed_chars (code points of the header+extract), tokens_saved, confidence, fail_open, risk,
   fingerprints_ok: true, fact_lines_dropped}`; `sanitized` and genuinely non-shrinking results get no candidate, while a
   fail-open answer rides as a candidate with `fail_open: true` so the plan names the stub's reason itself.
3. Sends one `plan` request: `event: 'trigger'`, `host_mode: 'prune'`, `prompt_tokens`, `trigger_tokens` = the stock
   trigger, `cache: {warm: false, n_eff}` where `n_eff = clamp((trigger − prompt-after-all-stubs) ÷ mean step growth,
   0..200)` and mean step growth is the session's own mean positive token delta per step; `policy` = the DSH hard vetoes
   (`max_risk: high`, `allow_sanitized: false`, `min_saved_ratio: 0`, `min_tokens_saved: 1`) plus
   `ev: {price_profile, loss_profile: 'replay-2026-11-21', strength}`; `K: 3`, `H: 0`, `steps_since_last_act` from per-chat
   state. Cold-cache and warm-step events are out of scope (H = 0, event always `trigger`).
4. Applies the plan in position order with the ordinary pass's write mechanics (price event + `sourceEventSeqs`):
   `extract` → the header+extract replacement; `stub` → the stub text; anything else on a cut item is a coverage violation,
   counted as `uncovered` declines (expected: 0). Host constants (threshold, kept size, trigger formula, n_eff growth) live
   only in this adapter; the engine sees them as inputs.

Settings: `policy: 'plan'` (beta), `priceProfile` (`deepseek-v4-pro` default; enum = the engine's DeepSeek price profiles);
the strength menu picks the EV strength — Less→`less`, Normal→`normal`, More→`more` — in place of a confidence gate.
Stable is untouched (still `every-step`).

## Protocol 3 (worker)

`vendor/run_worker.py` (re-vendored engine `fd93aa7`): `compress` accepts `derive_selector_query` / an explicit
`selector_query` and passes it to `compress_context`; new `op: 'plan'` = `protocol.validate_plan_request` → `tameru.plan`
→ `protocol.plan_to_dict`. Errors stay type-only codes. A protocol-2 client is unaffected.

## Results — corpus dev split (replay only)

The run: `node scripts/replay.ts --corpus dev/session_corpus --split dev --windows 128000,252000,500000 --arms
stock,P-normal --out dev/replay-plan-p3/rows-dev.jsonl` (engine 1.10.0 at `fd93aa7`, arm P1). References re-tabulated from
P2b's committed rows (`dev/replay-corpus-round2/rows-128k-252k-500k.jsonl`: `baseline-1.9.0` on engine 1.9.0, `T-0` on
1.10.0), and the re-run `stock` rows verified equal to P2b's apart from timing.

The stock pruner facts: `pruneSession` at `dev/harness/node_modules/@deepseek-ai/dsh-compaction-tool-result-pruner/lib/index.js`
cuts every current-surface `tool/result` whose text blocks total more than 8,192 Unicode code points (`measureContent`:79,
`pruneContent`:91, `pruneSession`:137, no read/recent protection), invoked from `compactPressure` in
`@deepseek-ai/dsh-compaction-basic/lib/index.js:962`. A cut
result keeps `head` (4,096 code points) + `'\n\n[... tool result middle pruned ...]\n\n'` + `tail` (1,024), i.e. 5,159 kept code
points; non-text blocks and block order are preserved. `src/host/stub.ts` replicates `pruneContent` exactly (the real pruner is
not importable as a pure function from the plugin); `test/stub.test.ts` proves byte-identity against the real pruner on fixtures
and a live session.

**Cost** (pooled % difference, 95% CI; weighted = the four registered profiles, one-sided 95% upper bound; 132 dev clusters):

| window | vs stock | vs baseline-1.9.0 |
|--:|---|---|
| 128K | -1.30 [-1.84, -0.81] (upper -0.87) | -2.52 [-3.42, -1.69] (upper -1.82) |
| 252K | -1.41 [-1.76, -1.09] (upper -1.13) | -4.65 [-6.10, -3.30] (upper -3.51) |
| 500K | -1.59 [-1.99, -1.23] (upper -1.28) | -4.15 [-5.48, -2.96] (upper -3.13) |

Cost-negative against stock at every gated window — the first tried arm that is — and under every registered profile and
every sensitivity (TTL 5 min / 1 h, prefix unit 1,024, no-expiry, all 14 alternates; the least negative point is -1.04 under
deepseek-flash at 128K). Re-tabulated references on the same rows: `T-0` is -0.33 / -0.01 / 0.00 vs stock (inert, as diagnosed)
and `baseline-1.9.0` is +1.26 / +3.41 / +2.68.

**Facts kept** (line check, end of session) and **8(a)** (share of each accepted result's needed facts its extract kept):

| window | facts kept | vs stock | 8(a) all | 8(a) vague | en / zh / mixed | worst family |
|--:|---|---|---|---|---|---|
| 128K | 52.1% | +13.8 [+10.4, +17.2] pts | 94.1 [89.1, 98.1] (lo 89.9) | 82.6 (lo 68.2) | 93.2 / 95.0 / 94.4 (lo 85.7/88.4/83.3) | ghactions 66.7 (lo 0.0) |
| 252K | 60.5% | +14.1 [+11.3, +17.0] pts | 94.4 [90.6, 97.5] (lo 91.3) | 84.7 (lo 75.0) | 94.9 / 93.8 / 94.3 (lo 90.7/87.5/86.5) | ghactions 50.0 (lo 0.0) |
| 500K | 62.7% | +15.7 [+12.9, +18.5] pts | 95.1 [92.4, 97.4] (lo 92.9) | 92.0 (lo 86.7) | 95.5 / 94.9 / 94.2 (lo 92.9/90.0/89.0) | ghactions 75.0 (lo 50.0) |

`T-0` re-tabulated: facts kept 40.5% / 46.5% / 47.0% (+2.3 / +0.1 / 0.0 vs stock) and 8(a) 78.0 / 74.8 / 58.8;
`baseline-1.9.0`: 39.6% / 52.1% / 50.4% and 8(a) 84.1 / 81.9 / 76.4.

**Per trigger moment** (P-normal; a trigger moment = a pre-step at or above the stock trigger):

| window | moments (stock) | acted | extracts | stubs | uncovered | stub reasons | crossings/session P vs stock | rewrites/session P vs stock | pass ms p50 / p95 |
|--:|---|--:|--:|--:|--:|---|---|---|---|
| 128K | 587 (638) | 587, 100% | 556 | 2,797 | 0 | fail_open 1,601; longer_than_stock_cut 678; negative_ev 495; low_confidence 23 | 4.45 vs 4.83 | 4.33 vs 4.65 | 59.2 / 105.0 |
| 252K | 241 (247) | 241, 100% | 976 | 4,849 | 0 | fail_open 2,806; longer 1,385; negative_ev 617; low_confidence 41 | 1.83 vs 1.87 | 1.83 vs 1.87 | 45.6 / 79.5 |
| 500K | 213 (215) | 213, 100% | 2,168 | 9,497 | 0 | fail_open 5,750; longer 2,784; negative_ev 855; low_confidence 86; no_candidate 22 | 1.61 vs 1.63 | 1.61 vs 1.63 | 46.3 / 77.7 |

Every trigger acted (the hysteresis gate `K` yields to `event: trigger`), every stock-cut item covered, zero partial
replacement violations. Most stubs are engine `fail_open` answers (the engine declines to shorten the corpus's
repetitive logs and returns the original; the answer rides as a `fail_open` candidate and the plan vetoes it). `no_candidate`
counts are compress-ask misses under shard load — a stub either way. Extract share of covered cuts is ~17% at every window;
stubs still save cost because stock's cut is itself a rewrite the prompt needed anyway, and the extracts keep ~94% of their
needed facts instead of stock's ~45%.

**Notes.** Rows live in ignored `dev/replay-plan-p3/` (`rows-dev.jsonl`, 792 rows; `rows-with-refs.jsonl` adds the reused
references; `corpus-report.json` + `report.txt`). `stock` re-runs equal P2b's rows apart from `run_ms`/`pass_ms`/`records`.
Metrics are stable across re-runs; per-record stub reasons can shift by a handful because a compress ask can miss under load.
