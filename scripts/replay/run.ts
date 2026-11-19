// One simulated session under one arm, priced against a provider cache.
//
// REAL parts: the Harness's session log, token meter and tool-result pruner (extracted into dev/harness), the plugin's own step pass
// (`onPreStep`, both policies), and the Tameru engine through the vendored worker. SIMULATED parts: the model (it only produces tool
// calls), and the Harness's summary compaction, replaced by a fixed-size summary that keeps NO facts (the worst case for every arm
// alike). Prices are in input-token equivalents: cache reads cost R, rewritten or new tokens W (primary R 0.1 / W 1.0, DeepSeek-like;
// R 0.1 / W 1.25 as a sensitivity). Output tokens are not priced except the summary a compaction writes (4x). REPLAY ONLY: no model ran.
import { createHash } from 'node:crypto'
import type { EngineClient } from '../../src/host/engine-client.ts'
import { readSurface, type PassEvent } from '../../src/host/shorten.ts'
import { onPreStep, type ChatStats, type StepAgent, type StepDeps, type TameruSettings } from '../../src/host/step.ts'
import { stockThreshold } from '../../src/host/stock.ts'
import { world } from '../../test/helpers/harness.ts'
import type { ReplayEventType, ReplayRecord, Row } from './stats.ts'
import type { Scenario } from './scenarios.ts'

export const OUTPUT_CAP = 8000
const OVERHEAD_TOKENS = 4000 // system prompt and tool schemas, identical in both arms and always cached after the first request
const SUMMARY_TOKENS = 2000
const SUMMARY_OUTPUT_WEIGHT = 4
export const WINDOWS = [128_000, 200_000]

export interface ArmSpec {
  name: string
  /** Which engine answers: the 1.10.0 worker, or the 1.9.0 baseline worker. `none` is the stock Harness alone. */
  engine: 'none' | '1.9.0' | '1.10.0'
  settings: TameruSettings
}

const hash = (m: unknown): string => createHash('sha1').update(JSON.stringify(m)).digest('hex')

const GATES = [0.5, 0.6, 0.7, 0.8, 0.85]
const g = (name: string, gate: number, share: number, activation: number, extra: TameruSettings = {}): ArmSpec => ({ name, engine: '1.10.0', settings: { policy: 'every-step', minConfidence: gate, share, activation, ...extra } })
const h = (name: string, gate: number, share: number, extra: TameruSettings = {}): ArmSpec => ({ name, engine: '1.10.0', settings: { policy: 'hybrid', minConfidence: gate, share, ...extra } })
/**
 * Every arm: stock, the 1.9.0-era plugin, round 1 (policy G at five gates, policy T at two: 7 settings) and round 2 (19 new settings,
 * declared in the engine's analysis plan before they were run). Order inside a family is from less to more conservative (later wins ties).
 */
export const ARMS: ArmSpec[] = [
  { name: 'stock', engine: 'none', settings: {} },
  // the 1.9.0-era plugin's own behaviour, stated explicitly: with `settings: {}` this arm followed whatever the shipped default was, so
  // after the round 2 default change it ran at-trigger with no gate (that is how the round 1 holdout look's baseline rows were made)
  { name: 'baseline-1.9.0', engine: '1.9.0', settings: { policy: 'every-step', minConfidence: 0.7 } },
  ...GATES.map(gate => ({ name: `G-${gate}`, engine: '1.10.0' as const, settings: { policy: 'every-step' as const, minConfidence: gate } })),
  { name: 'T-0', engine: '1.10.0', settings: { policy: 'at-trigger', minConfidence: 0 } },
  { name: 'T-0.7', engine: '1.10.0', settings: { policy: 'at-trigger', minConfidence: 0.7 } },
  // round 2
  g('G1', 0.85, 0.35, 0.9),
  g('G2', 0.85, 0.5, 0.75),
  g('G3', 0.85, 0.65, 0.75),
  g('G4', 0.85, 0.5, 0.9),
  g('G5', 0.85, 0.65, 0.9),
  g('G6', 0.85, 0.5, 1.0),
  g('G7', 0.85, 0.65, 1.0),
  g('G8', 0.85, 0.5, 0.9, { minResultChars: 12000 }),
  g('G9', 0.85, 0.65, 0.9, { minResultChars: 12000 }),
  g('G10', 0.85, 0.5, 0.9, { protectRecent: 8 }),
  g('G11', 0.85, 0.5, 0.9, { maxPerPass: 8 }),
  g('G12', 0.7, 0.5, 0.9),
  g('G13', 0.7, 0.65, 1.0),
  { name: 'T3', engine: '1.10.0', settings: { policy: 'at-trigger', minConfidence: 0.85 } },
  h('H1', 0.85, 0.35),
  h('H2', 0.85, 0.5),
  h('H3', 0.85, 0.65),
  h('H4', 0.7, 0.5),
  h('H5', 0.85, 0.5, { protectRecent: 8 }),
]
export const ROUND1_ARMS = 7
export const SETTINGS_TRIED = ARMS.filter(a => a.engine === '1.10.0').length

const textLength = (m: any): number => (m.content ?? []).reduce((s: number, b: any) => s + (b.type === 'text' ? Array.from(b.text as string).length : 0), 0)

export async function runArm(arm: ArmSpec, sc: Scenario, window: number, client: EngineClient | undefined, split: Row['split'], engineLabel: string): Promise<Row> {
  const w = await world(sc.task)
  w.header(OUTPUT_CAP)
  const threshold = stockThreshold({ contextWindow: window, reservedCompletionTokens: OUTPUT_CAP })!
  const retain = Math.floor((window - OUTPUT_CAP) * 0.16)
  const stats = new WeakMap<object, ChatStats>()
  const decided = new Map<string, boolean>()
  const appliedOrigins = new Map<number, number>()
  let possible = 0
  let kept = 0
  let stepIndex = 0
  const records: ReplayRecord[] = []
  const lastRecord = new Map<string, ReplayRecord>()
  const seen = new Map<string, { original: string; extract: string }>()
  const passReasons: Record<string, number> = {}
  const factsOf = (original: string, extract: string): ReplayRecord['facts'] =>
    sc.needed.flatMap((v, fact) => {
      if (!original.includes(v)) return []
      const line = original.split('\n').find(l => l.includes(v))!.trim()
      return [{ fact, value_present: extract.includes(v), line_present: extract.includes(line) }]
    })
  const record = (key: string, event: ReplayEventType | undefined, outcome: ReplayRecord['outcome'], reason: string, stage: ReplayRecord['stage']): void => {
    const last = lastRecord.get(key)
    if (last && last.outcome === outcome && last.reason === reason) return // a repeat of the same outcome at a later step
    const texts = seen.get(key)
    const originalChars = texts ? Array.from(texts.original).length : Number(key.split(':')[1] ?? 0)
    const r: ReplayRecord = {
      step: stepIndex, key, event: event ?? 'none', outcome, reason, stage, original_chars: originalChars,
      extract_chars: texts ? Array.from(texts.extract).length : null,
      extract_sha256: texts ? createHash('sha256').update(texts.extract).digest('hex') : null,
      facts: texts ? factsOf(texts.original, texts.extract) : [],
      p_hat: null, value: null, loss: null, stratum: null,
    }
    records.push(r)
    lastRecord.set(key, r)
  }
  const observe = (e: PassEvent): void => {
    if (e.kind === 'decision') {
      seen.set(e.key, { original: e.original, extract: e.extract })
      if (!e.accept) record(e.key, e.event, 'decline', e.reason, 'engine')
      if (decided.has(e.key)) return
      decided.set(e.key, e.accept)
      if (e.accept) {
        for (const v of sc.needed) {
          if (!e.original.includes(v)) continue
          possible++
          if (e.extract.includes(v)) kept++
        }
      }
    } else if (e.kind === 'decline') {
      record(e.key, e.event, 'decline', e.reason, 'plugin')
    } else {
      record(e.key, e.event, 'act', 'ok', 'plugin')
      appliedOrigins.set(e.origin, (appliedOrigins.get(e.origin) ?? 0) + 1)
    }
  }
  const deps: StepDeps = {
    client: client as EngineClient,
    meter: () => w.meter,
    resolveModelInfo: async () => ({ context: { contextWindow: window }, defaultMaxTokens: OUTPUT_CAP }),
    backendFor: () => ({ config: { auto: true } }),
    // every arm states its own policy; the beta channel lets `policy` take effect (stable would force every-step)
    settings: { channel: 'beta', ...arm.settings },
    stats,
    observe,
  }
  const agent = { session: w.session } as unknown as StepAgent
  const requests: Array<[number, number]> = []
  const summaries: number[] = []
  const passMs: number[] = []
  let compactions = 0
  let shortened = 0
  let triggerEvents = 0
  let triggerReplaced = 0
  let cutsEligible = 0
  let cutsReplaced = 0
  let previous: Array<{ key: string; tokens: number }> = []
  let previousAll = 0
  let rewrites = 0
  const tokens = (m: any): number => w.meter.estimateMessage(m)
  const total = (): number => w.meter.measure(w.session, w.session.requestHeader()).totalTokens

  const compact = (): boolean => {
    const entries = readSurface(w.session)
    let sum = 0
    let tail = entries.length
    while (tail > 1 && sum < retain) sum += tokens(entries[--tail]!.message)
    while (tail < entries.length && entries[tail]!.message.role !== 'assistant') tail++
    if (tail <= 2 || tail >= entries.length) return false
    const range = entries.slice(1, tail).map(e => e.seq)
    summaries.push(OVERHEAD_TOKENS + entries.reduce((s, e) => s + tokens(e.message), 0))
    const text = `Summary of earlier work. Task: ${sc.task} ${'The agent ran test suites and reviewed their output; routine progress was made. '.repeat(Math.ceil((SUMMARY_TOKENS * 3.5) / 80))}`.slice(0, SUMMARY_TOKENS * 3.5)
    w.session.append('user/message', { id: `sum${compactions}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: { op: 'replace', startSeq: range[0]!, endSeq: range.at(-1)! }, sourceEventSeqs: range })
    compactions++
    return true
  }

  for (const [i, step] of sc.steps.entries()) {
    stepIndex = i
    w.step({ name: step.tool, args: step.args }, step.output)
    // would the Harness's own pruner cut at this step, and how many results would it cut
    const triggered = total() >= threshold
    const wouldCut = triggered ? readSurface(w.session).filter(e => e.event.type === 'tool/result' && textLength(e.message) > 8192).length : 0
    if (arm.engine !== 'none') {
      const started = performance.now()
      const outcome = await onPreStep(deps, agent)
      passMs.push(performance.now() - started)
      const passReason = outcome.kind === 'applied' ? 'applied' : outcome.reason
      passReasons[passReason] = (passReasons[passReason] ?? 0) + 1
      if (outcome.kind === 'applied') {
        shortened += outcome.applied.length
        if (triggered && wouldCut > 0) {
          triggerReplaced += 1
          cutsReplaced += outcome.applied.length
        }
      }
    }
    if (triggered && wouldCut > 0) {
      triggerEvents += 1
      cutsEligible += wouldCut
    }
    if (total() >= threshold) {
      ;(w.ctx as any).toolResultPruner.pruneSession(w.session) // the Harness's own pruner, as its backend calls it at pressure
      for (let guard = 0; guard < 3 && total() >= threshold; guard++) if (!compact()) break
    }
    // the model request: price it against what the previous request left in the provider's cache
    const messages = w.session.deriveMessages()
    const entries = messages.map((m: any) => ({ key: hash(m), tokens: tokens(m) }))
    const all = OVERHEAD_TOKENS + entries.reduce((s: number, e: any) => s + e.tokens, 0)
    let cached = i === 0 ? 0 : OVERHEAD_TOKENS
    if (i > 0) for (let k = 0; k < Math.min(previous.length, entries.length) && previous[k]!.key === entries[k]!.key; k++) cached += entries[k]!.tokens
    if (i > 0 && cached < previousAll) rewrites++
    requests.push([cached, all])
    previous = entries
    previousAll = all
  }
  const finalText = w.session.deriveMessages().map((m: any) => JSON.stringify(m.content)).join('\n')
  const factsHeld = sc.needed.filter(v => finalText.includes(v)).length
  await w.ctx.fiber.dispose()
  const cost = (read: number, write: number): number =>
    requests.reduce((s, [cached, all]) => s + read * cached + write * (all - cached), 0) + summaries.reduce((s, replay) => s + read * replay + SUMMARY_TOKENS * SUMMARY_OUTPUT_WEIGHT, 0)
  return {
    bench: 'replay',
    engine: engineLabel,
    split,
    scenario: sc.id,
    family: sc.family,
    cluster: sc.id,
    arm: arm.name,
    window,
    seed: sc.seed,
    cost: cost(0.1, 1.0),
    cost_w125: cost(0.1, 1.25),
    facts_held: factsHeld,
    facts_needed: sc.needed.length,
    shortened,
    compactions,
    rewrites,
    eligible: decided.size,
    accepted: [...decided.values()].filter(Boolean).length,
    applied: appliedOrigins.size,
    second_rewrites: [...appliedOrigins.values()].filter(n => n > 1).length,
    extract_facts_possible: possible,
    extract_facts_kept: kept,
    trigger_events: triggerEvents,
    trigger_events_replaced: triggerReplaced,
    cuts_eligible: cutsEligible,
    cuts_replaced: cutsReplaced,
    pass_ms: passMs.length ? passMs.reduce((a, b) => a + b, 0) / passMs.length : 0,
    pass_reasons: passReasons,
    records,
  }
}
