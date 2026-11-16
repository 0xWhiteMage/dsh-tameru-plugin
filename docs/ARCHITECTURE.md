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
| Engine worker | `ctx.subprocess` (managed process tree, scrubbed environment) | `src/host/engine-client.ts`, `process.ts`, `vendor/run_worker.py` |
| Read an original | a tool definition registered with `ctx.tools` | `src/host/tool.ts`, `originals.ts` |
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
5. **The engine cannot be asked to do anything but extract.** The worker accepts a fixed short list of fields, writes nothing to disk, reaches no network or model, starts isolated (`python -I -B -P`) and exits when its input closes.
6. **Untrusted text stays data.** Tool output reaches the model only as the extract of a result it was already in. The Artifact Trail is built from typed fields (tool names, path and command arguments, error flags), each capped and stripped of markup, and says it is data. A pin is only ever text the user typed, and no tool lets the model pin.

## Names

Everything we add is called `tameru`: the plugin row `tameru`, the command `/tameru`, the tool `tameru_read_original`, the prompt section `tameru:pins`, the route `/api/tameru`, the dock entry id `dsh-tameru`, the CSS classes `tameru-*`, the folder `<Harness home>/tameru`. A test checks that the patch file inserts one row and nothing else.
