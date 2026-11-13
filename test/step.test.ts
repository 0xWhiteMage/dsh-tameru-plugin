import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { EngineClient } from '../src/host/engine-client.ts'
import { nodeWorkerSpawn } from '../src/host/process.ts'
import { normalizeSettings } from '../src/host/settings.ts'
import { onPreStep, type ChatStats, type StepAgent, type StepDeps } from '../src/host/step.ts'
import { compactionIsManagedElsewhere, policyFor, stockThreshold } from '../src/host/stock.ts'
import { statusText } from '../src/host/status.ts'
import { bigOutput, root, skip, world } from './helpers/harness.ts'

const python = process.env.TAMERU_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const script = join(root, 'vendor', 'run_worker.py')

test('the stock trigger is read the way the Harness backend computes it', () => {
  // README of dsh-compaction-basic: floor(min(W * 0.8, W - O - 65,536))
  assert.equal(stockThreshold({ contextWindow: 128_000, reservedCompletionTokens: 8000 }), 54_464)
  assert.equal(stockThreshold({ contextWindow: 1_000_000, reservedCompletionTokens: 8000 }), 800_000)
  assert.equal(stockThreshold({ contextWindow: 64_000, reservedCompletionTokens: 8000 }), undefined, 'the default headroom does not fit a 64K window')
  assert.equal(stockThreshold({ contextWindow: 64_000, reservedCompletionTokens: 8000, headroomTokens: 4096 }), 51_200)
  assert.equal(stockThreshold({ contextWindow: 0, reservedCompletionTokens: 0 }), undefined)
  assert.equal(stockThreshold({ contextWindow: 100_000, reservedCompletionTokens: -1 }), undefined)
  assert.equal(stockThreshold({ contextWindow: 200_000, reservedCompletionTokens: 0, thresholdRatio: 0.5 }), 100_000)
})

test('a per-model override in the backend wins over its global settings', () => {
  const backend = { config: { thresholdRatio: 0.8, headroomTokens: 65_536, modelPolicies: [{ provider: 'a', model: 'b', thresholdRatio: 0.5, headroomTokens: 1000 }] } }
  assert.deepEqual(policyFor(backend, 'a', 'b'), { thresholdRatio: 0.5, headroomTokens: 1000 })
  assert.deepEqual(policyFor(backend, 'x', 'y'), { thresholdRatio: 0.8, headroomTokens: 65_536 })
  assert.deepEqual(policyFor(undefined, 'x', 'y'), {})
})

test('a backend another plugin has taken over is recognised, and a plain one is not', () => {
  class Plain {
    config = { auto: true }
    compactIfNeeded() {}
  }
  assert.equal(compactionIsManagedElsewhere(new Plain() as any), false, 'prototype methods are the backend itself')
  const taken: any = new Plain()
  taken.compactIfNeeded = () => null
  assert.equal(compactionIsManagedElsewhere(taken), true, 'an own property shadows the backend, as DS Bot does')
  assert.equal(compactionIsManagedElsewhere({ config: { auto: false } }), true)
  assert.equal(compactionIsManagedElsewhere(undefined), false)
})

test('settings out of range or of the wrong type fall back to defaults', () => {
  assert.deepEqual(normalizeSettings({ activation: 0.6, share: 0.4, protectRecent: 3.7, minResultChars: 9000, maxPerPass: 10, shorten: false }), {
    activation: 0.6,
    share: 0.4,
    protectRecent: 3,
    minResultChars: 9000,
    maxPerPass: 10,
    shorten: false,
  })
  assert.deepEqual(normalizeSettings({ minConfidence: 0.5 }), { minConfidence: 0.5 })
  assert.deepEqual(normalizeSettings({ minConfidence: 2 }), {})
  assert.deepEqual(normalizeSettings({ activation: 5, share: 'x', protectRecent: -1, minResultChars: 5, maxPerPass: 0, shorten: 'yes' }), {})
  assert.deepEqual(normalizeSettings(undefined), {})
})

async function stepWorld(options: { window?: number; backend?: any; info?: any } = {}) {
  const w = await world()
  for (let i = 0; i < 8; i++) w.step({ name: 'bash', args: { command: `step ${i}` } }, bigOutput(`s${i}`))
  w.pendingCall({ name: 'bash', args: { command: 'npm test' } }, bigOutput('pending'))
  w.header(8000)
  const client = new EngineClient(nodeWorkerSpawn(python, script, root), { timeoutMs: 30_000 })
  const stats = new WeakMap<object, ChatStats>()
  const deps: StepDeps = {
    client,
    meter: () => w.meter,
    resolveModelInfo: async () => options.info ?? { context: { contextWindow: options.window ?? 128_000 }, defaultMaxTokens: 8000 },
    backendFor: () => options.backend ?? { config: { auto: true } },
    settings: { protectRecent: 2 },
    stats,
  }
  const agent = { session: w.session } as unknown as StepAgent
  return { w, client, stats, deps, agent }
}

test('at a step boundary above 75% of the stock trigger, results are shortened and the chat statistics say so', { skip }, async () => {
  const { w, client, stats, deps, agent } = await stepWorld()
  try {
    const before = w.meter.measure(w.session).totalTokens
    assert.ok(before > 40_848, `fixture is above 75% of the 54,464 stock trigger (it is ${before})`)
    const outcome = await onPreStep(deps, agent)
    assert.equal(outcome.kind, 'applied')
    const chat = stats.get(w.session)!
    assert.ok(chat.shortened >= 1 && chat.freedTokens > 0 && chat.passes === 1)
    assert.ok(w.meter.measure(w.session).totalTokens < before)
    const text = statusText({ pluginVersion: '0.1.0', enabled: true, python: { path: 'p', source: 'setting' }, worker: client.status(), chat })
    assert.match(text, /In this chat: shortened \d+ tool results?, freeing about [\d,]+ tokens\./)
  } finally {
    await client.dispose()
  }
})

test('below 75% of the stock trigger nothing is done and the reason is recorded', { skip }, async () => {
  const { w, client, stats, deps, agent } = await stepWorld({ window: 1_000_000 })
  try {
    const seq = w.session.seq
    const outcome = await onPreStep(deps, agent)
    assert.deepEqual(outcome, { kind: 'skipped', reason: 'below_activation' })
    assert.equal(w.session.seq, seq)
    assert.equal(stats.get(w.session)!.lastSkip, 'below_activation')
  } finally {
    await client.dispose()
  }
})

test('a chat whose backend another plugin manages is left completely alone', { skip }, async () => {
  const taken: any = { config: { auto: true } }
  taken.compactIfNeeded = () => null
  const { w, client, deps, agent } = await stepWorld({ backend: taken })
  try {
    const seq = w.session.seq
    assert.deepEqual(await onPreStep(deps, agent), { kind: 'skipped', reason: 'managed_elsewhere' })
    assert.equal(w.session.seq, seq)
  } finally {
    await client.dispose()
  }
})

test('a model without a context window, an unusable one, and no request yet are all skipped, not guessed', { skip }, async () => {
  const none = await stepWorld({ info: {} })
  assert.deepEqual(await onPreStep(none.deps, none.agent), { kind: 'skipped', reason: 'no_context_window' })
  await none.client.dispose()
  const tiny = await stepWorld({ window: 64_000 })
  assert.deepEqual(await onPreStep(tiny.deps, tiny.agent), { kind: 'skipped', reason: 'unusable_context_window' })
  await tiny.client.dispose()
  const w = await world()
  const client = new EngineClient(nodeWorkerSpawn(python, script, root))
  const bare = { client, meter: () => w.meter, resolveModelInfo: async () => ({}), backendFor: () => undefined, settings: {}, stats: new WeakMap() }
  assert.deepEqual(await onPreStep(bare as unknown as StepDeps, { session: w.session } as unknown as StepAgent), { kind: 'skipped', reason: 'no_request_yet' })
  await client.dispose()
})

test('whatever goes wrong, the step handler returns instead of throwing', { skip }, async () => {
  const { w, client, deps, agent } = await stepWorld()
  try {
    const seq = w.session.seq
    const boom = {
      ...deps,
      resolveModelInfo: async () => {
        throw new Error('provider unreachable')
      },
    }
    assert.deepEqual(await onPreStep(boom, agent), { kind: 'skipped', reason: 'error' })
    assert.deepEqual(await onPreStep({ ...deps, settings: { shorten: false } }, agent), { kind: 'skipped', reason: 'off' })
    assert.deepEqual(await onPreStep({ ...deps, meter: () => undefined }, agent), { kind: 'skipped', reason: 'no_token_meter' })
    assert.equal(w.session.seq, seq)
  } finally {
    await client.dispose()
  }
})
