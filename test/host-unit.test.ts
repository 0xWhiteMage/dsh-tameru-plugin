import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { handleApi, type ApiEnv } from '../src/host/api.ts'
import { SHORTENED_PREFIX, type SessionEvent } from '../src/host/messages.ts'
import { keptHeader, restoredHeader } from '../src/host/originals.ts'
import { memoryPins } from '../src/host/pins.ts'
import { readSaved, writeSaved } from '../src/host/saved-settings.ts'
import type { SessionLike } from '../src/host/shorten.ts'
import { chatStatsOf, onPreStep, type StepDeps } from '../src/host/step.ts'

const original = 'first line\n' + 'build output\n'.repeat(300) + 'last line'
const shown = SHORTENED_PREFIX + 'the original]\nlast line'
const message = (text: string) => ({ role: 'tool', content: [{ type: 'text', text }], source: { kind: 'tool', name: 'bash' } })

function panel() {
  type AppendOptions = { sourceEventSeqs?: number[]; surfaceOp?: { op: 'replace'; startSeq: number } }
  const events: Array<SessionEvent & Pick<AppendOptions, 'sourceEventSeqs'>> = [
    { seq: 0, type: 'tool/result', data: { message: message('unrelated output') } },
    { seq: 1, type: 'tool/result', data: { message: message(original) } },
    { seq: 2, type: 'tool/result', data: { message: message(shown) }, sourceEventSeqs: [1] },
  ]
  const nodes = [0, 2]
  const session: SessionLike = {
    id: 'chat',
    surface: { nodes, replaceGeneration: 1 },
    get seq() { return events.length },
    eventAt: seq => events[seq],
    deriveEventMessage: event => event.data.message ?? null,
    append(type: any, data?: unknown, options?: unknown): any {
      if (Array.isArray(type)) return type.map(([t, d, o]) => session.append(t, d, o))
      const { sourceEventSeqs, surfaceOp } = (options ?? {}) as AppendOptions
      const event = { seq: events.length, type, data: data as SessionEvent['data'], sourceEventSeqs }
      if (surfaceOp) {
        const at = nodes.indexOf(surfaceOp.startSeq)
        if (at === -1) throw new Error('cannot replace a node outside the surface')
        nodes[at] = event.seq
        session.surface.replaceGeneration++
      }
      events.push(event)
      return event
    },
  }
  const env: ApiEnv = {
    version: 'test',
    sessionFor: id => id === session.id ? session : undefined,
    meter: () => ({ measure: () => ({ totalTokens: 0, nodes: [] }), estimateMessage: () => 10 }),
    stats: new WeakMap(),
    pins: memoryPins(),
    profile: { activation: 0.8 },
    settings: { activation: 0.8 },
    saved: {},
    saveSettings: () => undefined,
    engine: () => undefined,
    pythonPath: () => undefined,
    pressure: async () => ({ ok: false, reason: 'no_request_yet' }),
  }
  const request = (endpoint: string, payload: Record<string, unknown> = {}) => handleApi(endpoint, { sessionId: session.id, ...payload }, env)
  return { env, session, request }
}

test('an invalid or unwritable settings patch leaves the settings and saved overrides unchanged', async () => {
  const { env, request } = panel()
  const saved: unknown[] = []
  env.saveSettings = settings => { saved.push(settings); return 'disk unavailable' }
  assert.deepEqual(await request('settings', { patch: { shorten: false, activation: 1 } }),
    { ok: false, error: '"activation" is out of range' })
  assert.deepEqual(await request('settings', { patch: { shorten: false, madeUp: true } }),
    { ok: false, error: 'unknown setting "madeUp"' })
  assert.deepEqual(saved, [])
  assert.deepEqual(await request('settings', { patch: { shorten: false } }),
    { ok: false, error: 'could not save the settings: disk unavailable' })
  assert.deepEqual(saved, [{ shorten: false }])
  assert.deepEqual(env.saved, {})
  assert.deepEqual(env.settings, { activation: 0.8 })
})

test('settings save only overrides and a null patch value returns to the profile in place', async () => {
  const { env, request } = panel()
  const { saved, settings } = env
  const writes: unknown[] = []
  env.saveSettings = next => { writes.push({ ...next }); return undefined }
  assert.equal((await request('settings', { patch: { activation: 0.5, shorten: false } })).ok, true)
  assert.deepEqual(settings, { activation: 0.5, shorten: false })
  assert.equal((await request('settings', { patch: { activation: null } })).ok, true)
  assert.deepEqual(settings, { activation: 0.8, shorten: false })
  assert.deepEqual(saved, { shorten: false })
  assert.deepEqual(writes, [{ activation: 0.5, shorten: false }, { shorten: false }])
})

test('saved settings ignore other versions and malformed files; a write replaces the previous settings', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tameru-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'settings.json')
  assert.deepEqual(readSaved(dir), {})
  writeFileSync(file, '{"version":1,"settings":{"shorten":false}}')
  assert.deepEqual(readSaved(dir), {})
  writeFileSync(file, '{"version":2')
  assert.deepEqual(readSaved(dir), {})
  assert.equal(writeSaved(dir, { shorten: false, activation: 0.5 }), undefined)
  assert.deepEqual(readSaved(dir), { shorten: false, activation: 0.5 })
  assert.equal(writeSaved(dir, { shorten: true }), undefined)
  assert.deepEqual(readSaved(dir), { shorten: true })
  assert.deepEqual(readdirSync(dir), ['settings.json'])
  assert.match(writeSaved(file, { shorten: true }) ?? '', /ENOTDIR|EEXIST/)
})

test('the viewer pages the original independently of the shown result, and cannot read an unrelated result or closed chat', async () => {
  const { request } = panel()
  assert.deepEqual(await request('view', { ref: 1, which: 'original', offset: -3 }),
    { ok: true, text: original.slice(0, 3000), offset: 0, end: 3000, total: original.length })
  assert.deepEqual(await request('view', { ref: 1, which: 'original', offset: 3000 }),
    { ok: true, text: original.slice(3000), offset: 3000, end: original.length, total: original.length })
  assert.deepEqual(await request('view', { ref: 1, which: 'shown', offset: 0.5 }),
    { ok: true, text: shown, offset: 0, end: shown.length, total: shown.length })
  assert.deepEqual(await request('view', { ref: 1, which: 'shown', offset: 10_000 }),
    { ok: true, text: '', offset: shown.length, end: shown.length, total: shown.length })
  assert.equal((await request('view', { ref: 0, which: 'original' })).ok, false)
  assert.deepEqual(await request('view', { ref: 1, sessionId: 'closed' }), { ok: false, error: 'that chat is not open' })
  assert.deepEqual(await request('state', { sessionId: 'closed' }), { ok: true, live: false, version: 'test' })
})

test('a queued keep waits through compaction but applies with shortening off; unkeep restores the exact shorter output', async () => {
  const { env, request, session } = panel()
  session.append('turn/start', {})
  session.append('compaction/start', {})
  const queued = await request('hold', { ref: 1, op: 'keep' })
  assert.ok(queued.ok)
  assert.equal(queued.queued, true)
  assert.deepEqual(session.surface.nodes, [0, 2])
  const stats = chatStatsOf(env.stats, session)
  assert.deepEqual(stats.pending, [{ op: 'keep', ref: 1 }])
  const unused = () => assert.fail('shortening must not run')
  const deps: StepDeps = {
    get client() { return unused() }, meter: env.meter, settings: { shorten: false }, stats: env.stats,
    backendFor: unused, resolveModelInfo: unused,
  }
  const agent = { session: Object.assign(session, { requestHeader: unused }) }
  assert.deepEqual(await onPreStep(deps, agent), { kind: 'skipped', reason: 'off' })
  assert.equal(stats.pending.length, 1)
  session.append('compaction/end', {})
  assert.deepEqual(await onPreStep(deps, agent), { kind: 'skipped', reason: 'off' })
  assert.deepEqual(stats.pending, [])
  const keptText = keptHeader(1) + original
  assert.deepEqual(await request('view', { ref: 1, which: 'shown', offset: 3000 }),
    { ok: true, text: keptText.slice(3000), offset: 3000, end: keptText.length, total: keptText.length })
  session.append('turn/end', {})
  const released = await request('hold', { ref: 1, op: 'unkeep' })
  assert.ok(released.ok)
  assert.equal(released.queued, false)
  assert.deepEqual(await request('view', { ref: 1, which: 'shown' }),
    { ok: true, text: shown, offset: 0, end: shown.length, total: shown.length })
})

test('a rejected gauge lookup keeps chat state usable, and queued failures expire at thirty seconds', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const { env, request, session } = panel()
  env.pressure = async () => { throw new Error('meter failed') }
  assert.deepEqual(await request('pin', { text: '  Retain\nthis rule.  ' }), { ok: true, pins: ['Retain this rule.'] })
  const stats = chatStatsOf(env.stats, session)
  stats.lastFailure = 'previous queued action could not be applied'
  stats.lastFailureAt = Date.now()
  t.mock.timers.tick(29_999)
  const state = await request('state')
  assert.ok(state.ok)
  assert.equal(state.gauge, null)
  assert.equal(state.gaugeUnavailable, 'error')
  assert.deepEqual(state.pins, ['Retain this rule.'])
  assert.equal(state.failure, stats.lastFailure)
  t.mock.timers.tick(1)
  const expired = await request('state')
  assert.ok(expired.ok)
  assert.equal(expired.failure, null)
})

test('a routed model lookup failure leaves the log untouched and records a skipped step', async () => {
  const { env, session } = panel()
  const warnings: string[] = []
  const signal = new AbortController().signal
  const agent = { session: Object.assign(session, { requestHeader: () => ({ config: { provider: 'provider', model: 'model' } }) }) }
  const lookups: unknown[] = []
  const deps: StepDeps = {
    get client() { return assert.fail('the engine must not be reached without a context window') },
    meter: env.meter,
    settings: env.settings,
    stats: env.stats,
    backendFor: () => undefined,
    resolveModelInfo: async (...args) => { lookups.push(args); throw new Error('model lookup failed') },
    log: { info: assert.fail, warn: warning => warnings.push(warning) },
  }
  assert.deepEqual(await onPreStep(deps, agent, signal), { kind: 'skipped', reason: 'error' })
  assert.deepEqual(lookups, [['provider', 'model', signal]])
  assert.deepEqual(warnings, ['dsh-tameru: skipped a step: model lookup failed'])
  const stats = chatStatsOf(env.stats, session)
  assert.equal(stats.lastSkip, 'error')
  assert.equal(stats.passes, 0)
  assert.equal(session.seq, 3)
  assert.deepEqual(session.surface.nodes, [0, 2])
})

test('unkeep finds the shortened output after converting a restore to a keep', async () => {
  const { request } = panel()
  assert.equal((await request('hold', { ref: 1, op: 'restore' })).ok, true)
  const restored = await request('view', { ref: 1, which: 'shown' })
  assert.ok(restored.ok)
  assert.equal(restored.text, (restoredHeader(1) + original).slice(0, 3000))
  assert.equal((await request('hold', { ref: 1, op: 'keep' })).ok, true)
  const release = await request('hold', { ref: 1, op: 'unkeep' })
  assert.ok(release.ok, release.ok ? undefined : release.error)
  const shortened = await request('view', { ref: 1, which: 'shown' })
  assert.ok(shortened.ok)
  assert.equal(shortened.text, shown)
})

test('unkeep after a stock cut puts back the cut text, not the uncut extract', async () => {
  const { session, request } = panel()
  // the stock pruner cuts the shortened node itself: a replacement citing it, middle removed (its head keeps our header)
  const cut = `${shown}\n\n[... tool result middle pruned ...]\n\ntail`
  session.append('compaction/prune', { shadowedSeqs: [2] })
  session.append('tool/result', { message: message(cut) }, { sourceEventSeqs: [2], surfaceOp: { op: 'replace', startSeq: 2 } })
  assert.equal((await request('hold', { ref: 1, op: 'keep' })).ok, true)
  assert.equal((await request('hold', { ref: 1, op: 'unkeep' })).ok, true)
  const back = await request('view', { ref: 1, which: 'shown' })
  assert.ok(back.ok)
  assert.equal(back.text, cut, 'the version Keep replaced is the one unkeep puts back')
})
