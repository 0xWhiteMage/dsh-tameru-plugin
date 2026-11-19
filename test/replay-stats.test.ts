// The replay's shared statistics: cluster bootstrap by scenario, paired differences, and the arm-vs-itself check that must be exactly 0.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { METRICS, clusterBootstrap, fromJsonl, pairedDifference, selfCheck, toJsonl, type Row } from '../scripts/replay/stats.ts'

function row(scenario: string, window: number, arm: string, over: Partial<Row> = {}): Row {
  return {
    bench: 'replay', engine: '1.10.0', split: 'dev', scenario, family: 'f', cluster: scenario, arm, window, seed: 1,
    cost: 1_000_000, cost_w125: 1_100_000, facts_held: 2, facts_needed: 5, shortened: 3, compactions: 1, rewrites: 4,
    eligible: 10, accepted: 4, applied: 3, second_rewrites: 0, extract_facts_possible: 6, extract_facts_kept: 6,
    trigger_events: 5, trigger_events_replaced: 2, cuts_eligible: 9, cuts_replaced: 3, pass_ms: 12, ...over,
  }
}

const sample = (arm: string, shift = 0): Row[] =>
  Array.from({ length: 12 }, (_, i) => [128_000, 200_000].map(w => row(`s${i}`, w, arm, { cost: 1_000_000 + 10_000 * i + shift, facts_held: i % 6, accepted: i % 5, applied: i % 4, trigger_events_replaced: i % 3 }))).flat()

test('an arm against itself is exactly 0 on every metric, mean and every bound', () => {
  const rows = [...sample('a'), ...sample('b', 5000)]
  const check = selfCheck(rows)
  assert.deepEqual(check.failures, [])
  let defined = 0
  for (const m of METRICS) {
    const d = pairedDifference(sample('a'), sample('a'), m.name)
    if (d === undefined) continue
    defined++
    assert.deepEqual([d.mean, d.lo, d.hi, d.lo1, d.hi1].map(x => (Object.is(x, -0) ? 'minus zero' : x)), [0, 0, 0, 0, 0], m.name)
  }
  assert.equal(defined, METRICS.length, 'every metric was checked')
})

test('the bootstrap resamples whole scenarios: rows of one scenario never separate, so the interval is wide for two clusters', () => {
  const items = [
    ...Array.from({ length: 50 }, () => ({ cluster: 'A', value: 1 })),
    ...Array.from({ length: 50 }, () => ({ cluster: 'B', value: 3 })),
  ]
  const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length
  const ci = clusterBootstrap(items, vs => mean(vs))!
  assert.equal(ci.clusters, 2)
  assert.equal(ci.n, 100)
  assert.equal(ci.mean, 2)
  assert.equal(ci.lo, 1)
  assert.equal(ci.hi, 3)
})

test('the same data and seed give the same interval, and the cluster count is reported', () => {
  const a = pairedDifference(sample('a'), sample('b', 20_000), 'cost')!
  const b = pairedDifference(sample('a'), sample('b', 20_000), 'cost')!
  assert.deepEqual(a, b)
  assert.equal(a.clusters, 12)
  assert.equal(a.n, 24)
  assert.ok(a.lo <= a.mean && a.mean <= a.hi && a.lo1 <= a.mean && a.mean <= a.hi1)
  assert.ok(a.mean > 0, 'B costs more')
})

test('a paired difference is matched on scenario, window and seed, and unmatched rows are dropped', () => {
  const a = sample('a')
  const b = sample('b', 0).slice(2) // the first scenario is missing from B
  const d = pairedDifference(a, b, 'facts_held')!
  assert.equal(d.n, 22)
  assert.equal(d.clusters, 11)
})

test('shares are ratios of sums over the resampled clusters, and undefined when nothing was asked', () => {
  const a = [row('s1', 128_000, 'a', { eligible: 10, accepted: 1 }), row('s2', 128_000, 'a', { eligible: 10, accepted: 1 })]
  const b = [row('s1', 128_000, 'b', { eligible: 10, accepted: 5 }), row('s2', 128_000, 'b', { eligible: 10, accepted: 3 })]
  const d = pairedDifference(a, b, 'accepted_share')!
  assert.ok(Math.abs(d.mean - 30) < 1e-9)
  const none = [row('s1', 128_000, 'a', { eligible: 0, accepted: 0 })]
  assert.equal(pairedDifference(none, none, 'accepted_share'), undefined)
})

test('rows survive a jsonl round trip byte for byte and keep the shared field order', () => {
  const rows = sample('a')
  assert.equal(toJsonl(fromJsonl(toJsonl(rows))), toJsonl(rows))
  assert.deepEqual(Object.keys(rows[0]!).slice(0, 10), ['bench', 'engine', 'split', 'scenario', 'family', 'cluster', 'arm', 'window', 'seed', 'cost'])
})

test('rows with the optional per-act/per-decline records stay backward compatible: same leading fields, round trip, arm-vs-itself exactly 0', () => {
  const rec = { step: 3, key: '12:9000', event: 'every-step' as const, outcome: 'decline' as const, reason: 'share', stage: 'plugin' as const, original_chars: 9000, extract_chars: 800, extract_sha256: 'a'.repeat(64), facts: [{ fact: 0, value_present: true, line_present: false }], p_hat: null, value: null, loss: null, stratum: null }
  const rows = sample('a').map(r => ({ ...r, pass_reasons: { below_activation: 2, applied: 1 }, records: [rec] }))
  assert.deepEqual(Object.keys(rows[0]!).slice(0, 10), ['bench', 'engine', 'split', 'scenario', 'family', 'cluster', 'arm', 'window', 'seed', 'cost'])
  assert.equal(toJsonl(fromJsonl(toJsonl(rows))), toJsonl(rows))
  assert.deepEqual(selfCheck([...rows, ...sample('b', 5000)]).failures, [])
  for (const m of METRICS) {
    const d = pairedDifference(rows, sample('a'), m.name)
    if (d) assert.deepEqual([d.mean, d.lo, d.hi], [0, 0, 0], `${m.name}: records change no metric`)
  }
})
