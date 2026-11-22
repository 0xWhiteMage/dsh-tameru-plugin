import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EngineClient, type WorkerProcess } from '../src/host/engine-client.ts'
import { DEFAULT_SHORTEN, findCandidates, readSurface, shortenPass } from '../src/host/shorten.ts'
import { bigOutput, skip, world } from './helpers/harness.ts'

async function populated() {
  const w = await world()
  const seqs = Array.from({ length: 4 }, (_, i) => w.step({ name: 'bash', args: { command: `run ${i}` } }, bigOutput(`gap${i}`, 8000)).resultSeq)
  const pending = w.pendingCall({ name: 'bash', args: {} }, bigOutput('unread', 8000))
  return { w, seqs, pending }
}

for (const failure of ['crash', 'timeout', 'bad JSON', 'sanitized', 'fail open']) {
  test(`a ${failure} response leaves a real Harness session and token accounting untouched`, { skip }, async () => {
    const { w } = await populated()
    let line: (value: string) => void = () => {}
    let exit = () => {}
    const worker: WorkerProcess = {
      onLine(listener) { line = listener }, onExit(listener) { exit = listener }, kill() { exit() },
      send(value) {
        const request = JSON.parse(value)
        if (request.op !== 'compress') return
        queueMicrotask(() => {
          if (failure === 'crash') exit()
          else if (failure === 'bad JSON') line('{broken')
          else if (failure !== 'timeout') line(JSON.stringify({ id: request.id, ok: true, result: {
            text: 'short', fail_open: failure === 'fail open', sanitized: failure === 'sanitized', confidence: 1,
          } }))
        })
      },
    }
    const client = new EngineClient(() => worker, { timeoutMs: 10, startupMs: 0 })
    try {
      const before = { seq: w.session.seq, nodes: [...w.session.surface.nodes], messages: w.session.deriveMessages(), tokens: w.meter.measure(w.session) }
      const outcome = await shortenPass({ session: w.session, meter: w.meter, client, activationTokens: 0, header: undefined, options: { ...DEFAULT_SHORTEN, protectRecent: 0, maxPerPass: 1 } })
      assert.deepEqual(outcome, { kind: 'skipped', reason: failure === 'sanitized' || failure === 'fail open' ? 'no_candidates' : 'engine_unavailable' })
      assert.deepEqual({ seq: w.session.seq, nodes: [...w.session.surface.nodes], messages: w.session.deriveMessages(), tokens: w.meter.measure(w.session) }, before)
      if (failure === 'timeout' || failure === 'bad JSON') assert.equal(client.status().lastError, 'timeout')
      if (failure === 'crash') assert.equal(client.status().lastError, 'worker_exited')
    } finally {
      await client.dispose()
      await w.ctx.fiber.dispose()
    }
  })
}

test('protected-recent boundaries on real session events never include unread output', { skip }, async () => {
  const { w, seqs, pending } = await populated()
  try {
    const entries = readSurface(w.session)
    for (const protectRecent of [0, 2, 20]) {
      const candidates = findCandidates(w.session, entries, { ...DEFAULT_SHORTEN, protectRecent })
      assert.deepEqual(candidates.map(candidate => candidate.seq), seqs.slice(0, Math.max(0, seqs.length - protectRecent)))
      assert.ok(candidates.every(candidate => candidate.seq !== pending))
    }
  } finally {
    await w.ctx.fiber.dispose()
  }
})

test('empty Harness session yields no candidates without starting the engine', { skip }, async () => {
  const w = await world()
  let spawns = 0
  const client = new EngineClient(() => { spawns++; throw new Error('unexpected worker startup') })
  try {
    assert.deepEqual(await shortenPass({ session: w.session, meter: w.meter, client, activationTokens: 0, header: undefined, options: DEFAULT_SHORTEN }), { kind: 'skipped', reason: 'no_candidates' })
    assert.equal(spawns, 0, 'no tool output means no worker')
  } finally {
    await client.dispose()
    await w.ctx.fiber.dispose()
  }
})

test('share threshold rejects a rewrite before any events are appended and a lower threshold admits it', { skip }, async () => {
  const { w } = await populated()
  let line: (value: string) => void = () => {}
  const client = new EngineClient(() => ({
    onLine(listener) { line = listener }, onExit() {}, kill() {},
    send(value) {
      const request = JSON.parse(value)
      if (request.op === 'compress') queueMicrotask(() => line(JSON.stringify({ id: request.id, ok: true, result: { text: 'ERROR preserved', fail_open: false, confidence: 1 } })))
    },
  }))
  try {
    const seq = w.session.seq
    const pass = { session: w.session, meter: w.meter, client, activationTokens: 0, header: undefined }
    assert.deepEqual(await shortenPass({ ...pass, options: { ...DEFAULT_SHORTEN, share: 1, protectRecent: 0 } }), { kind: 'skipped', reason: 'not_worth_it' })
    assert.equal(w.session.seq, seq)
    const outcome = await shortenPass({ ...pass, options: { ...DEFAULT_SHORTEN, share: 0, protectRecent: 0 } })
    assert.equal(outcome.kind, 'applied')
    assert.ok(w.session.seq > seq)
  } finally {
    await client.dispose()
    await w.ctx.fiber.dispose()
  }
})
