import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { EngineClient } from '../src/host/engine-client.ts'
import { nodeWorkerSpawn } from '../src/host/process.ts'
import { DEFAULT_SHORTEN, chooseBatch, findCandidates, shortenPass, type Entry, type Planned, type ReadyAnswer, type ShortenOptions } from '../src/host/shorten.ts'
import { alreadyShortened, buildQuery, hasSpillNotice, textOnly } from '../src/host/messages.ts'
import { bigOutput, root, skip, world } from './helpers/harness.ts'

const python = process.env.TAMERU_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const script = join(root, 'vendor', 'run_worker.py')
const options: ShortenOptions = { ...DEFAULT_SHORTEN, protectRecent: 2, minResultChars: 6000 }
const newClient = (): EngineClient => new EngineClient(nodeWorkerSpawn(python, script, root), { timeoutMs: 30_000 })

/** Eight read steps, then a ninth call whose result the model has not read. */
async function longSession() {
  const w = await world()
  const seqs: number[] = []
  for (let i = 0; i < 8; i++) seqs.push(w.step({ name: 'bash', args: { command: `run step ${i}` } }, bigOutput(`s${i}`)).resultSeq)
  const pending = w.pendingCall({ name: 'bash', args: { command: 'npm test' } }, bigOutput('pending'))
  return { w, seqs, pending }
}

const sumTokens = (w: Awaited<ReturnType<typeof world>>): number => w.session.deriveMessages().reduce((sum: number, m: any) => sum + w.meter.estimateMessage(m), 0)

test('old large results are shortened, errors survive, the unread and newest results are untouched', { skip }, async () => {
  const { w, seqs, pending } = await longSession()
  const client = newClient()
  try {
    const before = w.meter.measure(w.session)
    const outcome = await shortenPass({ session: w.session, meter: w.meter, client, header: undefined, activationTokens: 0, options })
    assert.equal(outcome.kind, 'applied')
    if (outcome.kind !== 'applied') return
    assert.ok(outcome.applied.length >= 1)
    const surface = new Set(w.session.surface.nodes)
    const messages = w.session.deriveMessages()
    const texts = messages.filter((m: any) => m.role === 'tool').map((m: any) => textOnly(m) ?? '')
    // each replaced result: header present, the distinctive error line kept, much shorter
    for (const applied of outcome.applied) {
      assert.ok(!surface.has(applied.originalSeq), 'the original left the surface')
      assert.ok(surface.has(applied.replacementSeq), 'the replacement is on the surface')
      const text = textOnly(w.session.deriveEventMessage(w.session.eventAt(applied.replacementSeq)!)!)!
      assert.ok(alreadyShortened(text))
      assert.match(text, /ERROR s\d: assertion failed at module_s\d\.ts:\d+ expected 3 but was 4/)
      assert.ok(text.length < 6000)
    }
    // the newest two read results and the unread result are exactly as they were
    for (const seq of [seqs[6]!, seqs[7]!, pending]) assert.ok(surface.has(seq), `seq ${seq} must be untouched`)
    assert.equal(texts.filter(t => alreadyShortened(t)).length, outcome.applied.length)
    // the Harness's own meter agrees with a full recount: the price events are right
    const after = w.meter.measure(w.session)
    assert.ok(after.surfaceTokens < before.surfaceTokens)
    assert.equal(after.surfaceTokens, sumTokens(w), 'incremental meter equals a full re-measure')
    assert.equal(messages.length, 2 + 9 * 2 + 0, 'same number of messages as before')
  } finally {
    await client.dispose()
  }
})

test('every replacement is preceded by its own price event and cites the original', { skip }, async () => {
  const { w } = await longSession()
  const client = newClient()
  try {
    const outcome = await shortenPass({ session: w.session, meter: w.meter, client, header: undefined, activationTokens: 0, options })
    assert.equal(outcome.kind, 'applied')
    if (outcome.kind !== 'applied') return
    for (const applied of outcome.applied) {
      const prune = w.session.eventAt(applied.replacementSeq - 1)!
      const replacement = w.session.eventAt(applied.replacementSeq)!
      assert.equal(prune.type, 'compaction/prune')
      assert.deepEqual(prune.data.shadowedSeqs, [applied.originalSeq])
      assert.deepEqual((replacement as any).sourceEventSeqs, [applied.originalSeq])
      assert.deepEqual((replacement as any).surfaceOp, { op: 'replace', startSeq: applied.originalSeq, endSeq: applied.originalSeq })
    }
    // the original is still in the log, byte for byte
    const first = outcome.applied[0]!
    assert.ok(textOnly(w.session.deriveEventMessage(w.session.eventAt(first.originalSeq)!)!)!.length >= 6000)
  } finally {
    await client.dispose()
  }
})

test('nothing happens below the activation point', { skip }, async () => {
  const { w } = await longSession()
  const client = newClient()
  try {
    const seq = w.session.seq
    const outcome = await shortenPass({ session: w.session, meter: w.meter, client, header: undefined, activationTokens: 10_000_000, options })
    assert.deepEqual(outcome, { kind: 'skipped', reason: 'below_activation' })
    assert.equal(w.session.seq, seq, 'nothing was written')
  } finally {
    await client.dispose()
  }
})

test('nothing happens while a compaction is open', { skip }, async () => {
  const { w } = await longSession()
  w.session.append('compaction/start', { compactionId: 'c1', turn: null, source: 'manual' })
  const client = newClient()
  try {
    const seq = w.session.seq
    const outcome = await shortenPass({ session: w.session, meter: w.meter, client, header: undefined, activationTokens: 0, options })
    assert.deepEqual(outcome, { kind: 'skipped', reason: 'compaction_open' })
    assert.equal(w.session.seq, seq)
  } finally {
    await client.dispose()
  }
})

test('errors, already shortened, spilled and stock-pruned results are never touched', { skip }, async () => {
  const w = await world()
  const big = bigOutput('x')
  w.step({ name: 'bash', args: {} }, big, { isError: true })
  w.step({ name: 'bash', args: {} }, `[Tameru: shortened from 99 to 50 characters; the original stays in the session log]\n${big}`)
  w.step({ name: 'bash', args: {} }, `${big.slice(0, 7000)}\n\n(Omitted 5000 bytes. Full formatted result stored at: /tmp/x.txt. read it)`)
  w.step({ name: 'bash', args: {} }, `${big.slice(0, 4000)}\n\n[... tool result middle pruned ...]\n\n${big.slice(-2000)}`)
  w.step({ name: 'bash', args: {} }, 'tiny')
  w.step({ name: 'bash', args: {} }, big)    // eligible
  w.step({ name: 'bash', args: {} }, big)
  w.finish()
  const found = findCandidates(
    w.session,
    w.session.surface.nodes.map(seq => ({ seq, event: w.session.eventAt(seq)!, message: w.session.deriveEventMessage(w.session.eventAt(seq)!)! })) as Entry[],
    { ...options, protectRecent: 1 },
  )
  assert.equal(found.length, 1, 'only the one plain old large result is eligible')
})

test('a result too large for the worker is left as it is', { skip }, async () => {
  const w = await world()
  w.step({ name: 'bash', args: {} }, 'x'.repeat(2_000_001))
  w.step({ name: 'bash', args: {} }, bigOutput('y'))
  w.step({ name: 'bash', args: {} }, bigOutput('z'))
  w.finish()
  const found = findCandidates(
    w.session,
    w.session.surface.nodes.map(seq => ({ seq, event: w.session.eventAt(seq)!, message: w.session.deriveEventMessage(w.session.eventAt(seq)!)! })) as Entry[],
    { ...options, protectRecent: 1 },
  )
  assert.equal(found.length, 1, 'only the ordinary large result is a candidate')
})

test('an engine that is down leaves the session exactly as it was', { skip }, async () => {
  const { w } = await longSession()
  const client = new EngineClient(() => {
    throw new Error('no python')
  })
  const seq = w.session.seq
  const outcome = await shortenPass({ session: w.session, meter: w.meter, client, header: undefined, activationTokens: 0, options })
  assert.deepEqual(outcome, { kind: 'skipped', reason: 'engine_unavailable' })
  assert.equal(w.session.seq, seq)
})

test('a session that changed while the engine worked is left alone', { skip }, async () => {
  const { w, seqs } = await longSession()
  const real = newClient()
  let interfered = false
  const racing = {
    compress: async (request: any) => {
      const result = await real.compress(request)
      if (!interfered) {
        interfered = true
        // someone else (a compaction, another plugin) replaces a node while we were waiting for the engine
        const event = w.session.eventAt(seqs[0]!)!
        w.session.append('compaction/prune', { shadowedRange: { start: seqs[0], end: seqs[0] }, shadowedSeqs: [seqs[0]], shadowedTokenCount: 10 })
        w.session.append('tool/result', { ...event.data, message: { ...event.data.message, content: [{ type: 'text', text: 'someone else was here' }] } }, { surfaceOp: { op: 'replace', startSeq: seqs[0], endSeq: seqs[0] }, sourceEventSeqs: [seqs[0]] })
      }
      return result
    },
  } as unknown as EngineClient
  try {
    const seq = w.session.seq
    const outcome = await shortenPass({ session: w.session, meter: w.meter, client: racing, header: undefined, activationTokens: 0, options })
    assert.deepEqual(outcome, { kind: 'skipped', reason: 'surface_changed' })
    assert.equal(w.session.seq, seq + 2, 'we wrote nothing; only the other writer did')
  } finally {
    await real.dispose()
  }
})

test('a change that does not pay for the cache rewrite it causes is not made', { skip }, async () => {
  const { w } = await longSession()
  const client = newClient()
  try {
    const seq = w.session.seq
    const outcome = await shortenPass({ session: w.session, meter: w.meter, client, header: undefined, activationTokens: 0, options: { ...options, share: 0.99 } })
    assert.deepEqual(outcome, { kind: 'skipped', reason: 'not_worth_it' })
    assert.equal(w.session.seq, seq)
  } finally {
    await client.dispose()
  }
})

test('chooseBatch drops early small items so the rewrite stays worth it', () => {
  const order = [0, 1, 2, 3, 4, 5, 6, 7]
  const tokens = new Map(order.map(seq => [seq, 100]))
  const item = (seq: number, freed: number): Planned => ({ candidate: { seq } as any, replacement: {} as any, newText: '', beforeTokens: freed + 10, afterTokens: 10 })
  // together they free 230 of the 700 tokens rewritten from seq 1 (33%, short of 35%); seq 5 alone frees 200 of 300 (67%)
  const chosen = chooseBatch([item(1, 30), item(5, 200)], tokens, order, 0.35)
  assert.deepEqual(chosen.map(i => i.candidate.seq), [5])
  assert.deepEqual(chooseBatch([item(1, 30)], tokens, order, 0.35), [])
  assert.deepEqual(chooseBatch([], tokens, order, 0.35), [])
})

test('the query names the tool call and the user task, and is bounded', () => {
  const messages: any[] = [
    { seq: 1, message: { role: 'user', content: [{ type: 'text', text: 'Why does the checkout fail at 02:17?' }] } },
    { seq: 2, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"grep 502 nginx.log"}' }] } },
    { seq: 3, message: { role: 'tool', content: [{ type: 'text', text: 'x' }], toolCallId: 'c1' } },
  ]
  const query = buildQuery(messages, 2, 'c1')
  assert.match(query, /bash \{"command":"grep 502 nginx\.log"\}/)
  assert.match(query, /checkout fail at 02:17/)
  assert.ok(buildQuery(messages, 2, 'c1', 20).length <= 20)
  assert.equal(hasSpillNotice('a (Omitted 5 bytes. Full formatted result stored at: /x. y)'), true)
  assert.equal(hasSpillNotice('plain'), false)
})

test('an extract the engine is not confident in is never applied', { skip }, async () => {
  const { w } = await longSession()
  const unsure = {
    compress: async (request: any) => ({ text: request.text.slice(0, 500), failOpen: false, originalTokens: 1, keptTokens: 1, tokensSavedPct: 90, risk: 'high', confidence: 0.5, contentType: 'text', reasons: [], sanitized: false }),
  } as unknown as EngineClient
  const seq = w.session.seq
  const outcome = await shortenPass({ session: w.session, meter: w.meter, client: unsure, header: undefined, activationTokens: 0, options })
  assert.deepEqual(outcome, { kind: 'skipped', reason: 'not_confident' })
  assert.equal(w.session.seq, seq, 'nothing was written')
  // the same result at 0.9 confidence is applied, so the gate is the only thing that stopped it
  const sure = { compress: async (request: any) => ({ ...(await unsure.compress(request)), confidence: 0.9 }) } as unknown as EngineClient
  const applied = await shortenPass({ session: w.session, meter: w.meter, client: sure, header: undefined, activationTokens: 0, options })
  assert.equal(applied.kind, 'applied')
})

test('a result the engine declined is not sent to it again at the next step', { skip }, async () => {
  const { w } = await longSession()
  let calls = 0
  const declining = {
    compress: async (request: any) => {
      calls++
      return { text: request.text, failOpen: true, originalTokens: 1, keptTokens: 1, tokensSavedPct: 0, risk: 'low', confidence: 1, contentType: 'text', reasons: [], sanitized: false }
    },
  } as unknown as EngineClient
  const declined = new Set<string>()
  const run = () => shortenPass({ session: w.session, meter: w.meter, client: declining, header: undefined, activationTokens: 0, options, declined })
  await run()
  const first = calls
  assert.ok(first >= 1)
  await run()
  assert.equal(calls, first, 'the second pass asked the engine nothing')
})

test('a kept late answer is used only for the exact text and question it was asked with', { skip }, async () => {
  const { w } = await longSession()
  const answer = (text: string): any => ({ text, failOpen: false, originalTokens: 1, keptTokens: 1, tokensSavedPct: 90, risk: 'low', confidence: 0.9, contentType: 'text', reasons: [], sanitized: false })
  const asked: string[] = []
  const client = { compress: async (request: any) => (asked.push(request.query), answer(request.text.slice(0, 500))) } as unknown as EngineClient
  // every key holds an answer kept for a different question about the same text
  const ready = new (class extends Map<string, ReadyAnswer> {
    override get(): ReadyAnswer {
      return { text: '', query: 'a different question', result: answer('STALE EXTRACT') }
    }
  })()
  const outcome = await shortenPass({ session: w.session, meter: w.meter, client, header: undefined, activationTokens: 0, options, ready })
  assert.equal(outcome.kind, 'applied')
  assert.ok(asked.length >= 1, 'the engine was asked again')
  assert.ok(!JSON.stringify(w.session.deriveMessages()).includes('STALE EXTRACT'), 'the kept answer was not used')
})
