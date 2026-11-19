# Whole-session replay against the stock Harness: Tameru does not lower cost

**Short answer.** With the settings it ships, Tameru is cost-neutral on these simulated sessions (+0.0%) because it almost never acts. Lowering its confidence gate makes it act, and then sessions cost **about 3% more**, in exchange for keeping **about 0.7 more of 5 needed facts** in context. No setting tried made a session cheaper. Do not read anything here as a claim that Tameru saves a Harness user money. The per-output result is in [MEASURED-VS-STOCK.md](MEASURED-VS-STOCK.md).

> **Superseded for plugin 0.2.0 (engine 1.10.0) by [REPLAY-1.10.0.md](REPLAY-1.10.0.md).** `scripts/replay.ts` has since been rewritten (shared row format, cluster bootstrap, new scenario families); this page and `docs/results/replay-full.*` record the earlier run with engine 1.9.0 and are kept as they were.

## What was run

`scripts/replay.ts` (rows and tables: `docs/results/replay-full.json`, `replay-full.md`). 40 simulated sessions of 60 steps (160 runs in all, each session run as stock and under three Tameru settings): 10 seeds × 2 context windows (128K, 200K) × 2 query styles, each run once as stock and under three Tameru settings on identical tool outputs (6,000 to 30,000 characters each, mixed log, compiler and test-runner style, with 5 needed configuration values buried one per output among distractors and stale values).

- **Real:** the Harness's session log, token meter and tool-result pruner (0.2.2-rc.1); this plugin's own step-boundary pass; the Tameru engine through the worker.
- **Stock behaviour:** at the Harness's own trigger (`min(0.8 W, W − 8,000 − 65,536)`, 54,464 tokens at 128K) the stock pruner shortens every result over 8,192 characters to 5,120, and if the prompt is still over the trigger a summary compaction follows.
- **Simulated:** the model (it only issues tool calls), and the summary compaction, replaced by a fixed 2,000-token summary that keeps no facts. That is the worst case for fact retention and is the same in every arm.
- **Cost:** input-token equivalents. Each request pays `read` for the prompt prefix identical to the previous request's and `write` for everything else; a compaction also pays to replay its span and 4× its summary output. Primary pricing is DeepSeek-like (read 0.1, write 1.0); read 0.1 / write 1.25 is shown as a sensitivity. **These prices are my assumption from public pricing, not read from the user's provider.** A local model such as the GX10 has no per-token price at all, in which case the figures below measure prompt processing, not money.
- **Arms:** `tameru` (shipped: confidence gate 0.7), `gate 0.5`, and `no gate`.

## Results (all 40 sessions per arm; change is paired against stock on the same session)

| Arm | Cost change vs stock (95% interval) | Facts held at the end (of 5) | Results shortened / session |
|---|---|---|---|
| stock | 663,204 (baseline) | 2.10 | n/a |
| Tameru, shipped (gate 0.7) | +0.0% (+0.0% to +0.1%) | 2.13 | 0.1 |
| Tameru, gate 0.5 | **+3.0% (+1.9% to +4.2%)** | 2.77 | 6.0 |
| Tameru, no gate | **+3.0% (+1.9% to +4.2%)** | 2.77 | 6.0 |

With a write premium (read 0.1, write 1.25): shipped +0.0%, gate 0.5 **+3.7%** (+2.4% to +5.0%).

By cell, gate 0.5: 128K +0.8% to +1.2%; 200K **+4.1% to +5.9%** (facts held 3.2 to 4.5 of 5, against 2.6 for stock). Per-step time added by the pass: 7 to 23 ms on average.

## What this says

1. **Shortening earlier did not pay for itself here.** Each change rewrites the provider's prompt cache from the changed result onward. The stock pruner makes one large cut at one moment; Tameru's cuts come earlier and in pieces. The likely reason it costs more is that those rewrites cost more than the tokens the earlier cuts save, in this model of caching; the replay shows the cost difference, not the cause.
2. **The shipped gate makes the plugin nearly inert.** The engine was confident enough to act on 0.1 results per session, and the 35% pay-back rule declined most of the rest (the pass logged 175 "not worth it" and 231 "not confident" skips against 801 "no candidates"). That is safe but also delivers almost nothing.
3. **There is a real trade, and it is a small one:** about 3% more cost for about 0.7 more needed facts in context per session. Whether that is worth it depends on how much a lost fact costs, which this replay does not measure.
4. **The stock pruner rarely lets a session reach compaction** (0.5 compactions per session). It prunes everything at once at the trigger, so there is little left for an earlier, gentler pass to avoid.

## What this does not show

- **Real model behaviour.** No model ran. A fact "held" is present in the prompt; whether a model uses it, or would have found it by reading the original back, is not measured: the replay model never read originals back, so the fact counts do not include that recovery (the plugin can now do it; it was not part of this replay).
- **Summaries that keep some facts.** Real summaries retain some of what they cover. With them the stock arm would hold more facts than shown, which would narrow the fact advantage.
- **Real outputs and tasks.** The sessions are synthetic and the evidence is five one-line facts. Real outputs have near-miss lines and facts that need several lines.
- **Cache behaviour beyond the model above** (expiry, provider-specific rules, minimum cacheable length).
- **Tuning.** The 0.75 activation point, the 0.35 share and the 0.7 gate are the plugin's shipped values; they were not tuned on this replay, so a different setting might do better or worse. Searching for one on these sessions and then reporting the best would be a new, separate experiment.

## Decision

The defaults stay as they are: they cost nothing and risk nothing, and the plugin does not claim a saving. Lowering `minConfidence` is documented as a trade of roughly 3% cost for more facts kept, not as an optimisation. The work that could change the picture is giving the model a way to **read an original back** (so a shortened result no longer means a lost fact) and letting the user Keep and Restore results; those now exist in the plugin but were not part of this replay, and they should be judged on facts recoverable per extra cost, not on cost alone.
