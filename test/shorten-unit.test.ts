import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KEPT_PREFIX, RESTORED_PREFIX, type Message, type SessionEvent } from '../src/host/messages.ts'
import { DEFAULT_SHORTEN, compactionOpen, findCandidates, readSurface, shortenPass, type PassContext, type SessionLike } from '../src/host/shorten.ts'
import type { CompressRequest, CompressResult } from '../src/shared/protocol.ts'

type LogEvent = SessionEvent & { sourceEventSeqs?: number[] }
type AppendOptions = { sourceEventSeqs?: number[]; surfaceOp?: { op: 'replace'; startSeq: number; endSeq: number } }

function log() {
  const events: LogEvent[] = []
  const nodes: number[] = []
  const session: SessionLike = {
    surface: { nodes, replaceGeneration: 0 },
    get seq() { return events.length },
    eventAt: seq => events[seq],
    deriveEventMessage: event => event.data.message ?? null,
    append(type: any, data?: unknown, options?: unknown): any {
      if (Array.isArray(type)) return type.map(([t, d, o]) => session.append(t, d, o))
      const { sourceEventSeqs, surfaceOp } = (options ?? {}) as AppendOptions
      const event = { seq: events.length, type, data: data as SessionEvent['data'], ...(sourceEventSeqs ? { sourceEventSeqs } : {}) }
      if (surfaceOp) {
        const start = nodes.indexOf(surfaceOp.startSeq)
        const end = nodes.indexOf(surfaceOp.endSeq)
        assert.ok(start >= 0 && end >= start)
        nodes.splice(start, end - start + 1, event.seq)
        session.surface.replaceGeneration++
      } else if (event.data.message) nodes.push(event.seq)
      events.push(event)
      return event
    },
  }
  return { session, events, nodes }
}

const tool = (text: string): Message => ({
  role: 'tool', content: [{ type: 'text', text }], source: { kind: 'tool', name: 'bash', callId: 'build' },
})
const assistant = { role: 'assistant', content: [{ type: 'text', text: 'I read the output.' }] }
const output = 'build line\n'.repeat(200) + 'ERROR: build failed'
const extract: CompressResult = {
  text: 'ERROR: build failed', failOpen: false, sanitized: false, confidence: 0.9,
  originalTokens: 600, keptTokens: 10, tokensSavedPct: 98, risk: null, contentType: 'log', reasons: [],
}

function pass(compress: (request: CompressRequest) => Promise<CompressResult | undefined>) {
  const { session, events, nodes } = log()
  session.append('user/message', { message: { role: 'user', content: [{ type: 'text', text: 'Find the build error.' }] } })
  session.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'build', name: 'bash', arguments: 'npm run build' }] } })
  const result = session.append('tool/result', { message: tool(output) })
  session.append('assistant/message', { message: assistant })
  const estimateMessage = (message: Message) => Math.ceil(message.content.reduce((count, block) => count + (block.text?.length ?? 0), 0) / 4)
  const ctx: PassContext = {
    session,
    meter: {
      measure: () => ({ totalTokens: 1000, nodes: nodes.map(seq => ({ seq, tokens: 500, heuristicTokens: seq === result.seq ? 500 : 20 })) }),
      estimateMessage,
    },
    client: { compress } as PassContext['client'],
    header: {},
    activationTokens: 1000,
    options: { ...DEFAULT_SHORTEN, minResultChars: 1000, protectRecent: 0 },
    declined: new Set(),
  }
  return { ctx, events, result, nodes }
}

test('restored results wait for replies after the restore; held, unread and newest read results are not candidates', () => {
  const { session } = log()
  const kept = session.append('tool/result', { message: tool(output) })
  session.append('tool/result', { message: tool(KEPT_PREFIX + output) }, {
    sourceEventSeqs: [kept.seq], surfaceOp: { op: 'replace', startSeq: kept.seq, endSeq: kept.seq },
  })
  const original = session.append('tool/result', { message: tool(output) })
  session.append('assistant/message', { message: assistant })
  session.append('assistant/message', { message: assistant })
  const restored = session.append('tool/result', { message: tool(RESTORED_PREFIX + output) }, {
    sourceEventSeqs: [original.seq], surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
  })
  session.append('tool/result', { message: tool(output) })
  session.append('assistant/message', { message: assistant })
  session.append('assistant/message', { message: assistant })
  const options = { ...DEFAULT_SHORTEN, minResultChars: 1000, protectRecent: 1 }
  assert.deepEqual(findCandidates(session, readSurface(session), options), [])
  session.append('assistant/message', { message: assistant })
  session.append('tool/result', { message: tool(output) })
  assert.deepEqual(findCandidates(session, readSurface(session), options).map(({ seq, origin, text }) => ({ seq, origin, text })),
    [{ seq: restored.seq, origin: original.seq, text: output }])
})

test('a seed boundary clears an older compaction lock but not a newer one', () => {
  const { session } = log()
  session.append('compaction/start', {})
  assert.equal(compactionOpen(session), true)
  session.append('session/end-seed', {})
  assert.equal(compactionOpen(session), false)
  session.append('compaction/start', {})
  assert.equal(compactionOpen(session), true)
  session.append('compaction/end', {})
  assert.equal(compactionOpen(session), false)
})

test('non-shrinking, sanitized, fail-open and uncertain replies do not rewrite the session or get requested again', async t => {
  const cases = [
    ['non-shrinking', { text: output }, 'no_candidates'],
    ['sanitized', { sanitized: true }, 'no_candidates'],
    ['fail-open', { failOpen: true }, 'no_candidates'],
    ['unknown confidence', { confidence: null }, 'not_confident'],
    ['low confidence', { confidence: DEFAULT_SHORTEN.minConfidence - 0.01 }, 'not_confident'],
  ] as const
  for (const [name, patch, reason] of cases) await t.test(name, async () => {
    let calls = 0
    const { ctx, events, nodes } = pass(async () => { calls++; return { ...extract, ...patch } })
    assert.deepEqual(await shortenPass(ctx), { kind: 'skipped', reason })
    assert.deepEqual(await shortenPass(ctx), { kind: 'skipped', reason: 'no_candidates' })
    assert.equal(calls, 1)
    assert.equal(events.length, 4)
    assert.deepEqual(nodes, [0, 1, 2, 3])
  })
})

test('an unanswered result is retried once, then stops blocking future passes', async () => {
  let calls = 0
  const { ctx, events } = pass(async () => { calls++; return undefined })
  assert.deepEqual(await shortenPass(ctx), { kind: 'skipped', reason: 'engine_unavailable' })
  assert.deepEqual(await shortenPass(ctx), { kind: 'skipped', reason: 'engine_unavailable' })
  assert.deepEqual(await shortenPass(ctx), { kind: 'skipped', reason: 'no_candidates' })
  assert.equal(calls, 2)
  assert.equal(events.length, 4)
})

test('the pass does not ask the engine below activation or during compaction', async () => {
  const { ctx, events } = pass(async () => assert.fail('the engine must not be reached'))
  assert.deepEqual(await shortenPass({ ...ctx, activationTokens: ctx.activationTokens + 1 }), { kind: 'skipped', reason: 'below_activation' })
  ctx.session.append('compaction/start', {})
  assert.deepEqual(await shortenPass(ctx), { kind: 'skipped', reason: 'compaction_open' })
  assert.equal(events.length, 5)
})

test('nonpositive token savings and insufficient savings for the rewritten tail both leave the log untouched', async t => {
  for (const [pricedOutput, tail, reason] of [[10, 20, 'no_candidates'], [500, 2000, 'not_worth_it']] as const) await t.test(reason, async () => {
    const { ctx, result, events, nodes } = pass(async () => extract)
    ctx.meter.measure = () => ({
      totalTokens: 3000,
      nodes: nodes.map(seq => {
        const cost = seq === result.seq ? pricedOutput : tail
        return { seq, tokens: cost, heuristicTokens: cost }
      }),
    })
    assert.deepEqual(await shortenPass(ctx), { kind: 'skipped', reason })
    assert.equal(events.length, 4)
    assert.deepEqual(nodes, [0, 1, 2, 3])
  })
})

test('aborting or changing the surface while a usable answer is in flight leaves the original result intact', async t => {
  for (const [cause, reason] of [['abort', 'aborted'], ['replacement', 'surface_changed'], ['compaction', 'surface_changed']] as const) {
    await t.test(cause, async () => {
      const controller = new AbortController()
      const reply = Promise.withResolvers<CompressResult>()
      const asked = Promise.withResolvers<void>()
      const { ctx, result, events, nodes } = pass(() => { asked.resolve(); return reply.promise })
      const pending = shortenPass({ ...ctx, signal: controller.signal })
      await Promise.race([asked.promise, pending.then(outcome => assert.fail(`expected an engine request, got ${outcome.kind}`))])
      if (cause === 'abort') controller.abort()
      else if (cause === 'replacement') ctx.session.append('assistant/message', { message: assistant }, { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 } })
      else ctx.session.append('compaction/start', {})
      const seq = ctx.session.seq
      reply.resolve(extract)
      assert.deepEqual(await pending, { kind: 'skipped', reason })
      assert.equal(events.length, seq)
      assert.ok(nodes.includes(result.seq))
    })
  }
})

test('an acceptable extract at the activation boundary writes a price event before replacing only the tool output', async () => {
  const requests: CompressRequest[] = []
  const { ctx, events, result, nodes } = pass(async request => {
    requests.push(request)
    return { ...extract, confidence: DEFAULT_SHORTEN.minConfidence }
  })
  const outcome = await shortenPass(ctx)
  assert.deepEqual(requests, [{ text: output, query: 'bash npm run build\nFind the build error.', minSavingsRatio: 0.25 }])
  assert.equal(outcome.kind, 'applied')
  const [price, replacement] = events.slice(result.seq + 2)
  assert.deepEqual(price?.data, { shadowedRange: { start: result.seq, end: result.seq }, shadowedSeqs: [result.seq], shadowedTokenCount: Math.ceil(output.length / 4) })
  assert.equal(price?.type, 'compaction/prune')
  assert.equal(replacement?.type, 'tool/result')
  assert.deepEqual(replacement?.sourceEventSeqs, [result.seq])
  const message = replacement?.data.message
  assert.deepEqual(message?.source, tool(output).source)
  const text = message?.content[0]?.text
  assert.ok(text)
  assert.match(text, new RegExp(`ref=${result.seq}\\]\\nERROR: build failed$`))
  assert.deepEqual(nodes, [0, 1, replacement?.seq, 3])
  const afterTokens = Math.ceil(text.length / 4)
  assert.deepEqual(outcome, {
    kind: 'applied', candidates: 1, freedTokens: 500 - afterTokens,
    applied: [{ originalSeq: result.seq, replacementSeq: replacement?.seq, toolName: 'bash', beforeTokens: 500, afterTokens }],
  })
})
