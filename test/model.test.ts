import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PRESETS, compact, gaugeOf, liveItems, presetOf, readOpen, readSeen, sizeOf, statusOf, writeOpen, writeSeen } from '../src/client/model.ts'

const state = (extra: Record<string, unknown> = {}) => ({
  live: true,
  python: '/usr/bin/python',
  engine: { state: 'running' },
  chat: { pending: 0 },
  settings: { values: { shorten: true } },
  items: [],
  gauge: { tokens: 50_000, contextWindow: 128_000, stockTrigger: 100_000, startsAt: 75_000 },
  ...extra,
})

test('sizes read like 20.0K → 1.2K', () => {
  assert.equal(compact(0), '0')
  assert.equal(compact(999), '999')
  assert.equal(compact(20_000), '20.0K')
  assert.equal(compact(1_234), '1.2K')
  assert.equal(compact(2_500_000), '2.5M')
  assert.equal(compact(NaN), '0')
  assert.equal(sizeOf({ state: 'shortened', originalChars: 20_000, shownChars: 1_200 }, 'in full'), '20.0K → 1.2K')
  assert.equal(sizeOf({ state: 'kept', originalChars: 20_000, shownChars: 20_100 }, 'in full'), '20.0K in full')
})

test('the three named choices map to the confidence gate and back; anything else is custom', () => {
  assert.deepEqual(PRESETS.map(p => p.id), ['cautious', 'balanced', 'eager'])
  for (const preset of PRESETS) assert.equal(presetOf(preset.minConfidence), preset.id)
  assert.equal(presetOf(undefined), 'balanced')
  assert.equal(presetOf(0.42), 'custom')
  assert.equal(PRESETS.find(p => p.id === 'balanced')!.minConfidence, 0.7, 'balanced is the shipped default')
})

test('the one phrase: the most important true thing wins, and none of them claims a saving', () => {
  assert.deepEqual(statusOf(null, false, -1), { tone: 'off', key: 'loading' })
  assert.deepEqual(statusOf(null, true, -1), { tone: 'off', key: 'unreachable' })
  assert.deepEqual(statusOf({ live: false }, false, -1), { tone: 'off', key: 'notOpen' })
  assert.equal(statusOf(state({ python: null }), false, -1).key, 'noPython')
  assert.equal(statusOf(state({ engine: { state: 'disabled' } }), false, -1).key, 'enginePaused')
  const failing = statusOf(state({ failure: 'reference 4 was summarised away', chat: { pending: 2 } }), false, -1)
  assert.equal(failing.key, 'failure', 'a failure outranks waiting changes')
  assert.deepEqual(statusOf(state({ chat: { pending: 2 } }), false, -1), { tone: 'idle', key: 'waiting', count: 2 })
  assert.equal(statusOf(state({ settings: { values: { shorten: false } } }), false, -1).key, 'shorteningOff')
  const items = [{ ref: 3, state: 'shortened', onSurface: true }, { ref: 9, state: 'shortened', onSurface: true }, { ref: 5, state: 'shortened', onSurface: false }]
  assert.deepEqual(statusOf(state({ items }), false, 4), { tone: 'ok', key: 'shortened', count: 2, fresh: 1 }, 'summarised-away results are not counted; "new" is what is above the last seen')
  // a result held in full, or waiting to be changed, is not counted as shortened
  const mixed = [{ ref: 3, state: 'kept', onSurface: true }, { ref: 9, state: 'shortened', onSurface: true, queued: true }, { ref: 11, state: 'shortened', onSurface: true }]
  assert.deepEqual(statusOf(state({ items: mixed }), false, -1), { tone: 'ok', key: 'shortened', count: 1, fresh: 1 })
  assert.deepEqual(statusOf(state({ items: [mixed[0]] }), false, -1), { tone: 'ok', key: 'kept', count: 1 })
  assert.deepEqual(statusOf(state(), false, -1), { tone: 'idle', key: 'startsAt', percent: 59 })
  assert.deepEqual(statusOf(state({ gauge: null }), false, -1), { tone: 'idle', key: 'watching' })
  assert.equal(liveItems({ items }).length, 2)
})

test('the gauge uses the host meter when it has one and the plugin\'s numbers otherwise; ticks are fractions of the window', () => {
  assert.deepEqual(gaugeOf({ projectedTokens: 64_000, contextWindow: 128_000 }, state()), { percent: 50, starts: 75_000 / 128_000, compacts: 100_000 / 128_000 })
  assert.equal(gaugeOf(undefined, state())!.percent, 39)
  assert.equal(gaugeOf({ projectedTokens: 999_999, contextWindow: 1000 }, null)!.percent, 100, 'never above 100')
  assert.equal(gaugeOf(undefined, null), undefined)
  assert.equal(gaugeOf({ contextWindow: 0, pressureTokens: 5 }, null), undefined)
})

test('remembered choices are per viewer, optional, and survive a broken store', () => {
  const memory = new Map<string, string>()
  const store = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, value) }
  assert.equal(readSeen('chat-a', store), -1)
  writeSeen('chat-a', 12, store)
  writeSeen('chat-b', 3, store)
  assert.equal(readSeen('chat-a', store), 12)
  assert.equal(readSeen('chat-b', store), 3)
  assert.deepEqual(readOpen(store), { open: false, tab: 'results' }, 'closed by default')
  writeOpen(true, 'pins', store)
  assert.deepEqual(readOpen(store), { open: true, tab: 'pins' })
  memory.set('dsh-tameru.v1.tab', 'something else')
  assert.equal(readOpen(store).tab, 'results')
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.equal(readSeen('x', broken), -1)
  assert.deepEqual(readOpen(broken), { open: false, tab: 'results' })
  assert.doesNotThrow(() => writeSeen('x', 1, broken))
  assert.doesNotThrow(() => writeOpen(true, 'results', broken))
  memory.set('dsh-tameru.v1.seen', '{not json')
  assert.equal(readSeen('chat-a', store), -1)
})
