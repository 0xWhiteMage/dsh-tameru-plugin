// Shared statistics for the whole-session replay: the row format the Hermes plugin and the engine's benchmarks also use, paired
// differences, and a seeded CLUSTER bootstrap (a cluster is a scenario: its rows at every window and seed are resampled together).
// The same shape and procedure as `benchmarks/engine_bench/report.py` in the engine repository: percentile intervals from resampling
// clusters with replacement, the number of clusters printed next to every interval. Standard library only.

export const SEED = 20261118
export const DRAWS = 2000

/** One run of one arm on one scenario at one window. Costs are in input-token equivalents. */
export interface Row {
  bench: 'replay'
  engine: string
  /** `burned-r1`: the round-1 holdout, burned, used as development data in round 2 (never confirmation). */
  split: 'dev' | 'validation' | 'holdout' | 'burned-r1'
  scenario: string
  family: string
  cluster: string
  arm: string
  window: number
  seed: number
  /** Primary pricing: cache read 0.1, write 1.0. */
  cost: number
  /** Sensitivity: cache read 0.1, write 1.25. */
  cost_w125: number
  facts_held: number
  facts_needed: number
  /** Results this arm's pass replaced with an extract. */
  shortened: number
  compactions: number
  /** Requests whose prompt no longer began with everything the previous request had sent (the provider's cache had to be rewritten). */
  rewrites: number
  /** Distinct results the engine was asked about, and how many its decision accepted / how many were then written. */
  eligible: number
  accepted: number
  applied: number
  /** Results rewritten a second time (must be 0). */
  second_rewrites: number
  /** Required facts present in an accepted result's original, and how many of those its extract kept. */
  extract_facts_possible: number
  extract_facts_kept: number
  /** Steps at which the stock pruner was about to cut, the results it would have cut there, and how many an extract replaced. */
  trigger_events: number
  trigger_events_replaced: number
  cuts_eligible: number
  cuts_replaced: number
  /** Mean milliseconds the pass took per step (not reproducible, and ignored by every comparison). */
  pass_ms: number
  /** Slowest single pass in the session (telemetry only). */
  pass_ms_max?: number
  /** Which budgets the run used: 'deterministic' pins them so the row never depends on machine load; 'timing' keeps production bounds. */
  eval_mode?: 'deterministic' | 'timing'
  /** The engine client timeout and the per-pass budget the run used. */
  timeout_ms?: number
  pass_budget_ms?: number
  /** Optional (rows written before P0 lack them; no comparison reads them): how often each pass ended with each reason. */
  pass_reasons?: Record<string, number>
  /** Optional: one record per act and per decline (consecutive repeats of the same outcome for the same result are folded). */
  records?: ReplayRecord[]
  /** Optional (P1b, round 2): what post-hoc pricing needs (scripts/replay/pricing.ts). Per model request [cached shared prefix tokens,
   *  whole prompt tokens, idle seconds since the previous request]; per compaction request [step, context tokens re-read]. */
  requests?: Array<[number, number, number]>
  summary_requests?: Array<[number, number]>
  summary_output_tokens?: number
  /** Steps at which the prompt was at or above the stock trigger before anything acted, and the largest prompt sent. */
  trigger_crossings?: number
  max_prompt_tokens?: number
  /** Optional (P2b, session corpus rows only): the corpus language (en / zh / mixed), the task style, the real-output share of the
   *  slice, every needed fact's presence at the end (line check and value-only), each question's held flag, and the run's wall time
   *  in ms (not reproducible; no comparison reads it). */
  lang?: string
  style?: string
  real_share?: number
  corpus_facts?: Array<{ id: string; kind: string; position: string; line_present: boolean; value_present: boolean }>
  questions_held?: Array<{ id: string; stratum: string; held: boolean }>
  run_ms?: number
}

/** What kind of moment an act or decline happened at. `forecast` and `cold` are reserved (not emitted yet). */
export type ReplayEventType = 'trigger' | 'forecast' | 'every-step' | 'cold' | 'none'

export interface ReplayRecord {
  /** Step index in the scenario. */
  step: number
  /** The result's identity (`seq:length`), as the plugin keys it. */
  key: string
  event: ReplayEventType
  outcome: 'act' | 'decline'
  /** `ok` for an act; otherwise the engine's `decide()` reason or the plugin's (`would_leave_cuts`, `longer_than_stock_cut`, `share`, `protected`, ...). */
  reason: string
  /** `engine`: the engine's decision; `plugin`: the plugin set it aside. */
  stage: 'engine' | 'plugin'
  original_chars: number
  /** The extract's length and the sha256 of its text (the text itself is never logged); null when the engine was not asked. */
  extract_chars: number | null
  extract_sha256: string | null
  /** Per needed fact whose value is in the original: is the value in the extract, and is its whole original line? */
  facts: Array<{ fact: number; value_present: boolean; line_present: boolean }>
  /** Reserved for the expected-value rule and calibration (always null for now). */
  p_hat: null
  value: null
  loss: null
  stratum: null
}

export const rowKey = (r: Pick<Row, 'scenario' | 'window' | 'seed'>): string => `${r.scenario}|${r.window}|${r.seed}`

export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Interval {
  mean: number
  /** Two-sided 95% percentile interval. */
  lo: number
  hi: number
  /** One-sided 95% bounds (the 5th and 95th percentiles), for the margin tests. */
  lo1: number
  hi1: number
  /** Number of rows, and of clusters resampled. */
  n: number
  clusters: number
}

const clean = (x: number): number => (Object.is(x, -0) ? 0 : x)

/**
 * Cluster bootstrap of `stat` over `items`: clusters are resampled with replacement and the statistic recomputed on the pooled rows.
 * `stat` returns undefined when it is not defined on a sample (e.g. a share with no denominator); such draws are skipped.
 */
export function clusterBootstrap<T>(items: Array<{ cluster: string; value: T }>, stat: (values: T[]) => number | undefined, draws = DRAWS, seed = SEED): Interval | undefined {
  const by = new Map<string, T[]>()
  for (const { cluster, value } of items) by.set(cluster, [...(by.get(cluster) ?? []), value])
  const keys = [...by.keys()].sort()
  const point = stat(items.map(i => i.value))
  if (point === undefined || keys.length === 0) return undefined
  const r = rng(seed)
  const values: number[] = []
  for (let d = 0; d < draws; d++) {
    const sample: T[] = []
    for (let k = 0; k < keys.length; k++) sample.push(...by.get(keys[Math.floor(r() * keys.length)]!)!)
    const v = stat(sample)
    if (v !== undefined) values.push(v)
  }
  values.sort((a, b) => a - b)
  const at = (p: number): number => values[Math.floor(p * (values.length - 1))] ?? point
  return { mean: clean(point), lo: clean(at(0.025)), hi: clean(at(0.975)), lo1: clean(at(0.05)), hi1: clean(at(0.95)), n: items.length, clusters: keys.length }
}

export interface Pair {
  a: Row
  b: Row
}

/** Rows of two arms matched on (scenario, window, seed). Unmatched rows are dropped. */
export function paired(aRows: Row[], bRows: Row[]): Pair[] {
  const a = new Map(aRows.map(r => [rowKey(r), r]))
  const out: Pair[] = []
  for (const b of bRows) {
    const m = a.get(rowKey(b))
    if (m) out.push({ a: m, b })
  }
  return out
}

const mean = (xs: number[]): number | undefined => (xs.length === 0 ? undefined : xs.reduce((s, x) => s + x, 0) / xs.length)
const sum = (rows: Row[], f: (r: Row) => number): number => rows.reduce((s, r) => s + f(r), 0)
const ratio = (num: number, den: number): number | undefined => (den > 0 ? num / den : undefined)

/** A statistic of the pairs, in the unit named. Every one is exactly 0 when both arms are the same rows. */
export interface Metric {
  name: string
  unit: string
  stat: (pairs: Pair[]) => number | undefined
}

const rel = (f: (r: Row) => number) => (pairs: Pair[]): number | undefined => mean(pairs.map(p => 100 * (f(p.b) / f(p.a) - 1)))
const diff = (f: (r: Row) => number, scale = 1) => (pairs: Pair[]): number | undefined => mean(pairs.map(p => scale * (f(p.b) - f(p.a))))
const shareDiff = (num: (r: Row) => number, den: (r: Row) => number) => (pairs: Pair[]): number | undefined => {
  const a = ratio(sum(pairs.map(p => p.a), num), sum(pairs.map(p => p.a), den))
  const b = ratio(sum(pairs.map(p => p.b), num), sum(pairs.map(p => p.b), den))
  return a === undefined || b === undefined ? undefined : 100 * (b - a)
}

export const METRICS: Metric[] = [
  { name: 'cost', unit: '% (read 0.1, write 1.0)', stat: rel(r => r.cost) },
  { name: 'cost_w125', unit: '% (read 0.1, write 1.25)', stat: rel(r => r.cost_w125) },
  { name: 'facts_kept', unit: 'points of the needed facts', stat: diff(r => r.facts_held / r.facts_needed, 100) },
  { name: 'facts_held', unit: 'facts per session', stat: diff(r => r.facts_held) },
  { name: 'shortened', unit: 'per session', stat: diff(r => r.shortened) },
  { name: 'rewrites', unit: 'per session', stat: diff(r => r.rewrites) },
  { name: 'compactions', unit: 'per session', stat: diff(r => r.compactions) },
  { name: 'accepted_share', unit: 'points of the results asked about', stat: shareDiff(r => r.accepted, r => r.eligible) },
  { name: 'applied_share', unit: 'points of the results asked about', stat: shareDiff(r => r.applied, r => r.eligible) },
  { name: 'extract_replaces_cut_events', unit: 'points of trigger events', stat: shareDiff(r => r.trigger_events_replaced, r => r.trigger_events) },
  { name: 'extract_replaces_cut_items', unit: 'points of the results the stock pruner would cut', stat: shareDiff(r => r.cuts_replaced, r => r.cuts_eligible) },
]

export const metricByName = (name: string): Metric => {
  const m = METRICS.find(x => x.name === name)
  if (!m) throw new Error(`unknown metric ${name}`)
  return m
}

/** The paired difference B - A on any statistic of the pairs, with its cluster interval. */
export function pairedStat(aRows: Row[], bRows: Row[], stat: (pairs: Pair[]) => number | undefined, draws = DRAWS, seed = SEED): Interval | undefined {
  const pairs = paired(aRows, bRows)
  return clusterBootstrap(pairs.map(p => ({ cluster: p.b.cluster, value: p })), stat, draws, seed)
}

/** The paired difference B - A on one metric, with its cluster interval. */
export function pairedDifference(aRows: Row[], bRows: Row[], metric: string, draws = DRAWS): Interval | undefined {
  const m = metricByName(metric)
  const pairs = paired(aRows, bRows)
  return clusterBootstrap(pairs.map(p => ({ cluster: p.b.cluster, value: p })), vs => m.stat(vs), draws)
}

/** One arm on its own: a statistic of its rows with a cluster interval. */
export function armStat(rows: Row[], f: (rows: Row[]) => number | undefined, draws = DRAWS): Interval | undefined {
  return clusterBootstrap(rows.map(r => ({ cluster: r.cluster, value: r })), f, draws)
}

export const factsKeptShare = (rows: Row[]): number | undefined => ratio(sum(rows, r => r.facts_held), sum(rows, r => r.facts_needed))
export const meanOf = (f: (r: Row) => number) => (rows: Row[]): number | undefined => mean(rows.map(f))
export const shareOf = (num: (r: Row) => number, den: (r: Row) => number) => (rows: Row[]): number | undefined => ratio(sum(rows, num), sum(rows, den))

/** Arm against itself: every paired difference on every metric must be exactly 0 (mean and all four bounds). */
export function selfCheck(rows: Row[], draws = 200): { ok: boolean; failures: string[] } {
  const failures: string[] = []
  const arms = [...new Set(rows.map(r => r.arm))]
  for (const arm of arms) {
    const sub = rows.filter(r => r.arm === arm)
    for (const m of METRICS) {
      const d = pairedDifference(sub, sub, m.name, draws)
      if (d === undefined) continue // not defined for this arm (e.g. no trigger events)
      if (![d.mean, d.lo, d.hi, d.lo1, d.hi1].every(x => x === 0)) failures.push(`${arm} ${m.name}: ${JSON.stringify(d)}`)
    }
  }
  return { ok: failures.length === 0, failures }
}

// ---- jsonl --------------------------------------------------------------------------------------------------------------------------

export const toJsonl = (rows: Row[]): string => rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
export const fromJsonl = (text: string): Row[] =>
  text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Row)

// ---- formatting -----------------------------------------------------------------------------------------------------------------------

export const fmt = (x: number, digits = 1, sign = false): string => {
  const v = clean(Number(x.toFixed(digits)))
  return `${sign && v > 0 ? '+' : ''}${v.toFixed(digits)}`
}
export const fmtInterval = (i: Interval | undefined, digits = 1, sign = true): string => (i === undefined ? 'n/a' : `${fmt(i.mean, digits, sign)} [${fmt(i.lo, digits, sign)}, ${fmt(i.hi, digits, sign)}]`)
