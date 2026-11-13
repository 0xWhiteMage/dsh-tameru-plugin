# How dsh-tameru fits into DeepSeek Harness

dsh-tameru is a host plugin and a browser plugin in one npm package. It adds to the Harness and **replaces, disables and wraps nothing** of it or of other plugins: removing it leaves the Harness stock.

```
                 DeepSeek Harness (host, Node)                         browser
  ┌─────────────────────────────────────────────────────┐     ┌─────────────────────────┐
  │ agent loop ── agent/pre-step ──► our listener        │     │ right sidebar           │
  │                 (after the Harness's own backend     │     │   └─ Tameru tab (React)  │
  │                  and DS Bot; never `prepend`)        │     │        │ POST api/tameru │
  │   │ 1 apply queued Keep/Restore                      │ ◄───┼────────┘                 │
  │   │ 2 shorten old large results  ──► worker (Python) │     └─────────────────────────┘
  │   │ 3 add the Artifact Trail note after a compaction │
  │ system prompt ◄── tameru:pins section                │
  │ tools         ◄── tameru_read_original               │
  │ commands      ◄── /tameru                            │
  │ connection    ◄── POST /api/tameru                   │
  └─────────────────────────────────────────────────────┘
        engine: the Tameru Python engine, vendored unchanged, run as an isolated worker
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
| The Tameru tab | `ctx.sidebarRightTabs` and the `sidebar.right.pane.tab` slot | `src/client/` |

## The rules the design follows

1. **Nothing stock is touched.** On desktop the pruner and the compaction backend live inside each agent preset, out of a plugin's reach, and subclassing the backend would run a second one beside it. So Tameru acts only through public events and services, and stands down for any chat whose compaction another plugin manages (DS Bot assigns its own functions to the backend object; that is the test).
2. **The log is the state.** A result's state (shortened, restored, kept) is the visible header of its `tool/result` replacement, because the Harness lets a replacement change only the content. It therefore survives a restart or a fork with nothing stored elsewhere. Pins and saved settings are the only files, both under `<Harness home>/tameru/`.
3. **Every write is a complete pair.** A `compaction/prune` price event immediately before a replacing `tool/result` that cites the original, so the Harness's meter stays exact (a test compares it with a full recount after every kind of write). Nothing is written while a compaction is open, or if the chat changed while the engine worked.
4. **Fail open.** A missing Python, a slow or crashed engine, a declined extract, an error in any handler: the original stays as it is and the step goes on. After repeated engine failures the engine turns itself off.
5. **The engine cannot be asked to do anything but extract.** The worker accepts a fixed short list of fields, writes nothing to disk, reaches no network or model, starts isolated (`python -I -B -P`) and exits when its input closes.
6. **Untrusted text stays data.** Tool output reaches the model only as the extract of a result it was already in. The Artifact Trail is built from typed fields (tool names, path and command arguments, error flags), each capped and stripped of markup, and says it is data. A pin is only ever text the user typed, and no tool lets the model pin.

## Names

Everything we add is called `tameru`: the plugin row `tameru`, the command `/tameru`, the tool `tameru_read_original`, the prompt section `tameru:pins`, the route `/api/tameru`, the tab id `dsh-tameru/panel`, the CSS classes `tameru-*`, the folder `<Harness home>/tameru`. A test checks that the patch file inserts one row and nothing else.
