# Compatibility, and what has and has not been verified

## Tested against

- **DeepSeek Harness 0.2.2-rc.1** (desktop app 44.7.0). `package.json` `engines.dsh` and `DSH_PIN` name exactly that version; the Harness refuses to enable the plugin on any other, and the Harness is a release candidate whose internals can change. Move the pin only after running the whole suite and the in-Harness checks on the new version.
- **Python 3.12.14** (the interpreter the Harness bundles) and 3.13 for the tests. The engine needs 3.10 or later.
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
| `ctx.slots.inject` / `ctx.slots.register`, slot `conversation.input.dock` | the bar | the Harness registers its own goal and queue docks the same way; a dock component receives `useProjection`, `useSession` and what our `inject(sessionId)` returns (found by reading the shipped client) |

A plugin must declare every Harness service it uses in `inject`, or Cordis fails it silently: the plugin declares `commands`, `subprocess`, `tools`, `systemPrompt` and `connection`.

## Verified

- A unit and integration suite against the **real Harness packages** (session log, token meter, prompt assembler, tool registry, subprocess service, Cordis event bus), extracted by `scripts/extract_harness.py`. It skips when the Harness is absent.
- The packed plugin installs into a throwaway Harness home, the composed configuration differs from stock by exactly one row, the plugin loads, `/tameru` runs, the worker starts on the bundled Python and is gone when the Harness stops, and the bar loads in the input dock, with its Results, Pins and Settings sections working against the real route (`scripts/dev_harness.py`).
- Together with **DS Bot** installed: 199 rows composed with no duplicate id, both browser bundles load, no console error, and the Tameru bar shows and opens inside DS Bot's layout.

## Not verified

- **A real model.** Nothing has run a real model through the plugin. The `local-ai` model on the author's PC declares no context window, so the Harness assumes 1,000,000 tokens and would not reach any trigger; live use needs a model with a declared `contextWindow`.
- **A DS Bot Bot session under pressure.** The stand-down for chats whose compaction another plugin manages is a documented-behaviour test (an own `compactIfNeeded`, `compactNow`, `compactRegion` or `summarize`), checked against DS Bot's source and by unit test, not against a running Bot with a long chat.
- **How the Harness's own chat view draws the Artifact Trail note** (a user-role notice of source kind `tameru`): the session accepts it and the model receives it; its appearance in the transcript has not been looked at.
- **The cost claim.** See [REPLAY-VS-STOCK.md](REPLAY-VS-STOCK.md): in simulation Tameru does not lower cost.
- **The provider's real prices and cache rules**, and any model other than the stub.
