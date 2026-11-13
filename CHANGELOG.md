# Changelog

## [Unreleased]

### Added
- Skeleton: the plugin loads in DeepSeek Harness, starts the Tameru engine as an isolated Python worker, and `/tameru` reports the plugin and engine versions. Nothing is shortened yet.
- The worker protocol (version 1): a fixed list of accepted fields, no disk, network or model options, UTF-8 over stdin and stdout, exits when stdin closes.
- Fail-open engine client: a slow, crashed or misbehaving worker leaves every original untouched and turns itself off after repeated failures.
- Engine vendored from tameru-compaction-system commit `9f1f1c4` (Tameru 1.9.0), with a check that the copy is identical.

- Contract tests against the real Harness packages (Cordis and the managed subprocess service), extracted on demand by `scripts/extract_harness.py`. They found two defects, both fixed: cleanup must be registered with `ctx.effect` (there is no `dispose` event), and a write to an already-ended worker must not raise an unhandled pipe error, which would stop the whole Harness.
- Verified in the real Harness (0.2.2-rc.1) with an isolated throwaway home and a stub model, never your own profile: the packed plugin installs; the Harness composes it with exactly one added row and nothing else different from stock; `/tameru` appears in the command list, runs, and is logged in the session; with `pythonPath` set it reports "Engine 1.9.0 (matches source commit 9f1f1c4), Python 3.12.14"; the worker runs as `python -I -B -P .../vendor/run_worker.py`; stopping the Harness leaves no worker behind.
- The package no longer ships Python bytecode (it would have shipped 16 `.pyc` files).
- A "loaded" line is logged through the Harness logger at startup.
