import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EngineClient, type WorkerProcess } from '../src/host/engine-client.ts'

/** A scripted worker: `reply(request)` decides what comes back (a string line), or nothing to stay silent. */
function fake(reply: (request: any, push: (line: string) => void) => void = () => {}): { process: WorkerProcess; killed: () => boolean; die: () => void; sent: any[] } {
  let onLine: (line: string) => void = () => {}
  let onExit: () => void = () => {}
  let killed = false
  const sent: any[] = []
  const process: WorkerProcess = {
    send: line => {
      const request = JSON.parse(line)
      sent.push(request)
      queueMicrotask(() => reply(request, l => onLine(l)))
    },
    onLine: l => (onLine = l),
    onExit: l => (onExit = l),
    kill: () => {
      killed = true
      onExit()
    },
  }
  return { process, killed: () => killed, die: () => onExit(), sent }
}

const ok = (id: number, result: object): string => JSON.stringify({ id, ok: true, result })
const compressed = { text: 'short', fail_open: false, original_tokens: 100, kept_tokens: 5, tokens_saved_pct: 95, risk: 'low', confidence: 0.9, content_type: 'text', reasons: [], sanitized: false }

test('a good reply becomes a typed result', async () => {
  const worker = fake((request, push) => push(ok(request.id, compressed)))
  const client = new EngineClient(() => worker.process)
  const result = await client.compress({ text: 'long', query: 'q', budgetRatio: 0.3 })
  assert.equal(result?.text, 'short')
  assert.equal(result?.failOpen, false)
  assert.equal(result?.tokensSavedPct, 95)
  assert.equal(worker.sent[0].budget_ratio, 0.3)
  assert.equal(worker.sent[0].op, 'compress')
  await client.dispose()
})

test('a silent worker times out, is killed, and the request fails open', async () => {
  const worker = fake()
  const client = new EngineClient(() => worker.process, { timeoutMs: 20 })
  assert.equal(await client.compress({ text: 'x', query: 'q' }), undefined)
  assert.equal(worker.killed(), true)
  assert.equal(client.status().lastError, 'timeout')
})

test('a worker that dies mid-request fails the request open and the next request starts a new worker', async () => {
  let starts = 0
  const first = fake()
  const second = fake((request, push) => push(ok(request.id, compressed)))
  const client = new EngineClient(() => (starts++ === 0 ? first.process : second.process), { timeoutMs: 5000 })
  const pending = client.compress({ text: 'x', query: 'q' })
  await new Promise(resolve => setTimeout(resolve, 5))
  first.die()
  assert.equal(await pending, undefined)
  assert.equal((await client.compress({ text: 'x', query: 'q' }))?.text, 'short')
  assert.equal(starts, 2)
  await client.dispose()
})

test('repeated failures turn the worker off, and reset turns it back on', async () => {
  let starts = 0
  const client = new EngineClient(() => (starts++, fake().process), { timeoutMs: 5, maxFailures: 3 })
  for (let i = 0; i < 3; i++) assert.equal(await client.compress({ text: 'x', query: 'q' }), undefined)
  assert.equal(client.status().state, 'disabled')
  const before = starts
  assert.equal(await client.compress({ text: 'x', query: 'q' }), undefined)
  assert.equal(starts, before, 'a disabled client does not start workers')
  client.reset()
  assert.notEqual(client.status().state, 'disabled')
})

test('failures older than the window do not count', async () => {
  let clock = 0
  const client = new EngineClient(() => fake().process, { timeoutMs: 5, maxFailures: 2, windowMs: 1000, now: () => clock })
  await client.compress({ text: 'x', query: 'q' })
  clock = 5000
  await client.compress({ text: 'x', query: 'q' })
  assert.notEqual(client.status().state, 'disabled')
})

test('a spawn that throws fails open without throwing', async () => {
  const client = new EngineClient(() => {
    throw new Error('no python')
  })
  assert.equal(await client.compress({ text: 'x', query: 'q' }), undefined)
  assert.equal(client.status().lastError, 'spawn_failed')
})

test('garbage, unrelated ids and error replies are ignored or reported, never thrown', async () => {
  const worker = fake((request, push) => {
    push('not json at all')
    push(JSON.stringify({ id: 999, ok: true, result: compressed }))
    push('42')
    push(JSON.stringify({ id: request.id, ok: false, error: 'unknown_field:ccr' }))
  })
  const client = new EngineClient(() => worker.process, { timeoutMs: 1000 })
  assert.equal(await client.compress({ text: 'x', query: 'q' }), undefined)
  assert.equal(client.status().lastError, 'unknown_field:ccr')
  await client.dispose()
})

test('a malformed result is treated as no answer', async () => {
  const worker = fake((request, push) => push(ok(request.id, { text: 5 })))
  const client = new EngineClient(() => worker.process)
  assert.equal(await client.compress({ text: 'x', query: 'q' }), undefined)
  await client.dispose()
})

test('a worker speaking another protocol version is refused', async () => {
  const worker = fake((request, push) => push(ok(request.id, { engine_version: '9', protocol: 99, python: '3.12.0' })))
  const client = new EngineClient(() => worker.process)
  assert.equal(await client.probe(), undefined)
  assert.equal(client.status().lastError, 'protocol_mismatch')
  await client.dispose()
})

test('dispose settles pending requests, asks the worker to end and kills it, and is safe twice', async () => {
  const worker = fake()
  const client = new EngineClient(() => worker.process, { timeoutMs: 60_000 })
  const pending = client.compress({ text: 'x', query: 'q' })
  await new Promise(resolve => setTimeout(resolve, 5))
  await client.dispose()
  assert.equal(await pending, undefined)
  assert.equal(worker.killed(), true)
  assert.ok(worker.sent.some(r => r.op === 'shutdown'))
  await client.dispose()
})

test('a write to a dead worker fails open', async () => {
  const dead: WorkerProcess = {
    send: () => {
      throw new Error('EPIPE')
    },
    onLine: () => {},
    onExit: () => {},
    kill: () => {},
  }
  const client = new EngineClient(() => dead)
  assert.equal(await client.compress({ text: 'x', query: 'q' }), undefined)
  assert.equal(client.status().lastError, 'write_failed')
})
