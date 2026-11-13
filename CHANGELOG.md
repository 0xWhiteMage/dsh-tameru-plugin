# Changelog

## [Unreleased]

### Added
- **A way back and user control.** `tameru_read_original` (a model tool, a plain definition so nothing is imported from the Harness at run time) reads a shortened result's original in windows; `/tameru changes`, `view`, `keep`, `restore`, `unkeep`, `help`. A result's state (shortened, restored, kept) lives in its visible header because the Harness lets a `tool/result` replacement change only its content, so it survives restarts and forks. Keep and Restore write the same price-event-then-replacement pair as the pass, citing the original and the node they replace. Changes asked for mid-turn are queued for the next step boundary. A restore expires after 3 model replies counted from the restore itself. The read tool's own results are never shortened.
- **Shortening at step boundaries.** An `agent/pre-step` listener (never `prepend`) that, above 75% of the Harness's own compaction trigger (computed the way `dsh-compaction-basic` does), replaces large old tool results with the engine's query-aware extract. Results that are errors, spilled to a file, already cut, not text, unread by the model, or among the newest four are never touched. Applied only when the engine's confidence is at least 0.7 and the change frees at least 35% of what it makes the provider rewrite. Writes the same `compaction/prune` + replacing `tool/result` pair the Harness's pruner writes, after re-checking that nothing changed while the engine worked and that no compaction is open.
- Stands down for chats whose compaction another plugin has taken over (an own `compactIfNeeded`, `compactNow`, `compactRegion` or `summarize` on the backend object, or `auto: false`).
- `/tameru` reports what was shortened in the chat, or why nothing was.
- Settings: `shorten`, `activation`, `minConfidence`, `share`, `protectRecent`, `minResultChars`, `maxPerPass`.
- A chat remembers results the engine already declined, so the same output is not sent to the engine again at every later step.
- `docs/REPLAY-VS-STOCK.md`: 160 simulated whole sessions against the stock Harness, with the real session log, token meter, stock pruner, this plugin's pass and the engine. **Result: at the shipped settings Tameru is cost-neutral (it almost never acts); with the confidence gate lowered it acts and sessions cost about 3% more while holding about 0.7 more of 5 needed facts.** No setting tried was cheaper than stock. `scripts/replay.ts` reproduces it.
- `docs/MEASURED-VS-STOCK.md`: the first measurement against the stock pruner, with its limits (per output, not per session; no cost claim). `scripts/compare_stock.ts` reproduces it.
- Skeleton: the plugin loads in DeepSeek Harness, starts the Tameru engine as an isolated Python worker, and `/tameru` reports the plugin and engine versions. Nothing is shortened yet.
- The worker protocol (version 1): a fixed list of accepted fields, no disk, network or model options, UTF-8 over stdin and stdout, exits when stdin closes.
- Fail-open engine client: a slow, crashed or misbehaving worker leaves every original untouched and turns itself off after repeated failures.
- Engine vendored from tameru-compaction-system commit `9f1f1c4` (Tameru 1.9.0), with a check that the copy is identical.

- Contract tests against the real Harness packages (Cordis and the managed subprocess service), extracted on demand by `scripts/extract_harness.py`. They found two defects, both fixed: cleanup must be registered with `ctx.effect` (there is no `dispose` event), and a write to an already-ended worker must not raise an unhandled pipe error, which would stop the whole Harness.
- Verified in the real Harness (0.2.2-rc.1) with an isolated throwaway home and a stub model, never your own profile: the packed plugin installs; the Harness composes it with exactly one added row and nothing else different from stock; `/tameru` appears in the command list, runs, and is logged in the session; with `pythonPath` set it reports "Engine 1.9.0 (matches source commit 9f1f1c4), Python 3.12.14"; the worker runs as `python -I -B -P .../vendor/run_worker.py`; stopping the Harness leaves no worker behind.
- The package no longer ships Python bytecode (it would have shipped 16 `.pyc` files).
- A "loaded" line is logged through the Harness logger at startup.
