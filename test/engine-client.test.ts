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

test('requests are sent one at a time, so a slow one cannot fail the ones queued behind it', async () => {
  let inFlight = 0
  let peak = 0
  const worker = fake((request, push) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    setTimeout(() => {
      inFlight--
      push(ok(request.id, compressed))
    }, 30)
  })
  const client = new EngineClient(() => worker.process, { timeoutMs: 100, startupMs: 0 })
  const results = await Promise.all([1, 2, 3, 4].map(() => client.compress({ text: 'x', query: 'q' })))
  assert.equal(peak, 1)
  assert.ok(results.every(result => result?.text === 'short'), 'four 30 ms requests all finish under a 100 ms deadline each')
  await client.dispose()
})

test('after repeated failures the engine rests, then is tried again', async () => {
  let clock = 0
  let starts = 0
  const bad = () => fake()
  const good = fake((request, push) => push(ok(request.id, compressed)))
  const client = new EngineClient(() => (starts++ < 3 ? bad().process : good.process), { timeoutMs: 5, startupMs: 0, maxFailures: 3, cooldownMs: 1000, now: () => clock })
  for (let i = 0; i < 3; i++) assert.equal(await client.compress({ text: 'x', query: 'q' }), undefined)
  assert.equal(client.status().state, 'disabled')
  assert.equal(await client.compress({ text: 'x', query: 'q' }), undefined, 'resting: no new worker is started')
  assert.equal(starts, 3)
  clock = 1500
  assert.equal((await client.compress({ text: 'x', query: 'q' }))?.text, 'short')
  assert.equal(client.status().state, 'running')
  await client.dispose()
})

test('a reply with a null id (a line the worker could not read) fails only the request in flight, at once', async () => {
  const worker = fake((_request, push) => push(JSON.stringify({ id: null, ok: false, error: 'too_large' })))
  const client = new EngineClient(() => worker.process, { timeoutMs: 5000, startupMs: 0 })
  const started = Date.now()
  assert.equal(await client.compress({ text: 'x', query: 'q' }), undefined)
  assert.ok(Date.now() - started < 1000, 'it did not wait out the deadline')
  assert.equal(worker.killed(), false, 'the worker is kept')
  await client.dispose()
})

test('a big text gets a longer deadline, so a healthy worker is not killed for a large result', async () => {
  const worker = fake((request, push) => {
    setTimeout(() => push(ok(request.id, compressed)), 60)
  })
  const client = new EngineClient(() => worker.process, { timeoutMs: 20, startupMs: 0 })
  assert.equal((await client.compress({ text: 'x'.repeat(200_000), query: 'q' }))?.text, 'short', '200,000 characters earn four extra seconds')
  assert.equal(worker.killed(), false)
  await client.dispose()
})

test('after the rest the engine gets one trial: a single failure rests it again at once', async () => {
  let clock = 0
  let starts = 0
  const client = new EngineClient(() => (starts++, fake().process), { timeoutMs: 5, startupMs: 0, maxFailures: 3, cooldownMs: 1000, now: () => clock })
  for (let i = 0; i < 3; i++) await client.compress({ text: 'x', query: 'q' })
  assert.equal(client.status().state, 'disabled')
  clock = 1500
  await client.compress({ text: 'x', query: 'q' })
  assert.equal(starts, 4, 'one trial was made')
  assert.equal(client.status().state, 'disabled', 'and its failure rested the engine again')
  await client.compress({ text: 'x', query: 'q' })
  assert.equal(starts, 4, 'no second trial before the next rest ends')
})

test('a late reply from a worker that was killed is not taken for the answer to the next request', async () => {
  let starts = 0
  let pushFromFirst: (line: string) => void = () => {}
  const first = fake((_request, push) => { pushFromFirst = push })
  const second = fake((request, push) => {
    setTimeout(() => push(ok(request.id, compressed)), 40)
  })
  const client = new EngineClient(() => (starts++ === 0 ? first.process : second.process), { timeoutMs: 80, startupMs: 0 })
  assert.equal(await client.compress({ text: 'x', query: 'q' }), undefined, 'the first worker is silent and is dropped')
  const next = client.compress({ text: 'x', query: 'q' })
  await new Promise(resolve => setTimeout(resolve, 10))
  pushFromFirst(JSON.stringify({ id: null, ok: false, error: 'too_large' }))
  assert.equal((await next)?.text, 'short', 'the stale line did not fail the request now in flight')
  await client.dispose()
})
