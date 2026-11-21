// `policy: 'plan'`: the host builds one `plan` request over the stock pruner's whole cut set, and applies what the engine
// plans — an extract or the byte-identical stock stub — so nothing stock would cut is left behind.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { EngineClient } from '../src/host/engine-client.ts'
import { nodeWorkerSpawn } from '../src/host/process.ts'
import { planPass, type PlanClient, type PlanPassContext } from '../src/host/plan.ts'
import { STOCK_PRUNE_DEFAULTS, measureContent, pruneContent, stockKeptChars } from '../src/host/stub.ts'
import { SHORTENED_PREFIX, textOnly, type Message } from '../src/host/messages.ts'
import type { PlanReply, PlanRequest } from '../src/shared/protocol.ts'
import { bigOutput, root, skip, world } from './helpers/harness.ts'

const python = process.env.TAMERU_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const script = join(root, 'vendor', 'run_worker.py')
const newClient = (): EngineClient => new EngineClient(nodeWorkerSpawn(python, script, root), { timeoutMs: 60_000 })

const extractBody = {
  text: 'EXTRACT: the short answer to what the result held',
  fail_open: false,
  original_tokens: 5000,
  kept_tokens: 40,
  tokens_saved_pct: 99,
  risk: 'low',
  confidence: 0.9,
  content_type: 'text',
  reasons: [],
  sanitized: false,
  fact_lines_dropped: 0,
}

const ev = { priceProfile: 'deepseek-v4-pro', strength: 'normal' as const }
const base = (w: Awaited<ReturnType<typeof world>>, over: Partial<PlanPassContext> = {}): PlanPassContext => ({
  session: w.session,
  meter: w.meter,
  client: over.client as PlanClient,
  header: undefined,
  activationTokens: 0,
  stockPruner: STOCK_PRUNE_DEFAULTS,
  ev,
  ...over,
})

/** A client that answers `compress` with `result` and captures each `plan` request, replying per `actionFor`. */
function fake(result: Record<string, unknown> | undefined, actionFor: (item: any) => string | undefined): { client: PlanClient; plans: PlanRequest[] } {
  const plans: PlanRequest[] = []
  const client: PlanClient = {
    speaksV2: async () => true,
    speaksV3: async () => true,
    compress: async () => (result === undefined ? undefined : { ...result, dropped: [] } as any),
    plan: async request => {
      plans.push(request)
      const actions = request.items.map(item => ({ id: item.id, event: 'trigger', action: actionFor(item) ?? 'stub', reason: 'for_test', pHat: null, V: null, L: null })) as PlanReply['actions']
      return { event: 'trigger', hostMode: 'prune', acted: true, gate: 'acted', actions, predictedCharsAfter: 0, predictedCharsStock: 0, predictedV: 0, predictedL: 0 }
    },
  }
  return { client, plans }
}

/** A session with two over-threshold results, a short one, and an unread over-threshold result. */
async function planSession() {
  const w = await world()
  const seqs: number[] = []
  seqs.push(w.step({ name: 'bash', args: { command: 'first' } }, bigOutput('first', 20_000)).resultSeq)
  seqs.push(w.step({ name: 'bash', args: { command: 'short' } }, 'a short result').resultSeq)
  seqs.push(w.step({ name: 'bash', args: { command: 'second' } }, bigOutput('second', 15_000)).resultSeq)
  const pending = w.pendingCall({ name: 'bash', args: { command: 'unread' } }, bigOutput('unread', 10_000))
  return { w, seqs, pending }
}

test('the request lists every tool result, cut items carry their stock fate and candidate', { skip }, async () => {
  const { w, seqs, pending } = await planSession()
  const { client, plans } = fake(extractBody, item => (item.candidate ? 'extract' : 'stub'))
  const promptBefore = w.meter.measure(w.session).totalTokens
  const outcome = await planPass(base(w, { client, activationTokens: 1, stepsSinceLastAct: 7, meanStepTokens: 3000 }))
  assert.equal(outcome.kind, 'applied')
  assert.equal(plans.length, 1)
  const request = plans[0]!
  assert.equal(request.event, 'trigger')
  assert.equal(request.hostMode, 'prune')
  assert.equal(request.triggerTokens, 1)
  assert.equal(request.promptTokens, promptBefore)
  assert.equal(request.K, 3)
  assert.equal(request.H, 0)
  assert.equal(request.stepsSinceLastAct, 7)
  assert.deepEqual(request.cache, { warm: false, nEff: request.cache.nEff })
  assert.ok(request.cache.nEff >= 0 && request.cache.nEff <= 200)
  assert.deepEqual(request.policy, { maxRisk: 'high', allowSanitized: false, minSavedRatio: 0, minTokensSaved: 1, ev: { priceProfile: 'deepseek-v4-pro', lossProfile: 'replay-2026-11-21', strength: 'normal' } })
  assert.equal(request.items.length, 4, 'every tool result is an item')
  const byId = new Map(request.items.map(item => [item.id, item]))
  const keptChars = stockKeptChars()
  for (const item of request.items) {
    if (item.stockAction === 'cut') {
      assert.equal(item.stockKeptChars, keptChars, item.id)
      assert.ok(item.chars > STOCK_PRUNE_DEFAULTS.thresholdChars, item.id)
    } else {
      assert.equal(item.stockAction, 'keep')
      assert.equal(item.stockKeptChars, undefined)
      assert.equal(item.candidate, undefined)
    }
    assert.equal(item.stratum, 'deepseek')
  }
  // the extract the engine answered for is the candidate, priced in the stock-cut budget; the short result is a keep item
  for (const [i, seq] of seqs.entries()) {
    const item = byId.get(`${seq}:${measureContent(w.session.deriveEventMessage(w.session.eventAt(seq)!).content as any)}`)
    assert.ok(item, `item for seq ${seq}`)
    if (i === 1) {
      assert.equal(item!.stockAction, 'keep', 'the short result stock would not cut')
      continue
    }
    assert.equal(item!.stockAction, 'cut')
    assert.ok(item!.candidate !== null && item!.candidate !== undefined)
    assert.equal(item!.candidate!.compressedChars > 0, true)
    assert.equal(item!.candidate!.risk, 'low')
    assert.equal(item!.candidate!.confidence, 0.9)
    assert.ok(item!.candidate!.compressedChars <= keptChars, 'the extract fits the stock cut')
  }
  await w.ctx.fiber.dispose()
})

test('an act covers the whole cut set: extracts where planned, byte-identical stubs elsewhere', { skip }, async () => {
  const { w, seqs } = await planSession()
  // the engine's plan: first result extracts, the others stub (declined extract, uncovered is impossible)
  const originals = new Map<number, Message>()
  for (const seq of [...seqs]) {
    const event = w.session.eventAt(seq)!
    originals.set(seq, w.session.deriveEventMessage(event)!)
  }
  let tookExtract = false
  const { client, plans } = fake(extractBody, (item) => {
    if (item.candidate && !tookExtract) {
      tookExtract = true
      return 'extract'
    }
    return 'stub'
  })
  const events: Array<{ kind: string; reason?: string }> = []
  const outcome = await planPass(base(w, { client, activationTokens: 1, observe: e => events.push(e) }))
  assert.equal(outcome.kind, 'applied')
  if (outcome.kind !== 'applied') return
  assert.equal(outcome.applied.length, 3, 'all three over-threshold results were replaced')
  // nothing stock would cut is left uncut: no over-threshold result remains on the surface
  for (const seq of w.session.surface.nodes) {
    const event = w.session.eventAt(seq)!
    if (event.type !== 'tool/result') continue
    const chars = measureContent(w.session.deriveEventMessage(event)!.content as any)
    assert.ok(chars <= STOCK_PRUNE_DEFAULTS.thresholdChars, `seq ${seq} left over the threshold`)
  }
  // every replacement is preceded by its own price event and cites its result, as the ordinary pass writes
  for (const applied of outcome.applied) {
    assert.equal(w.session.eventAt(applied.replacementSeq - 1)!.type, 'compaction/prune')
  }
  // the stub is byte-identical to what the stock pruner writes for the same original
  let extracts = 0
  let stubs = 0
  for (const applied of outcome.applied) {
    const replacement = w.session.deriveEventMessage(w.session.eventAt(applied.replacementSeq)!)!
    const text = textOnly(replacement) ?? ''
    if (text.startsWith(SHORTENED_PREFIX)) {
      extracts++
      continue
    }
    stubs++
    const original = [...originals.entries()].find(([seq]) => applied.originalSeq === seq)?.[1]
    if (!original) continue // the unread pending result: its original was not snapshotted, still a stub by the marker
    assert.deepEqual(replacement.content, pruneContent(original.content as any, STOCK_PRUNE_DEFAULTS))
    assert.ok(text.includes('[... tool result middle pruned ...]'))
  }
  assert.equal(extracts, 1)
  assert.equal(stubs, 2)
  assert.ok(!events.some(e => e.reason === 'uncovered'), 'no coverage violation')
  assert.ok(plans[0]!.items.every(item => item.stockAction === 'cut' || item.stockAction === 'keep'))
  await w.ctx.fiber.dispose()
})

test('a gate that stands the plan down writes nothing', { skip }, async () => {
  const { w } = await planSession()
  const client: PlanClient = {
    speaksV2: async () => true,
    speaksV3: async () => true,
    compress: async () => ({ ...extractBody, dropped: [] } as any),
    plan: async () => ({ event: 'trigger', hostMode: 'prune', acted: false, gate: 'hysteresis', actions: [], predictedCharsAfter: 0, predictedCharsStock: 0, predictedV: 0, predictedL: 0 }),
  }
  const before = [...w.session.surface.nodes]
  const outcome = await planPass(base(w, { client, activationTokens: 1, stepsSinceLastAct: 0 }))
  assert.equal(outcome.kind, 'skipped')
  assert.deepEqual([...w.session.surface.nodes], before, 'nothing was written')
  await w.ctx.fiber.dispose()
})

test('below the stock trigger and a worker without protocol 3 both leave the session alone', { skip }, async () => {
  const { w } = await planSession()
  const { client, plans } = fake(extractBody, () => 'stub')
  const below = await planPass(base(w, { client, activationTokens: 10_000_000 }))
  assert.equal(below.kind, 'skipped')
  if (below.kind === 'skipped') assert.equal(below.reason, 'below_activation')
  assert.equal(plans.length, 0)
  const old = { speaksV3: async () => false, speaksV2: async () => true, compress: async () => { throw new Error('must not be asked') } }
  const outcome = await planPass(base(w, { client: old as unknown as PlanClient, activationTokens: 1 }))
  assert.equal(outcome.kind, 'skipped')
  if (outcome.kind === 'skipped') assert.equal(outcome.reason, 'engine_unavailable')
  await w.ctx.fiber.dispose()
})

test('a fail-open answer still rides as a candidate so the plan names the stub reason', { skip }, async () => {
  const { w } = await planSession()
  const { client, plans } = fake({ ...extractBody, text: 'x'.repeat(30_000), failOpen: true }, () => 'stub')
  const outcome = await planPass(base(w, { client, activationTokens: 1 }))
  assert.equal(outcome.kind, 'applied')
  assert.equal(plans.length, 1)
  let failOpen = 0
  for (const item of plans[0]!.items) {
    if (item.stockAction !== 'cut' || !item.candidate) continue
    failOpen++
    assert.equal(item.candidate.failOpen, true, 'the fail-open answer is the candidate, not a host-side decline')
    assert.equal(item.candidate.tokensSaved, 0, 'a non-shrinking answer saves nothing on the wire')
    assert.ok(item.candidate.compressedChars > stockKeptChars(), 'the unshortened text does not fit the stock cut')
  }
  assert.ok(failOpen > 0, 'the fail-open answers were sent as candidates')
  await w.ctx.fiber.dispose()
})

test('the real engine covers the whole cut set at the trigger', { skip }, async () => {
  const { w } = await planSession()
  const client = newClient()
  try {
    const outcome = await planPass(base(w, { client, activationTokens: 1 }))
    assert.equal(outcome.kind, 'applied')
    if (outcome.kind !== 'applied') return
    for (const seq of w.session.surface.nodes) {
      const event = w.session.eventAt(seq)!
      if (event.type !== 'tool/result') continue
      assert.ok(measureContent(w.session.deriveEventMessage(event)!.content as any) <= STOCK_PRUNE_DEFAULTS.thresholdChars, `seq ${seq} left over the threshold`)
    }
    assert.equal(outcome.applied.length, 3)
  } finally {
    await client.dispose()
    await w.ctx.fiber.dispose()
  }
})
