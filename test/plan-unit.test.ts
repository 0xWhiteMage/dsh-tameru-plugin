// `policy: 'plan'` write path, on a fake session: the price event and its replacement are one atomic commit, so a
// failed write leaves nothing behind — no `compaction/prune` orphan the meter would subtract tokens for.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planPass, type PlanClient, type PlanPassContext } from '../src/host/plan.ts'
import { STOCK_PRUNE_DEFAULTS } from '../src/host/stub.ts'
import { type Message, type SessionEvent } from '../src/host/messages.ts'
import { itemKey, type SessionLike } from '../src/host/shorten.ts'
import { fromWireResult } from '../src/shared/protocol.ts'

type LogEvent = SessionEvent & { sourceEventSeqs?: number[] }
type AppendOptions = { sourceEventSeqs?: number[]; surfaceOp?: { op: 'replace'; startSeq: number; endSeq: number } }

/** A session log whose batch append commits every row or none, like the real one; `failOn` makes writes of a type throw. */
function log() {
  const events: LogEvent[] = []
  const nodes: number[] = []
  let failOn: string | null = null
  const commit = (type: string, data?: unknown, options?: unknown): { seq: number } => {
    if (type === failOn) throw new Error('write failed')
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
  }
  const session: SessionLike & { failOn: (type: string | null) => void } = {
    surface: { nodes, replaceGeneration: 0 },
    get seq() { return events.length },
    eventAt: seq => events[seq],
    deriveEventMessage: event => (event.data as { message?: Message }).message ?? null,
    failOn: type => { failOn = type },
    append(type: any, data?: unknown, options?: unknown): any {
      if (Array.isArray(type)) {
        for (const [t] of type) if (t === failOn) throw new Error('write failed') // stage first: a failure leaves none
        return type.map(([t, d, o]) => commit(t, d, o))
      }
      return commit(type, data, options)
    },
  }
  return { session, events, nodes }
}

const tool = (text: string): Message => ({
  role: 'tool', content: [{ type: 'text', text }], source: { kind: 'tool', name: 'bash', callId: 'build' },
})
const assistant = { role: 'assistant', content: [{ type: 'text', text: 'I read the output.' }] }
const output = 'build line\n'.repeat(2000) // over the stock threshold: stock would cut it

function planWorld() {
  const { session, events, nodes } = log()
  session.append('user/message', { message: { role: 'user', content: [{ type: 'text', text: 'Find the build error.' }] } })
  session.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'build', name: 'bash', arguments: 'npm run build' }] } })
  const result = session.append('tool/result', { message: tool(output) })
  session.append('assistant/message', { message: assistant })
  const client: PlanClient = {
    speaksV3: async () => true,
    compress: async () => undefined, // no candidate: the plan stubs the item
    plan: async request => ({
      event: 'trigger', hostMode: 'prune', acted: true, gate: 'acted',
      actions: request.items.map(item => ({ id: item.id, event: 'trigger', action: 'stub' as const, reason: 'for_test', pHat: null, V: null, L: null })),
      predictedCharsAfter: 0, predictedCharsStock: 0, predictedV: 0, predictedL: 0,
    }),
  }
  const ctx: PlanPassContext = {
    session,
    meter: {
      measure: () => ({ totalTokens: 1000, nodes: nodes.map(seq => ({ seq, tokens: 500, heuristicTokens: seq === result.seq ? 500 : 20 })) }),
      estimateMessage: message => Math.ceil((message.content as Array<{ text?: string }>).reduce((count, block) => count + (block.text?.length ?? 0), 0) / 4),
    },
    client,
    header: undefined,
    activationTokens: 1,
    stockPruner: STOCK_PRUNE_DEFAULTS,
    ev: { priceProfile: 'deepseek-v4-pro', strength: 'normal' },
  }
  return { ctx, session, events, result }
}

test('a failed replacement write leaves no orphan price event', async () => {
  const { ctx, session, events } = planWorld()
  session.failOn('tool/result')
  const outcome = await planPass(ctx)
  assert.equal(outcome.kind, 'skipped')
  assert.ok(!events.some(event => event.type === 'compaction/prune'), 'the price event must not outlive its replacement')
})

test('a written pair lands as price event then replacement, adjacent', async () => {
  const { ctx, events, result } = planWorld()
  const outcome = await planPass(ctx)
  assert.equal(outcome.kind, 'applied')
  if (outcome.kind !== 'applied') return
  assert.equal(outcome.applied.length, 1)
  const pruneAt = events.findIndex(event => event.type === 'compaction/prune')
  assert.ok(pruneAt >= 0)
  assert.equal(events[pruneAt + 1]!.seq, outcome.applied[0]!.replacementSeq)
  assert.equal(outcome.applied[0]!.originalSeq, result.seq)
})

test('the engine\'s negative_ev decision reason survives the wire', () => {
  const result = fromWireResult({ text: 'x', fail_open: true, decision: { accept: false, reason: 'negative_ev', basis: 'p*V<L' } })
  assert.equal(result?.decision?.reason, 'negative_ev')
})

test('the engine\'s malformed decision reason survives the wire', () => {
  const result = fromWireResult({ text: 'x', fail_open: true, decision: { accept: false, reason: 'malformed', basis: 'token counts not numeric' } })
  assert.equal(result?.decision?.reason, 'malformed')
})
