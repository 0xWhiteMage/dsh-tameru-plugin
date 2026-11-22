
/** S7 never-block: a step boundary is bounded by the pass budget even inside an engine call, and a result past the
 * engine's hard limit gets the read-original header without an engine call at all. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Message } from '../src/host/messages.ts'
import { READ_TOOL, SHORTENED_PREFIX } from '../src/host/messages.ts'
import { EngineClient } from '../src/host/engine-client.ts'
import { DEFAULT_SHORTEN, PASS_BUDGET_MS, TOO_LARGE_CHARS, shortenPass, type ShortenOptions } from '../src/host/shorten.ts'
import { bigOutput, skip, world } from './helpers/harness.ts'

const options: ShortenOptions = { ...DEFAULT_SHORTEN, protectRecent: 2, minResultChars: 6000 }

/** A worker the test drives by hand: the client's WorkerProcess shape — `send` captures, `line` answers, `kill` flags. */
const fakeWorker = (onSend: (parsed: Record<string, unknown>, worker: { line(reply: Record<string, unknown>): void }) => void) => {
  const worker = {
    killed: false,
    lines: [] as Array<(line: string) => void>,
    exits: [] as Array<() => void>,
    send(message: string) { onSend(JSON.parse(message) as Record<string, unknown>, worker) },
    onLine(cb: (line: string) => void) { worker.lines.push(cb) },
    onExit(cb: () => void) { worker.exits.push(cb) },
    kill() { worker.killed = true },
    line(reply: Record<string, unknown>) { for (const cb of worker.lines) cb(JSON.stringify(reply)) },
  }
  return worker
}

/** Version answers at once; `compress` answers as `respond` says (or never). */
const slowSpawn = (respond: (parsed: Record<string, unknown>, worker: ReturnType<typeof fakeWorker>) => void) =>
  () => fakeWorker((parsed, worker) => {
    if (parsed.op === 'version') worker.line({ id: parsed.id, ok: true, result: { engine: '1.10.0', protocol: 3 } })
    else respond(parsed, worker)
  })

const threeBig = async () => {
  const w = await world()
  w.step({ name: 'bash', args: {} }, bigOutput('y'))
  w.step({ name: 'bash', args: {} }, bigOutput('z'))
  w.step({ name: 'bash', args: {} }, bigOutput('w'))
  w.finish()
  return w
}

test('a result past the engine limit gets the read-original header, no engine call', { skip }, async () => {
  const w = await world()
  w.step({ name: 'bash', args: {} }, 'x'.repeat(TOO_LARGE_CHARS + 1))
  w.step({ name: 'bash', args: {} }, bigOutput('y'))
  w.step({ name: 'bash', args: {} }, bigOutput('z'))
  w.finish()
  let calls = 0
  const client = { compress: async () => (calls++, undefined), speaksV2: async () => true }
  const t0 = Date.now()
  const outcome = await shortenPass({ session: w.session, meter: w.meter, client: client as never, header: undefined, activationTokens: 0, options, extractCache: new Map() })
  const elapsed = Date.now() - t0
  assert.equal(calls, 0, 'the engine is never asked about a too_large result')
  assert.equal(outcome.kind, 'applied')
  const entry = w.session.surface.nodes.map(seq => w.session.eventAt(seq)!).find(e => e.type === 'tool/result' && e.data.message !== undefined)
  const message = w.session.deriveEventMessage(entry!)! as Message
  const text = (message.content as Array<{ text?: string }>)[0]!.text!
  assert.ok(text.startsWith(SHORTENED_PREFIX))
  assert.ok(text.includes(`read the original with ${READ_TOOL} ref=`), `header carries the reference: ${text.slice(0, 160)}`)
  assert.ok(text.includes('too large to analyse'))
  assert.ok(elapsed < PASS_BUDGET_MS, `a step with an 8M item is fast: ${elapsed}ms`)
})

test('a step waits at most the pass budget on a hung worker', { skip, timeout: 30_000 }, async () => {
  const w = await threeBig()
  // the worker answers nothing: the per-call deadline is the remaining budget, not the (long) timeoutMs
  const client = new EngineClient(slowSpawn(() => undefined) as never, { timeoutMs: 60_000, startupMs: 0 })
  const t0 = Date.now()
  const outcome = await shortenPass({ session: w.session, meter: w.meter, client, header: undefined, activationTokens: 0, options })
  const elapsed = Date.now() - t0
  await client.dispose()
  assert.ok(elapsed < PASS_BUDGET_MS + 800, `a hung worker is bounded by the budget: ${elapsed}ms`)
  assert.notEqual(outcome.kind, 'applied', 'nothing is written on misses')
})

test('a step waits at most the pass budget on a sleeping worker', { skip, timeout: 30_000 }, async () => {
  const w = await threeBig()
  // every answer arrives after 8s: in-flight requests are dropped at the budget
  const client = new EngineClient(slowSpawn((parsed, worker) => {
    setTimeout(() => worker.line({ id: parsed.id, ok: true, result: { text: 'short', confidence: 0.9, fail_open: false } }), 8_000)
  }) as never, { timeoutMs: 60_000, startupMs: 0 })
  const t0 = Date.now()
  const outcome = await shortenPass({ session: w.session, meter: w.meter, client, header: undefined, activationTokens: 0, options })
  const elapsed = Date.now() - t0
  await client.dispose()
  assert.ok(elapsed < PASS_BUDGET_MS + 800, `a sleeping worker is bounded by the budget: ${elapsed}ms`)
  assert.notEqual(outcome.kind, 'applied', 'nothing is written on misses')
})
