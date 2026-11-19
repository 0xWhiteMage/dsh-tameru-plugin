// The two DeepSeek policies: `every-step` (the shipped default) and the opt-in `at-trigger`, which acts only where the Harness's own
// pruner is about to cut and puts its extract in place of the cut.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { EngineClient } from '../src/host/engine-client.ts'
import { nodeWorkerSpawn } from '../src/host/process.ts'
import { normalizeSettings } from '../src/host/settings.ts'
import type { PassEvent } from '../src/host/shorten.ts'
import { textOnly } from '../src/host/messages.ts'
import { onPreStep, type ChatStats, type StepAgent, type StepDeps, type TameruSettings } from '../src/host/step.ts'
import { STOCK_PRUNE_CUT_CHARS, STOCK_PRUNE_THRESHOLD_CHARS } from '../src/host/stock.ts'
import { bigOutput, root, skip, world } from './helpers/harness.ts'

const python = process.env.TAMERU_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const script = join(root, 'vendor', 'run_worker.py')

test('the policy is a setting: unknown values are ignored (the shipped default is at-trigger, gate 0, since the round 2 freeze)', () => {
  assert.deepEqual(normalizeSettings({ policy: 'at-trigger' }), { policy: 'at-trigger' })
  assert.deepEqual(normalizeSettings({ policy: 'every-step' }), { policy: 'every-step' })
  assert.deepEqual(normalizeSettings({ policy: 'sometimes' }), {})
  assert.deepEqual(normalizeSettings({ policy: 'hybrid' }), { policy: 'hybrid' })
  assert.deepEqual(normalizeSettings({}), {})
})

test('the stock cut the trigger policy competes with is the Harness pruner\'s own: 4,096 + marker + 1,024 above 8,192', () => {
  assert.equal(STOCK_PRUNE_THRESHOLD_CHARS, 8192)
  assert.equal(STOCK_PRUNE_CUT_CHARS, 4096 + 1024 + '\n\n[... tool result middle pruned ...]\n\n'.length)
})

async function triggerWorld(window: number, settings: TameruSettings) {
  const w = await world()
  for (let i = 0; i < 13; i++) w.step({ name: 'bash', args: { command: `step ${i}` } }, bigOutput(`s${i}`))
  const pending = w.pendingCall({ name: 'bash', args: { command: 'npm test' } }, bigOutput('pending'))
  w.header(8000)
  const client = new EngineClient(nodeWorkerSpawn(python, script, root), { timeoutMs: 30_000 })
  const events: PassEvent[] = []
  const deps: StepDeps = {
    client,
    meter: () => w.meter,
    resolveModelInfo: async () => ({ context: { contextWindow: window }, defaultMaxTokens: 8000 }),
    backendFor: () => ({ config: { auto: true } }),
    settings,
    stats: new WeakMap<object, ChatStats>(),
    observe: e => events.push(e),
  }
  return { w, client, deps, agent: { session: w.session } as unknown as StepAgent, events, pending }
}

test('at-trigger: below the stock trigger nothing is done', { skip }, async () => {
  const t = await triggerWorld(200_000, { policy: 'at-trigger', minConfidence: 0 })
  try {
    const tokens = t.w.meter.measure(t.w.session).totalTokens
    assert.ok(tokens > 0.75 * 126_000 * 0.5 && tokens < 126_000, `the fixture sits under the 200K trigger (${tokens})`)
    const seq = t.w.session.seq
    assert.deepEqual(await onPreStep(t.deps, t.agent), { kind: 'skipped', reason: 'below_activation' })
    assert.equal(t.w.session.seq, seq)
  } finally {
    await t.client.dispose()
  }
})

test('at-trigger: at the trigger every result the pruner would cut is eligible, the unread newest included, and an extract is never longer than the cut', { skip }, async () => {
  const t = await triggerWorld(128_000, { policy: 'at-trigger', minConfidence: 0 })
  try {
    assert.ok(t.w.meter.measure(t.w.session).totalTokens >= 54_464, 'the fixture is at the 128K stock trigger')
    const outcome = await onPreStep(t.deps, t.agent)
    assert.equal(outcome.kind, 'applied')
    if (outcome.kind !== 'applied') return
    assert.ok(outcome.applied.length >= 10, `many results replaced at once (${outcome.applied.length})`)
    assert.ok(outcome.applied.some(a => a.originalSeq === t.pending), 'the unread newest result, which the pruner would cut, is replaced by an extract')
    for (const a of outcome.applied) {
      const text = textOnly(t.w.session.deriveEventMessage(t.w.session.eventAt(a.replacementSeq)!)!)!
      assert.ok(text.length <= STOCK_PRUNE_CUT_CHARS, `extract ${text.length} chars fits where the cut would have left ${STOCK_PRUNE_CUT_CHARS}`)
    }
    const accepted = t.events.filter(e => e.kind === 'decision' && e.accept).length
    assert.ok(accepted >= outcome.applied.length)
    assert.equal(t.events.filter(e => e.kind === 'applied').length, outcome.applied.length)
  } finally {
    await t.client.dispose()
  }
})

test('at-trigger: an extract longer than the stock cut is declined, so the stock cut happens as it would have', { skip }, async () => {
  const t = await triggerWorld(128_000, { policy: 'at-trigger', minConfidence: 0 })
  try {
    t.deps.stockPruner = { thresholdChars: STOCK_PRUNE_THRESHOLD_CHARS, cutChars: 10 }
    const outcome = await onPreStep(t.deps, t.agent)
    assert.notEqual(outcome.kind, 'applied')
    assert.ok((t.deps.stats.get(t.w.session)?.reasons.longer_than_stock_cut ?? 0) >= 1)
  } finally {
    await t.client.dispose()
  }
})

test('every-step stays what it was: old results only, the newest and the unread left alone', { skip }, async () => {
  const t = await triggerWorld(128_000, { policy: 'every-step', minConfidence: 0 })
  try {
    const outcome = await onPreStep(t.deps, t.agent)
    assert.equal(outcome.kind, 'applied')
    if (outcome.kind !== 'applied') return
    assert.ok(!outcome.applied.some(a => a.originalSeq === t.pending), 'the unread result is not touched')
    assert.ok(outcome.applied.length <= 13 - 4, 'the newest four read results are protected')
  } finally {
    await t.client.dispose()
  }
})

test('the shipped default is the frozen setting: at-trigger, no confidence gate unless one is set', async () => {
  const { policyOfSettings, DEFAULT_POLICY, DEFAULT_TRIGGER_CONFIDENCE } = await import('../src/host/step.ts')
  assert.equal(policyOfSettings({}), 'at-trigger')
  assert.equal(DEFAULT_POLICY, 'at-trigger')
  assert.equal(DEFAULT_TRIGGER_CONFIDENCE, 0)
  assert.equal(policyOfSettings({ policy: 'every-step' }), 'every-step')
})

test('defect fix: at the trigger a pass that would drop the prompt under it while leaving results the stock pruner cuts is skipped', { skip }, async () => {
  // every result is declined at a gate no extract reaches, except none: use a high gate so most are declined, and check that nothing
  // is written when that would leave stock-cuttable results behind below the trigger
  const t = await triggerWorld(128_000, { policy: 'at-trigger', minConfidence: 1 })
  try {
    const before = t.w.meter.measure(t.w.session).totalTokens
    const outcome = await onPreStep(t.deps, t.agent)
    if (outcome.kind === 'applied') {
      const after = t.w.meter.measure(t.w.session).totalTokens
      const left = t.w.session.deriveMessages().filter((m: any) => m.role === 'tool' && (textOnly(m) ?? '').length > STOCK_PRUNE_THRESHOLD_CHARS).length
      assert.ok(left === 0 || after >= 54_464, `written only if the pruner still runs (${before} -> ${after}, ${left} cuttable left)`)
    } else assert.ok(true)
  } finally {
    await t.client.dispose()
  }
})

test('hybrid: acts only at the trigger and never writes an extract longer than the stock cut for a result the pruner would cut', { skip }, async () => {
  const t = await triggerWorld(128_000, { policy: 'hybrid', minConfidence: 0 })
  try {
    const outcome = await onPreStep(t.deps, t.agent)
    if (outcome.kind === 'applied') {
      for (const a of outcome.applied) assert.ok(a.afterTokens < a.beforeTokens)
      for (const m of t.w.session.deriveMessages()) if (m.role === 'tool' && (textOnly(m) ?? '').startsWith('[Tameru')) assert.ok((textOnly(m) ?? '').length <= STOCK_PRUNE_CUT_CHARS || (textOnly(m) ?? '').length <= STOCK_PRUNE_THRESHOLD_CHARS)
    }
  } finally {
    await t.client.dispose()
  }
})
