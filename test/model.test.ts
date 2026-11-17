import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STRENGTHS, compactChars, emptyReasonKey, fill, gaugeOf, groupsOf, readTab, sizeCells, statusOf, strengthOf, strengthPatch, writeTab } from '../src/client/model.ts'

const state = (extra: Record<string, unknown> = {}) => ({
  live: true,
  python: '/usr/bin/python',
  engine: { state: 'running' },
  chat: { pending: 0 },
  settings: { values: { shorten: true, minConfidence: 0.7 } },
  items: [],
  gauge: { tokens: 50_000, contextWindow: 128_000, stockTrigger: 100_000, startsAt: 75_000 },
  ...extra,
})

test('sizes are whole K: under a thousand is <1K, a thousand to 999,999 is whole K, then whole M', () => {
  assert.equal(compactChars(0), '<1K')
  assert.equal(compactChars(999), '<1K')
  assert.equal(compactChars(1_000), '1K')
  assert.equal(compactChars(1_499), '1K')
  assert.equal(compactChars(1_500), '2K')
  assert.equal(compactChars(20_000), '20K')
  assert.equal(compactChars(52_300), '52K')
  assert.equal(compactChars(999_499), '999K')
  assert.equal(compactChars(999_600), '1M', 'rounding never produces 1000K')
  assert.equal(compactChars(2_500_000), '3M')
  assert.equal(compactChars(NaN), '<1K')
  assert.ok(compactChars(999_499).length <= 4, 'the widest figure fits the 40 px cell')
})

test('a row\'s size cells show before and after, and a held row shows only what the AI sees now', () => {
  assert.deepEqual(sizeCells({ state: 'shortened', originalChars: 52_300, shownChars: 2_100 }), { from: '52K', to: '2K', held: false })
  assert.deepEqual(sizeCells({ state: 'kept', originalChars: 14_800, shownChars: 14_900 }), { from: '', to: '15K', held: true })
  assert.equal(sizeCells({ state: 'restored', originalChars: 3_000, shownChars: 3_100 }).held, true)
})

test('Off, Less, Normal and More map to the settings and back; anything else is custom; Off is just shortening off', () => {
  assert.deepEqual(STRENGTHS.map(s => s.id), ['off', 'less', 'normal', 'more'])
  assert.deepEqual(strengthPatch('off'), { shorten: false })
  assert.deepEqual(strengthPatch('less'), { shorten: true, minConfidence: 0.85 })
  assert.deepEqual(strengthPatch('normal'), { shorten: true, minConfidence: 0.7 })
  assert.deepEqual(strengthPatch('more'), { shorten: true, minConfidence: 0.55 })
  for (const id of ['less', 'normal', 'more'] as const) assert.equal(strengthOf(strengthPatch(id)), id)
  assert.equal(strengthOf({ shorten: false, minConfidence: 0.55 }), 'off', 'off wins over the gate')
  assert.equal(strengthOf({ shorten: true }), 'normal', 'no gate set is the default')
  assert.equal(strengthOf(undefined), 'normal')
  assert.equal(strengthOf({ shorten: true, minConfidence: 0.42 }), 'custom')
  assert.ok(0.55 < 0.7 && 0.7 < 0.85, 'more shortening means a lower gate')
})

test('one count behind everything: shortened and held in full are separate, and a replaced result is in neither', () => {
  const items = [
    { ref: 1, state: 'shortened', onSurface: true },
    { ref: 2, state: 'shortened', onSurface: true, queued: true },
    { ref: 3, state: 'kept', onSurface: true },
    { ref: 4, state: 'restored', onSurface: true },
    { ref: 5, state: 'shortened', onSurface: false },
  ]
  const groups = groupsOf(state({ items }) as any)
  assert.deepEqual(groups.shortened.map(i => i.ref), [1, 2], 'a waiting change counts by its current state')
  assert.deepEqual(groups.kept.map(i => i.ref), [3, 4])
  assert.deepEqual(groupsOf(null), { shortened: [], kept: [] })
  assert.deepEqual(groupsOf({ live: false, items }), { shortened: [], kept: [] })
})

test('the one phrase: the most important true thing wins; none claims a saving; raw errors never become the phrase', () => {
  assert.deepEqual(statusOf(null, false, false), { key: 'loading', tone: 'idle' })
  assert.deepEqual(statusOf(null, true, false), { key: 'notConnected', tone: 'problem' })
  assert.equal(statusOf({ live: false }, false, false).key, 'idle')
  assert.deepEqual(statusOf(state({ python: null }), false, false), { key: 'notRunning', tone: 'problem' })
  assert.deepEqual(statusOf(state({ engine: { state: 'disabled' } }), false, false), { key: 'notRunningRetrying', tone: 'problem' })
  assert.equal(statusOf(state({ failure: 'reference 4 was summarised away', chat: { pending: 2 } }), false, false).key, 'problem', 'a problem outranks waiting changes')
  assert.equal(statusOf(state(), false, true).key, 'problem', 'a problem the bar itself recorded')
  assert.deepEqual(statusOf(state({ chat: { pending: 2 } }), false, false), { key: 'waiting', tone: 'working', n: 2 })
  assert.deepEqual(statusOf(state({ settings: { values: { shorten: false } } }), false, false), { key: 'off', tone: 'off' })
  const items = [{ ref: 3, state: 'shortened', onSurface: true }, { ref: 9, state: 'shortened', onSurface: true }, { ref: 5, state: 'shortened', onSurface: false }, { ref: 7, state: 'kept', onSurface: true }]
  assert.deepEqual(statusOf(state({ items }), false, false), { key: 'shortened', tone: 'idle', n: 2 }, 'a summarised-away result and a kept one are not counted')
  assert.deepEqual(statusOf(state({ items: [items[3]] }), false, false), { key: 'keptOnly', tone: 'idle', n: 1 })
  assert.deepEqual(statusOf(state(), false, false), { key: 'idleUntil', tone: 'idle', percent: 59 })
  assert.deepEqual(statusOf(state({ gauge: { tokens: 90_000, contextWindow: 128_000, stockTrigger: 100_000, startsAt: 75_000 } }), false, false), { key: 'idle', tone: 'idle' }, 'past the start there is nothing to wait for')
  assert.deepEqual(statusOf(state({ gauge: null }), false, false), { key: 'idle', tone: 'idle' })
})

test('the gauge uses the host meter when it has one and the plugin\'s numbers otherwise; ticks are fractions of the window', () => {
  assert.deepEqual(gaugeOf({ projectedTokens: 64_000, contextWindow: 128_000 }, state() as any), { percent: 50, starts: 75_000 / 128_000, compacts: 100_000 / 128_000 })
  assert.equal(gaugeOf(undefined, state() as any)!.percent, 39)
  assert.equal(gaugeOf({ projectedTokens: 999_999, contextWindow: 1000 }, null)!.percent, 100, 'never above 100')
  assert.equal(gaugeOf(undefined, null), undefined)
  assert.equal(gaugeOf({ contextWindow: 0, pressureTokens: 5 }, null), undefined)
})

test('shared strings take their placeholders, and the empty-list reason follows the host\'s own reason', () => {
  assert.equal(fill('{n} outputs shortened', { n: 3 }), '3 outputs shortened')
  assert.equal(fill('Idle until {percent}% full', { percent: 59 }), 'Idle until 59% full')
  assert.equal(fill('{unknown} stays', {}), '{unknown} stays')
  assert.equal(emptyReasonKey('below_activation', false), 'belowStart')
  assert.equal(emptyReasonKey('no_candidates', true), 'noCandidates')
  assert.equal(emptyReasonKey('not_confident', false), 'notConfident')
  assert.equal(emptyReasonKey('not_worth_it', false), 'tooSmall')
  assert.equal(emptyReasonKey('engine_unavailable', false), 'engineSilent')
  assert.equal(emptyReasonKey('off', false), 'off')
  assert.equal(emptyReasonKey(null, true), 'belowStart')
  assert.equal(emptyReasonKey(undefined, false), 'noCandidates')
})

test('the chosen tab is remembered, optional, and survives a broken store; whether the card is open is never stored', () => {
  const memory = new Map<string, string>()
  const store = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, value) }
  assert.equal(readTab(store), 'results', 'results by default')
  writeTab('pins', store)
  assert.equal(readTab(store), 'pins')
  assert.deepEqual([...memory.keys()], ['dsh-tameru.v1.tab'])
  memory.set('dsh-tameru.v1.tab', 'settings')
  assert.equal(readTab(store), 'results', 'a tab that no longer exists falls back')
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.equal(readTab(broken), 'results')
  assert.doesNotThrow(() => writeTab('results', broken))
})
