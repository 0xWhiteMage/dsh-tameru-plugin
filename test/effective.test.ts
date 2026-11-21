// One settings table, one resolved `effective` object. The panel label must equal what the host resolves for every stored setting
// (unset, legacy gates, each strength under each policy, both channels), and nothing derived from the table may drift from it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { SETTING_KEYS as API_KEYS, effectiveSettings } from '../src/host/api.ts'
import { normalizeSettings, resolveEffective } from '../src/host/settings.ts'
import { DEFAULT_SHORTEN } from '../src/host/shorten.ts'
import { DEFAULT_ACTIVATION, DEFAULT_POLICY, type TameruSettings } from '../src/host/step.ts'
import { STRENGTHS, isBeta, statusOf, strengthOf, strengthPatch } from '../src/client/model.ts'
import { INCUMBENT, POLICIES, SETTINGS_TABLE, SETTING_DEFAULTS, SETTING_KEYS, settingsMarkdown, specOf } from '../src/shared/settings-table.ts'
import { root } from './helpers/harness.ts'

const GATES = [undefined, 0.5, 0.55, 0.7, 0.85, 0.9] as const

test('the label the panel shows equals the host\'s resolved strength, for every stored setting on both channels', () => {
  const cases: TameruSettings[] = []
  for (const channel of [undefined, 'stable', 'beta'] as const)
    for (const policy of [undefined, ...POLICIES])
      for (const minConfidence of GATES)
        for (const shorten of [undefined, true, false]) {
          const s: TameruSettings = {}
          if (channel) s.channel = channel
          if (policy) s.policy = policy
          if (minConfidence !== undefined) s.minConfidence = minConfidence
          if (shorten !== undefined) s.shorten = shorten
          cases.push(s)
        }
  // each strength the menu sets, under each policy, on both channels
  for (const channel of ['stable', 'beta'] as const) for (const policy of POLICIES) for (const strength of STRENGTHS) cases.push({ channel, policy, ...strengthPatch(strength.id) })
  assert.ok(cases.length > 200)
  for (const stored of cases) {
    const settings = normalizeSettings(stored) // the same path a profile value or a panel patch takes
    const effective = resolveEffective(settings, '1.10.0')
    // the state route's object, after a JSON round trip, read by the real panel functions
    const wire = JSON.parse(JSON.stringify(effectiveSettings(settings, {}, '1.10.0').effective))
    const label = strengthOf(wire)
    const name = JSON.stringify(stored)
    assert.equal(label, effective.strength, name)
    assert.equal(isBeta(wire), effective.channel === 'beta', name)
    assert.equal(statusOf({ live: true, python: '/py', engine: {}, chat: { pending: 0 }, items: [], effective: wire }, false, false).key === 'off', stored.shorten === false, name)
    // the rules, stated independently
    const beta = stored.channel === 'beta'
    const policy = beta ? (stored.policy ?? 'at-trigger') : 'every-step'
    const gate = stored.minConfidence ?? (beta && policy === 'at-trigger' ? 0 : 0.7)
    assert.equal(effective.policy, policy, `${name}: policy`)
    assert.equal(effective.minConfidence, gate, `${name}: gate (a stored gate is kept exactly)`)
    const expected = stored.shorten === false ? 'off' : policy !== 'every-step' ? 'custom' : gate === 0.85 ? 'less' : gate === 0.7 ? 'normal' : gate === 0.55 ? 'more' : 'custom'
    assert.equal(label, expected, `${name}: label`)
  }
})

test('unset is the incumbent on stable; legacy gates show their strength or Custom and are never rewritten', () => {
  assert.deepEqual(
    (({ engineVersion, presetId, ...rest }) => rest)(resolveEffective({})),
    { channel: 'stable', policy: 'every-step', shorten: true, strength: 'normal', minConfidence: 0.7, activation: 0.75, share: 0.35, protectRecent: 4, lambdaMultiplier: 1, priceProfile: 'deepseek-v4-pro', evStrength: 'normal' },
  )
  assert.equal(resolveEffective({}).presetId, 'dsh-tool-result@1')
  const legacy: Record<number, string> = { 0.5: 'custom', 0.55: 'more', 0.7: 'normal', 0.85: 'less', 0.9: 'custom' }
  for (const [gate, label] of Object.entries(legacy)) {
    const e = resolveEffective(normalizeSettings({ minConfidence: Number(gate) }))
    assert.equal(e.strength, label, `gate ${gate}`)
    assert.equal(e.minConfidence, Number(gate), 'kept as a hard minimum')
  }
  const beta = resolveEffective({ channel: 'beta' })
  assert.deepEqual([beta.policy, beta.minConfidence, beta.activation, beta.share, beta.protectRecent, beta.strength], ['at-trigger', 0, 1, 0, 0, 'custom'])
})

test('plan: beta-only, the stock trigger and no protection, the strength becomes the EV strength', () => {
  const stable = resolveEffective({ policy: 'plan' })
  assert.equal(stable.policy, 'every-step', 'stable always runs the incumbent')
  const strengths: Array<[number, 'less' | 'normal' | 'more']> = [[0.85, 'less'], [0.7, 'normal'], [0.55, 'more']]
  for (const [gate, ev] of strengths) {
    const e = resolveEffective({ channel: 'beta', policy: 'plan', minConfidence: gate })
    assert.equal(e.policy, 'plan')
    assert.equal(e.evStrength, ev, `gate ${gate} picks EV strength ${ev}`)
    assert.equal(e.activation, 1)
    assert.equal(e.share, 0)
    assert.equal(e.protectRecent, 0)
    assert.equal(e.strength, 'custom', 'a non-every-step policy shows Custom')
    assert.equal(e.priceProfile, 'deepseek-v4-pro')
  }
  const custom = resolveEffective({ channel: 'beta', policy: 'plan', minConfidence: 0.9 })
  assert.equal(custom.evStrength, 'normal', 'a gate none of the strengths set falls back to normal')
  const priced = resolveEffective({ channel: 'beta', policy: 'plan', priceProfile: 'deepseek-flash' })
  assert.equal(priced.priceProfile, 'deepseek-flash')
})

test('one settings table: defaults, keys, validation and the README table all come from it', () => {
  // keys: the panel's list is the table's, and includes policy, channel and the reserved lambda multiplier
  assert.deepEqual(API_KEYS, SETTING_KEYS)
  for (const key of ['policy', 'channel', 'lambdaMultiplier', 'shorten', 'minConfidence']) assert.ok(SETTING_KEYS.includes(key), key)
  assert.equal(specOf('lambdaMultiplier')!.reserved, true)
  assert.equal(SETTING_DEFAULTS.lambdaMultiplier, 1)
  assert.equal(SETTING_DEFAULTS.channel, 'stable')
  assert.equal(SETTING_DEFAULTS.policy, 'every-step')
  // the host's defaults are the table's
  assert.equal(DEFAULT_POLICY, SETTING_DEFAULTS.policy)
  assert.equal(DEFAULT_ACTIVATION, SETTING_DEFAULTS.activation)
  for (const key of ['protectRecent', 'minResultChars', 'share', 'maxPerPass', 'minConfidence'] as const) assert.equal(DEFAULT_SHORTEN[key], SETTING_DEFAULTS[key], key)
  assert.deepEqual(INCUMBENT, { policy: 'every-step', minConfidence: 0.7, activation: 0.75, share: 0.35, protectRecent: 4, minResultChars: 6000, maxPerPass: 24 })
  assert.deepEqual(effectiveSettings({}).defaults, SETTING_DEFAULTS)
  // validation: every range edge of the table is accepted, and one step outside is refused
  for (const spec of SETTINGS_TABLE) {
    if (spec.scope !== 'panel') continue
    if (spec.type === 'number' || spec.type === 'integer') {
      for (const ok of [spec.min!, spec.max!]) assert.deepEqual(normalizeSettings({ [spec.key]: ok }), { [spec.key]: ok }, `${spec.key} ${ok}`)
      for (const bad of [spec.min! - 0.0001, spec.max! + 1, 'x', null]) assert.deepEqual(normalizeSettings({ [spec.key]: bad }), {}, `${spec.key} ${bad}`)
    } else if (spec.type === 'enum') {
      for (const ok of spec.values!) assert.deepEqual(normalizeSettings({ [spec.key]: ok }), { [spec.key]: ok })
      assert.deepEqual(normalizeSettings({ [spec.key]: 'nonsense' }), {})
    } else if (spec.type === 'boolean') {
      assert.deepEqual(normalizeSettings({ [spec.key]: false }), { [spec.key]: false })
      assert.deepEqual(normalizeSettings({ [spec.key]: 'yes' }), {})
    }
  }
  // the README's table is generated from the table, byte for byte
  const readme = readFileSync(join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n')
  assert.ok(readme.includes(`${settingsMarkdown()}\n`), 'README.md\'s settings table is not the generated one: paste settingsMarkdown() from src/shared/settings-table.ts')
  for (const spec of SETTINGS_TABLE) assert.ok(readme.includes(`| \`${spec.key}\` |`), spec.key)
})
