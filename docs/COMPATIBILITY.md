# Compatibility, and what has and has not been verified

## Tested against

- **DeepSeek Harness 0.2.2-rc.3.** It was first built and measured on 0.2.2-rc.1; when the desktop app updated to rc.3 the Harness skipped the plugin (`incompatible with dsh 0.2.2-rc.3`), so it was re-tested on rc.3 and the pin moved. `package.json` `engines.dsh` and `DSH_PIN` name exactly that version; the Harness refuses to enable the plugin on any other, and the Harness is a release candidate whose internals can change. Move the pin only after running the whole suite and the in-Harness checks on the new version.
- **Python 3.12.14** (the interpreter the Harness bundles) and 3.13 for the tests. The engine needs 3.10 or later.
- **Tameru engine 1.10.0** (commit `404d132`, vendored byte for byte with its `presets.json`), worker protocol 2. The worker still answers protocol 1 requests, and the host sends only protocol 1 fields to a worker that reports 1 (an engine before 1.10.0); both paths are tested with scripted workers, and protocol 2 with the real one.
- **Node 24** (the Harness's own runtime).
- **Windows 11.** The code paths are platform-neutral, but nothing here has been run on macOS or Linux.

## Harness interfaces the plugin depends on

| Interface | Used for | Note |
|---|---|---|
| `agent/pre-step` (a serial waterfall; a listener may add messages to the `enter` decision) | shortening, queued writes, the Artifact Trail | documented in `dsh-agent` and `dsh-agent-loop` |
| `ctx.tokenMeter.measure`, `estimateMessage` | pressure, prices | documented |
| `ctx.llm.resolveModelInfo` | the context window | documented |
| `session.surface`, `session.append`, `session.seq`, `session.deriveMessages` | reading and writing the chat | documented |
| **`session.eventAt`, `session.deriveEventMessage`** | reading single events | **marked deprecated for new code**, but the Harness's own pruner and compaction backend still use them and there is no synchronous alternative. They are used in one place each (`shorten.ts`, `originals.ts`, `trail.ts`); expect to migrate them when the Harness offers a replacement. |
| `compaction/prune` + replacing `tool/result` (`surfaceOp` replace, `sourceEventSeqs`) | every write | documented in the compaction packages; the Session enforces that a replacement changes only the content |
| `ctx.subprocess.spawn` | the engine worker | documented; piped `stdin` and `stdout` on the handle |
| `ctx.tools.register`, `ctx.commands.register`, `ctx.systemPrompt.section`, `ctx.connection.fetch.register` | tool, command, pins, panel route | documented |
| `@deepseek-ai/dsh-client-ui-primitives` (`Tooltip`, `Icon*`), a module the web shell shares with plugin bundles | the bar's hover cards and generic icons | **not documented**: found by reading the shipped client. Every part is looked up by name with a plain fallback (`src/client/ui.ts`), and tests render the bar with none of them present, with an export that is not a component, and with the bar itself throwing |
| `ctx.slots.inject` / `ctx.slots.register`, slot `conversation.input.dock` | the bar | the Harness registers its own goal and queue docks the same way; a dock component receives `useProjection`, `useSession` and what our `inject(sessionId)` returns (found by reading the shipped client) |

A plugin must declare every Harness service it uses in `inject`, or Cordis fails it silently: the plugin declares `commands`, `subprocess`, `tools`, `systemPrompt` and `connection`.

## Verified

- A unit and integration suite against the **real Harness packages** (session log, token meter, prompt assembler, tool registry, subprocess service, Cordis event bus), extracted by `scripts/extract_harness.py`. It skips when the Harness is absent.
- The packed plugin installs into a throwaway Harness home, the composed configuration differs from stock by exactly one row, the plugin loads, `/tameru` runs, the worker starts on the bundled Python and is gone when the Harness stops, and the bar loads in the input dock, with its Results, Pins and Settings sections working against the real route (`scripts/dev_harness.py`).
- With **DS Bot** installed (checked once, on 0.1.0, and no longer re-checked): 199 rows composed with no duplicate id and both browser bundles loaded with no console error.

- **Contrast and layout, measured on the live bar** (Harness 0.2.2-rc.3 web client, sample data): dimmed text is 8.84:1 on its surface in the dark theme and 6.03:1 in the light theme (the Harness's own tertiary colour is 3.66:1 in light, so the bar blends 30% of the primary colour into it); primary text 14.3:1 and 18.7:1. Exactly two text sizes at the default and at an 18 px user font, a 36 px bar, the card flush with the bar with a 6 px gap, all size columns and trailing buttons on one x, and no overflow.

## Not verified

- **Engine 1.10.0 on this plugin's own measurements.** [MEASURED-VS-STOCK.md](MEASURED-VS-STOCK.md) and [REPLAY-VS-STOCK.md](REPLAY-VS-STOCK.md) describe engine 1.9.0 and were not redone. The 1.10.0 numbers in the [CHANGELOG](../CHANGELOG.md) are the engine's own replay (engine repository `docs/RESULTS-1.10.0.md`), replay-only: no whole-session cost, no real model, no answer-quality check, no bill.
- **The Python 3.10 to 3.12 range with engine 1.10.0.** The suite ran on 3.13 here; the engine's own determinism checks across 3.10 to 3.13 are the engine repository's.
- **How a regular expression passed to `grep` behaves on every JavaScript engine version**: it is bounded by a static check, a length limit and a time budget, not by a hard timeout (a single `RegExp.test` cannot be interrupted).

- **The measurements on rc.3.** [MEASURED-VS-STOCK.md](MEASURED-VS-STOCK.md) and [REPLAY-VS-STOCK.md](REPLAY-VS-STOCK.md) were run on 0.2.2-rc.1. The stock trigger formula and the stock pruner's constants (8,192 / 4,096 / 1,024) are identical in rc.3, but the replay was not re-run.
- **Staying compatible as the Harness updates.** The Harness refuses a plugin whose `engines.dsh` is not its exact version, and the desktop app updates itself, so every release candidate needs this plugin re-tested and re-pinned before it loads.

- **A real model.** Nothing has run a real model through the plugin. The `local-ai` model on the author's PC declares no context window, so the Harness assumes 1,000,000 tokens and would not reach any trigger; live use needs a model with a declared `contextWindow`.
- **A DS Bot Bot session under pressure.** The stand-down for chats whose compaction another plugin manages is a documented-behaviour test (an own `compactIfNeeded`, `compactNow`, `compactRegion` or `summarize`), checked against DS Bot's source and by unit test, not against a running Bot with a long chat.
- **How the Harness's own chat view draws the Artifact Trail note** (a user-role notice of source kind `tameru`): the session accepts it and the model receives it; its appearance in the transcript has not been looked at.
- **The cost claim.** See [REPLAY-VS-STOCK.md](REPLAY-VS-STOCK.md): in simulation Tameru does not lower cost.
- **The provider's real prices and cache rules**, and any model other than the stub.
