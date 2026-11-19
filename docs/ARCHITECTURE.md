# How dsh-tameru fits into DeepSeek Harness

dsh-tameru is a host plugin and a browser plugin in one npm package. It adds to the Harness and **replaces, disables and wraps nothing** of it or of other plugins: removing it leaves the Harness stock.

```
Host (DeepSeek Harness, Node)
  agent loop -- agent/pre-step --> our listener
      registered with ctx.on (never prepend), so it runs after listeners
      registered before it (that order is by load sequence; DS Bot is covered by a stand-down test, not a long live chat)
        1. apply queued Keep / Restore
        2. shorten old large results  --> worker (Python, one line of JSON per request)
        3. add the Artifact Trail note after a compaction
  system prompt <-- the tameru:pins section
  POST /api/tameru <-- state, hold, view, pin, unpin, settings

Browser (Harness web client)
  input dock above the chat: the Tameru bar (React) --> POST /api/tameru
```

## What it adds, and where each piece lives

| Piece | Harness seam used | Source |
|---|---|---|
| Shortening at step boundaries | `agent/pre-step` listener, session log, token meter | `src/host/step.ts`, `shorten.ts`, `stock.ts` |
| Engine worker | `ctx.subprocess` (managed process tree, scrubbed environment) | `src/host/engine-client.ts`, `process.ts`, `legacy-decision.ts`, `vendor/run_worker.py`, `src/shared/protocol.ts` |
| Read an original (windows, or `grep`) | a tool definition registered with `ctx.tools` | `src/host/tool.ts`, `originals.ts`, `grep.ts` |
| Keep, Restore, queueing | the same event pair the Harness's pruner writes | `src/host/originals.ts`, `commands.ts` |
| Pins | a `tameru:pins` system-prompt section; a file under the Harness home | `src/host/pins.ts` |
| Artifact Trail | a note added to the `agent/pre-step` decision | `src/host/trail.ts` |
| `/tameru` | `ctx.commands` | `src/host/commands.ts` |
| The panel's data | `ctx.connection.fetch` route `POST /api/tameru` | `src/host/api.ts` |
| The Tameru bar | the `conversation.input.dock` slot (a list slot: our entry sits after the Harness goal and queue docks) | `src/client/` |

## The rules the design follows

1. **Nothing stock is touched.** On desktop the pruner and the compaction backend live inside each agent preset, out of a plugin's reach, and subclassing the backend would run a second one beside it. So Tameru acts only through public events and services, and stands down for any chat whose compaction another plugin manages (DS Bot assigns its own functions to the backend object; that is the test).
2. **The log is the state.** A result's state (shortened, restored, kept) is the visible header of its `tool/result` replacement, because the Harness lets a replacement change only the content. It therefore survives a restart or a fork with nothing stored elsewhere. Pins and saved settings are the only files, both under `<Harness home>/tameru/`.
3. **Every write is a complete pair.** A `compaction/prune` price event immediately before a replacing `tool/result` that cites the original, so the Harness's meter stays exact (a test compares it with a full recount after every kind of write). Nothing is written while a compaction is open, or if the chat changed while the engine worked.
4. **Fail open.** A missing Python, a slow or crashed engine, a declined extract, an error in any handler: the original stays as it is and the step goes on. After repeated engine failures the engine rests for five minutes and is then tried again.
5. **The engine cannot be asked to do anything but extract.** The worker accepts the engine's own field list (`tameru.protocol`, protocol 2: unknown fields refused, `ccr` always off, no summary, model, path or code options), plus two plugin fields (`query_parts`, `policy`). It writes nothing to disk, reaches no network or model, starts isolated (`python -I -B -P`), exits when its input closes, answers every bad request with a fixed error code that never repeats request text, and accepts `pin_patterns` as literals only.
6. **Untrusted text stays data.** Tool output reaches the model only as the extract of a result it was already in. The Artifact Trail is built from typed fields (tool names, path and command arguments, error flags), each capped and stripped of markup, and says it is data. A pin is only ever text the user typed, and no tool lets the model pin.
7. **The engine decides, the host acts.** The request names the preset `dsh-tool-result@1` (resolved in the worker; the engine's hash-pinned data file) and carries the acceptance policy; the reply carries the engine's `decide()` result with a closed reason code. `shorten.ts` reads only `decision.accept` (a node test greps every host file for any confidence, risk or fingerprint threshold other than values passed to the worker). The host adds the one check only it can make, the Harness's own token meter on the message it would write.
8. **A result is decided once.** The memory of what the engine declined is keyed on the result (place and length), never on the question, so a later question cannot cause a second rewrite. Shortened results are recognised by their header, so they are not candidates again.
9. **Redaction is on, and what that does and does not cover.** The engine redacts credential-shaped text in an extract and the worker in the header's dropped locators. A fail-open returns the original unredacted; the host never acts on it.
10. **Two protocol generations.** `EngineClient` asks a worker for its version once (only when a request uses a version 2 field) and sends version 2 fields (`preset`, `anchor_errors`, `redact_secrets`, `query_parts`, `policy`) only to a worker that reported protocol 2; otherwise it sends the old request (host-built query, 25% floor) and applies the old rule from `legacy-decision.ts` with the same policy numbers.

## Names

Everything we add is called `tameru`: the plugin row `tameru`, the command `/tameru`, the tool `tameru_read_original`, the prompt section `tameru:pins`, the route `/api/tameru`, the dock entry id `dsh-tameru`, the CSS classes `tameru-*`, the folder `<Harness home>/tameru`. A test checks that the patch file inserts one row and nothing else.
