// P1b: post-hoc pricing of replay rows under the engine's dated price profiles, the settings-tried ledger check, and the arms' settings.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HOLDOUT_LOOKS_FILE, loadBurnedAsDev } from '../scripts/replay/holdout.ts'
import { LEDGER_COPY, readLedger, refuseUnledgered } from '../scripts/replay/ledger.ts'
import { LEGACY, LEGACY_W125, PRICES_COPY, PRICES_SHA256, config, idleGaps, loadProfiles, price, registeredConfigs, sensitivityConfigs, sha256Lf, type Usage } from '../scripts/replay/pricing.ts'
import { GROUPS, repricedSelfCheck } from '../scripts/replay/reprice.ts'
import { ARMS, BASELINE_190_SETTINGS, SETTINGS_TRIED, type ArmSpec } from '../scripts/replay/run.ts'
import { rng, selfCheck, type Row } from '../scripts/replay/stats.ts'
import { root } from './helpers/harness.ts'

const ENGINE = process.env.TAMERU_ENGINE_DIR ?? join(root, '..', 'Tameru')

test('the committed prices copy is the engine file (sha256 pinned, and compared with the engine when it is checked out)', () => {
  assert.equal(sha256Lf(readFileSync(PRICES_COPY, 'utf8')), PRICES_SHA256)
  const engineFile = join(ENGINE, 'src', 'tameru', 'prices.json')
  if (existsSync(engineFile)) assert.equal(sha256Lf(readFileSync(engineFile, 'utf8')), PRICES_SHA256, 'the engine prices changed: copy it again and re-run the reprice')
  const p = loadProfiles()
  assert.ok(p.has('deepseek-v4-pro') && p.has('deepseek-flash') && p.has('anthropic-sonnet-5.5-5m') && p.has('openai-generic-30m'))
  assert.equal(p.get('deepseek-v4-pro')!.ttl_s, null)
})

const usage = (requests: Usage['requests'], summary_requests: Usage['summary_requests'] = []): Usage => ({ requests, summary_requests, summary_output_tokens: 2000 })

test('the legacy profile reproduces the pre-P1b row cost exactly (read 0.1, write 1.0 or 1.25, summary output 4)', () => {
  const u = usage([[0, 10_000, 0], [9_000, 12_000, 30], [12_000, 15_000, 20], [5_000, 9_000, 4000]], [[2, 14_000]])
  const old = (w: number): number => 0.1 * 9000 + w * 3000 + 0.1 * 12000 + w * 3000 + 0.1 * 5000 + w * 4000 + w * 10000 + 0.1 * 14000 + 4 * 2000
  assert.equal(price(u, config(LEGACY, 'none', 1)).total, old(1))
  assert.equal(price(u, config(LEGACY_W125, 'none', 1)).total, old(1.25))
})

test('the legacy profile reproduces the committed repriced rows', () => {
  const file = join(root, 'docs', 'results', 'replay-repriced-1.10.0-rows.jsonl')
  if (!existsSync(file)) return
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(0, 200).map(l => JSON.parse(l) as Row & Usage)
  for (const r of rows) {
    assert.ok(Math.abs(price(r, config(LEGACY, 'none', 1)).total - r.cost) < 1e-6 * r.cost, `${r.scenario} ${r.arm}`)
    assert.ok(Math.abs(price(r, config(LEGACY_W125, 'none', 1)).total - r.cost_w125) < 1e-6 * r.cost_w125)
  }
})

test('an idle gap longer than the TTL writes the whole prompt again (the compaction request first, if there is one)', () => {
  const pro = loadProfiles().get('deepseek-v4-pro')!
  const u = usage([[0, 10_000, 0], [10_000, 11_000, 400]])
  const warm = price(u, config(pro))
  const cold = price(u, config(pro, 300))
  assert.equal(warm.expiries, 0)
  assert.equal(cold.expiries, 1)
  assert.ok(Math.abs(warm.write - 11_000) < 1e-9 && Math.abs(cold.write - 21_000) < 1e-9)
  const withSummary = price(usage([[0, 10_000, 0], [10_000, 11_000, 400]], [[1, 10_500]]), config(pro, 300))
  assert.ok(Math.abs(withSummary.write - (10_000 + 10_500 + 1_000)) < 1e-9, 'the compaction request pays the rewrite; the step request then hits')
})

test('a partial hit counts whole prefix units only; a hit on the whole previous prompt is never rounded', () => {
  const pro = loadProfiles().get('deepseek-v4-pro')!
  const u = usage([[0, 1000, 0], [1000, 1100, 1], [700, 1200, 1]])
  const b = price(u, config(pro, 'profile', 64))
  // request 1: hit 1000 (whole previous); request 2: floor(700 / 64) * 64 = 640
  assert.ok(Math.abs(b.write - (1000 + 100 + (1200 - 640))) < 1e-9)
  assert.ok(Math.abs(b.read - pro.r * (1000 + 640)) < 1e-9)
})

test('long-context tiers: Haiku 5.5 x5 on every price above 100K, OpenAI 2x on input only above 272K, generic OpenAI output at 5', () => {
  const haiku = loadProfiles().get('anthropic-haiku-5.5-5m')!
  const openai = loadProfiles().get('openai-generic-30m')!
  const below = price(usage([[0, 100_000, 0]], [[0, 100_000]]), config(haiku, 'none'))
  const above = price(usage([[0, 100_001, 0]], [[0, 100_001]]), config(haiku, 'none'))
  assert.ok(Math.abs(above.output / below.output - 5) < 1e-12)
  assert.ok(Math.abs(above.write / below.write - 5 * (100_001 / 100_000)) < 1e-9)
  const o1 = price(usage([[0, 272_000, 0]], [[0, 272_001]]), config(openai, 'none'))
  assert.equal(o1.output, 5 * 2000)
  assert.ok(Math.abs(o1.read - 0.1 * 272_001 * 2) < 1e-6 && Math.abs(o1.write - 1.25 * 272_000) < 1e-6)
})

test('idle gaps depend only on the scenario seed and step (arms stay paired), and are deterministic', () => {
  assert.deepEqual(idleGaps(3101, 50, rng), idleGaps(3101, 50, rng))
  assert.notDeepEqual(idleGaps(3101, 50, rng), idleGaps(3102, 50, rng))
  assert.equal(idleGaps(7, 10, rng)[0], 0)
})

function syntheticRows(): Row[] {
  const out: Row[] = []
  for (const split of ['dev', 'validation', 'burned-r1'] as const) {
    for (let s = 0; s < 6; s++) {
      for (const window of [128_000, 252_000, 500_000, 1_000_000]) {
        for (const [ai, arm] of ['stock', 'baseline-1.9.0', 'T-0'].entries()) {
          const gaps = idleGaps(100 + s, 20, rng)
          const requests: Array<[number, number, number]> = gaps.map((g, k) => [k === 0 ? 0 : 4000 + k * 3000 - (k % 5 === ai ? 2500 : 0), 4000 + (k + 1) * 3000 + (window > 300_000 ? 280_000 : 0), g])
          out.push({ bench: 'replay', engine: '1.10.0', split, scenario: `${split}-${s}`, family: 'f', cluster: `${split}-${s}`, arm, window, seed: s, cost: 1, cost_w125: 1, facts_held: s % 3, facts_needed: 4, shortened: ai, compactions: 1, rewrites: ai, eligible: 4, accepted: 2, applied: 1, second_rewrites: 0, extract_facts_possible: 2, extract_facts_kept: 2, trigger_events: 2, trigger_events_replaced: 1, cuts_eligible: 3, cuts_replaced: 1, pass_ms: 1, requests, summary_requests: [[7, 30_000 + ai]], summary_output_tokens: 2000 })
        }
      }
    }
  }
  return out
}

test('arm vs itself is exactly zero at every window (128K/252K/500K/1M) and every price profile, TTL and the weighted D', () => {
  const rows = syntheticRows()
  assert.deepEqual(selfCheck(rows).failures, [])
  assert.deepEqual(repricedSelfCheck(rows, [...registeredConfigs(), ...sensitivityConfigs()], 50, GROUPS), [])
  assert.ok(sensitivityConfigs().length >= 14)
})

test('no arm is defined with empty settings; the 1.9.0-era arm states every-step, gate 0.7, activation 0.75, share 0.35 on the 1.9.0 worker', () => {
  for (const a of ARMS) assert.ok(Object.keys(a.settings).length > 0, `${a.name} has empty settings`)
  const base = ARMS.find(a => a.name === 'baseline-1.9.0')!
  assert.equal(base.engine, '1.9.0')
  assert.deepEqual(base.settings, { policy: 'every-step', minConfidence: 0.7, activation: 0.75, share: 0.35 })
  assert.deepEqual(BASELINE_190_SETTINGS, base.settings)
  assert.equal(SETTINGS_TRIED, 26)
})

test('every non-reference arm is in the settings-tried ledger, and the runner refuses one that is not', () => {
  const ledger = readLedger(LEDGER_COPY)
  refuseUnledgered(ARMS, ledger)
  const rogue: ArmSpec = { name: 'G-new', ledgerId: 'G-new', engine: '1.10.0', settings: { policy: 'every-step', minConfidence: 0.75 } }
  assert.throws(() => refuseUnledgered([rogue], ledger), /not in the settings-tried ledger/)
  assert.throws(() => refuseUnledgered([{ ...rogue, ledgerId: undefined }], ledger), /G-new/)
  const engineLedger = join(ENGINE, 'docs', 'SETTINGS-TRIED-LEDGER.json')
  if (existsSync(engineLedger)) {
    const e = readLedger(engineLedger)
    assert.deepEqual(e.settings.slice(0, ledger.settings.length), ledger.settings, 'the ledger is append only: the committed copy is a prefix of the engine file')
  }
})

test('the burned round-1 holdout loads as development data without logging a look', () => {
  const before = readFileSync(HOLDOUT_LOOKS_FILE, 'utf8')
  const scenarios = loadBurnedAsDev()
  assert.equal(scenarios.length, 48)
  assert.equal(readFileSync(HOLDOUT_LOOKS_FILE, 'utf8'), before)
  assert.throws(() => loadBurnedAsDev(join(root, 'test', 'fixtures', 'replay', 'no-such-file.md')), /not listed as burned/)
})
