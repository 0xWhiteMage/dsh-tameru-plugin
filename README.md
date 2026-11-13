# dsh-tameru

[Tameru](https://github.com/0xWhiteMage/tameru-compaction-system) for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): shortens bulky tool output before it fills the context, keeps every error, and lets you pin, keep and restore. Local, deterministic, no extra model calls.

> **Status: early development (0.1.0, unreleased).** The plugin loads, starts the engine and reports on it. **It does not shorten anything yet.** The list below is what exists today and what is planned; nothing planned is claimed as working.

## What works today

- `/tameru` shows the plugin version, the engine version and whether the engine is running.
- The Tameru engine runs as an isolated Python worker on the interpreter the Harness bundles (or one you name), started through the Harness's own managed subprocess service.
- It fails open: if Python is missing, or the engine is slow, crashes or misbehaves, nothing in your chat changes, and after repeated failures the engine turns itself off until restart.
- With `enabled: false` the plugin adds nothing at all.

## Planned, in order

1. Shorten large tool results before the Harness would compact, using Tameru's extract instead of a head-and-tail cut. Every error kept; the original stays in the session.
2. Read an original back (`tameru_read_original`); Keep and Restore.
3. Pins that survive every summary; an Artifact Trail after each summary.
4. A Tameru tab in the right sidebar (context gauge, every cleanup, a viewer for what was left out) and a settings page.

## Install

Not published yet. For development, see [Development](#development). Requires DeepSeek Harness **0.2.2-rc.1** (the version this plugin is tested on; the Harness refuses to enable it on other versions) and Python 3.10+ (bundled with the Harness).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` makes the plugin do nothing. |
| `pythonPath` | the Harness's bundled Python | A Python 3.10+ interpreter for the engine. On Windows there is no fallback to a bare `python`. |

## How it stays out of the way

- It adds one row to the Harness composition and **disables, replaces or wraps nothing** of the Harness or of other plugins (see `cordis.patch.yml`). Turning the bundle Off or removing it leaves the Harness stock.
- Everything it adds is named `tameru`: the command `/tameru`, the plugin `dsh-tameru`, the row `tameru`.
- The engine worker accepts a fixed short list of fields. It cannot be asked to write to disk, reach a network or run a model, and a test proves it writes nothing under the home directory.
- The worker starts isolated (`python -I -B -P`), so a file planted in a workspace cannot be imported, and it exits when the Harness closes its input.

## Development

```bash
npm install
npm test                 # 31 tests: protocol, fail-open client, lane checks
npm run build            # bundles src/host to lib/host.js
python scripts/check_vendored.py --engine <path to tameru-compaction-system>
```

`vendor/tameru/` is the engine, byte for byte; `VENDORED_FROM` in its `__init__.py` names the commit and `check_vendored.py` proves the copy is identical. The engine is [harness-agnostic](https://github.com/0xWhiteMage/tameru-compaction-system/blob/main/docs/REPOSITORIES.md); this repository owns only what is specific to DeepSeek Harness.

## Licence

Apache-2.0. See `LICENSE`, `NOTICE` and `THIRD_PARTY_NOTICES.md`.
