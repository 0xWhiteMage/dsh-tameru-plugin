import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, inject, name } from '../src/host/index.ts'
import { findPython } from '../src/host/python.ts'
import { bigOutput, load, skip, world } from './helpers/harness.ts'

type Json = Record<string, any>

// resolved once, before any test points DSH_HOME at a temporary folder (the bundled Python lives under the real one)
const PYTHON = findPython()?.path ?? 'python'

/** The plugin mounted on the real Harness services, with the panel's route reachable the way the browser reaches it. */
async function panel(options: { settings?: Json; steps?: number } = {}) {
  const w = await world('Find why checkout fails.')
  const home = mkdtempSync(join(tmpdir(), 'tameru-api-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const { LocalSubprocessRuntime } = await load('@deepseek-ai/dsh-subprocess-local')
  w.ctx.plugin(LocalSubprocessRuntime)
  w.ctx.plugin(await load('@deepseek-ai/dsh-tool-executor-native'))
  w.ctx.provide('commands')
  w.ctx.set('commands', { register: () => {} })
  w.ctx.provide('llm')
  w.ctx.set('llm', { imageRequestPricing: () => undefined, resolveModelInfo: async () => ({ context: { contextWindow: 128_000 }, defaultMaxTokens: 8000 }) })
  w.ctx.plugin({ name, inject, apply }, { pythonPath: PYTHON, ...(options.settings ?? {}) })
  await new Promise(resolve => setTimeout(resolve, 150))
  for (let i = 0; i < (options.steps ?? 8); i++) w.step({ name: 'bash', args: { command: `step ${i}` } }, bigOutput(`s${i}`))
  w.pendingCall({ name: 'bash', args: { command: 'npm test' } }, bigOutput('pending'))
  w.header(8000)
  const sessionId = (w.session as unknown as { id: string }).id
  const route = w.routes.get('/api/tameru')!
  const call = async (endpoint: string, payload: Json = {}): Promise<Json> => {
    const response = await route.fetch(new Request('http://127.0.0.1/api/tameru', { method: 'POST', body: JSON.stringify({ endpoint, payload: { sessionId, ...payload } }) }))
    return (await response.json()) as Json
  }
  const agent = { id: 'a1', session: w.session }
  const step = (): Promise<unknown> =>
    w.ctx.waterfall(w.ctx, 'agent/pre-step', { agent, signal: new AbortController().signal, messages: [], step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  const close = async (): Promise<void> => {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    await w.ctx.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  }
  return { w, home, route, call, step, close, sessionId }
}

test('the route is a POST route of its own, and refuses what is not a request', { skip }, async () => {
  const p = await panel()
  try {
    assert.deepEqual(p.route.methods, ['POST'])
    assert.equal((await p.route.fetch(new Request('http://x/api/tameru', { method: 'POST', body: '{not json' }))).status, 400)
    const odd = [undefined, null, 5, 'x', [], {}]
    for (const payload of odd) {
      const response = await p.route.fetch(new Request('http://x/api/tameru', { method: 'POST', body: JSON.stringify({ endpoint: 'state', payload }) }))
      assert.equal((await response.json()).ok, false)
    }
    assert.equal((await p.call('frobnicate')).ok, false)
    assert.equal((await p.call('state', { sessionId: 'x'.repeat(500) })).ok, false)
    assert.equal((await p.route.fetch(new Request('http://x/api/tameru', { method: 'POST', body: JSON.stringify({ endpoint: 7 }) }))).status, 200)
  } finally {
    await p.close()
  }
})

test('state says what is in the chat: gauge, engine, pins, limits, settings; a chat that is not open is not reached', { skip }, async () => {
  const p = await panel()
  try {
    const state = await p.call('state')
    assert.equal(state.ok, true)
    assert.equal(state.live, true)
    assert.equal(state.gauge.contextWindow, 128_000)
    assert.equal(state.gauge.stockTrigger, 54_464)
    assert.equal(state.gauge.startsAt, Math.floor(54_464 * 0.75))
    assert.ok(state.gauge.tokens > 40_000)
    assert.equal(state.working, true, 'the fixture\'s turn is open')
    assert.deepEqual(state.items, [])
    assert.deepEqual(state.pins, [])
    assert.deepEqual(state.limits, { pins: 5, pinChars: 300, view: 3000, read: 20_000 })
    assert.equal(state.settings.values.minConfidence, 0.7)
    assert.equal(state.settings.defaults.activation, 0.75)
    assert.equal((await p.call('state', { sessionId: 'not-a-session' })).live, false)
    const nobody = await p.call('view', { sessionId: 'not-a-session', ref: 1 })
    assert.deepEqual(nobody, { ok: false, error: 'that chat is not open' })
  } finally {
    await p.close()
  }
})

test('after a step the chat shows its cleanups, which can be viewed, kept, restored and put back', { skip }, async () => {
  const p = await panel({ settings: { minConfidence: 0 } })
  try {
    await p.step()
    const state = await p.call('state')
    assert.ok(state.chat.shortened >= 1, `shortened ${state.chat.shortened}, last skip ${state.chat.lastSkip}, gauge ${JSON.stringify(state.gauge)}`)
    assert.ok(state.chat.freedTokens > 0)
    assert.ok(state.items.length >= 1 && state.items.every((i: Json) => i.state === 'shortened' && i.onSurface && i.tool === 'bash'))
    const item = state.items[0]
    // what the model sees, and the original, each in windows
    const shown = await p.call('view', { ref: item.ref, which: 'shown' })
    assert.ok(shown.ok && shown.text.startsWith('[Tameru: shortened from ') && shown.total === item.shownChars)
    const original = await p.call('view', { ref: item.ref, which: 'original' })
    assert.ok(original.ok && original.total === item.originalChars && original.end === 3000)
    const second = await p.call('view', { ref: item.ref, which: 'original', offset: 3000 })
    assert.ok(second.ok && second.offset === 3000)
    assert.equal((await p.call('view', { ref: 0, which: 'original' })).ok, false, 'only results Tameru touched')
    // while the agent is working the request is queued; the next step boundary applies it
    const queued = await p.call('hold', { ref: item.ref, op: 'keep' })
    assert.ok(queued.ok && queued.queued)
    assert.equal((await p.call('state')).chat.pending, 1)
    await p.step()
    assert.equal((await p.call('state')).items.find((i: Json) => i.ref === item.ref).state, 'kept')
    // once the agent is idle it is immediate
    p.w.finish()
    const idle = await p.call('hold', { ref: item.ref, op: 'unkeep' })
    assert.ok(idle.ok && !idle.queued)
    assert.equal((await p.call('state')).items.find((i: Json) => i.ref === item.ref).state, 'shortened')
    assert.ok((await p.call('hold', { ref: item.ref, op: 'restore' })).ok)
    assert.equal((await p.call('state')).items.find((i: Json) => i.ref === item.ref).state, 'restored')
    for (const bad of [{ ref: 'x', op: 'keep' }, { ref: item.ref, op: 'delete' }, { op: 'keep' }, { ref: 99_999, op: 'keep' }]) assert.equal((await p.call('hold', bad)).ok, false, JSON.stringify(bad))
    assert.equal(p.w.meter.measure(p.w.session).surfaceTokens, p.w.session.deriveMessages().reduce((sum: number, m: any) => sum + p.w.meter.estimateMessage(m), 0), 'the Harness meter equals a full recount')
  } finally {
    await p.close()
  }
})

test('pins through the panel: add, list, remove, and every refusal says why', { skip }, async () => {
  const p = await panel()
  try {
    const added = await p.call('pin', { text: 'Never touch the production config' })
    assert.deepEqual(added, { ok: true, pins: ['Never touch the production config'] })
    assert.deepEqual((await p.call('state')).pins, ['Never touch the production config'])
    assert.equal((await p.call('pin', { text: 'sk-abcdefghijklmnop1234' })).ok, false)
    assert.equal((await p.call('pin', { text: 5 })).ok, false)
    assert.equal((await p.call('pin', { text: 'x'.repeat(301) })).ok, false)
    assert.equal((await p.call('unpin', { position: 9 })).ok, false)
    assert.equal((await p.call('unpin', { position: 'one' })).ok, false)
    assert.deepEqual(await p.call('unpin', { position: 1 }), { ok: true, pins: [] })
    assert.ok(existsSync(join(p.home, 'tameru', 'pins.json')))
  } finally {
    await p.close()
  }
})

test('settings through the panel are validated, saved, applied at once, and resettable', { skip }, async () => {
  const p = await panel()
  try {
    const before = await p.call('settings')
    assert.equal(before.settings.values.minConfidence, 0.7)
    const changed = await p.call('settings', { patch: { minConfidence: 0.4, activation: 0.6, shorten: true } })
    assert.ok(changed.ok)
    assert.equal(changed.settings.values.minConfidence, 0.4)
    assert.equal((await p.call('state')).settings.values.activation, 0.6, 'the running plugin uses it now')
    assert.deepEqual(JSON.parse(readFileSync(join(p.home, 'tameru', 'settings.json'), 'utf8')), { version: 2, settings: { shorten: true, activation: 0.6, minConfidence: 0.4 } })
    for (const bad of [{ activation: 5 }, { minConfidence: 'high' }, { shorten: 'yes' }, { nonsense: 1 }, { activation: 0.1 }]) {
      const refused = await p.call('settings', { patch: bad })
      assert.equal(refused.ok, false, JSON.stringify(bad))
    }
    assert.equal((await p.call('settings')).settings.values.activation, 0.6, 'a refused change changes nothing')
    const reset = await p.call('settings', { patch: { minConfidence: null, activation: null } })
    assert.equal(reset.settings.values.minConfidence, 0.7)
    assert.equal(reset.settings.values.activation, 0.75)
  } finally {
    await p.close()
  }
})

test('saved settings are read when the plugin starts, over the profile\'s values, and a damaged file is ignored', { skip }, async () => {
  const w = await world()
  const home = mkdtempSync(join(tmpdir(), 'tameru-api-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(home, 'tameru'))
    writeFileSync(join(home, 'tameru', 'settings.json'), JSON.stringify({ version: 2, settings: { activation: 0.5, share: 'wrong' } }))
    const { LocalSubprocessRuntime } = await load('@deepseek-ai/dsh-subprocess-local')
    w.ctx.plugin(LocalSubprocessRuntime)
    w.ctx.provide('commands')
    w.ctx.set('commands', { register: () => {} })
    w.ctx.plugin({ name, inject, apply }, { pythonPath: PYTHON, activation: 0.9, minConfidence: 0.8 })
    await new Promise(resolve => setTimeout(resolve, 150))
    const route = w.routes.get('/api/tameru')!
    const read = async (): Promise<Json> => (await (await route.fetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ endpoint: 'settings', payload: {} }) }))).json()) as Json
    const values = (await read()).settings.values
    assert.equal(values.activation, 0.5, 'saved wins over the profile')
    assert.equal(values.minConfidence, 0.8, 'the profile still supplies what was not saved')
    assert.equal(values.share, 0.35, 'an invalid saved value falls back to the default')
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    await w.ctx.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('only what the user changed in the panel is saved: the profile\'s values are not copied into the saved file, and reset returns to the profile', { skip }, async () => {
  const p = await panel({ settings: { share: 0.5 } })
  try {
    assert.equal((await p.call('settings')).settings.values.share, 0.5)
    await p.call('settings', { patch: { activation: 0.6 } })
    assert.deepEqual(JSON.parse(readFileSync(join(p.home, 'tameru', 'settings.json'), 'utf8')), { version: 2, settings: { activation: 0.6 } })
    await p.call('settings', { patch: { share: 0.2 } })
    assert.equal((await p.call('settings')).settings.values.share, 0.2)
    const reset = await p.call('settings', { patch: { share: null } })
    assert.equal(reset.settings.values.share, 0.5, 'reset goes back to the profile\'s value, not the built-in default')
  } finally {
    await p.close()
  }
})
