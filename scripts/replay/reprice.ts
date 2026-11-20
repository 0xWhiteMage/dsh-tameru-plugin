// Re-pricing of replay rows under every dated price profile (round 2, P1b). REPLAY ONLY: no model ran and no cache was probed.
//
// D_p = 100 x (sum over scenarios of C_p(arm) - sum of C_p(reference)) / sum of C_p(reference), pooled per window (round-2 analysis plan,
// section 4); the weighted D is the registered 1/4 mix of the DeepSeek plugin's four profiles, its resamples shared across profiles.
// Intervals: cluster bootstrap by scenario (stats.ts), 10,000 draws for the weighted D, 2,000 for each profile; clusters printed.
import { LEGACY, REGISTERED, config, price, registeredConfigs, sensitivityConfigs, ttlOf, type Breakdown, type PriceConfig, type Usage } from './pricing.ts'
import { fmt, fmtInterval, pairedDifference, pairedStat, selfCheck, type Interval, type Pair, type Row } from './stats.ts'

export const REFERENCE = 'baseline-1.9.0'
export const PRIMARY_DRAWS = 10_000
const ARM_ORDER = ['stock', 'baseline-1.9.0', 'G-0.7', 'default-1.10.0', 'G-0.85', 'T-0', 'T-0.7']

const memo = new WeakMap<Row, Map<string, Breakdown>>()
export function costOf(row: Row, c: PriceConfig): Breakdown {
  let m = memo.get(row)
  if (!m) memo.set(row, (m = new Map()))
  let b = m.get(c.label)
  if (!b) {
    if (!row.requests || !row.summary_requests || row.summary_output_tokens === undefined) throw new Error(`row ${row.scenario}/${row.arm} has no pricing quantities (made before P1b)`)
    b = price(row as Row & Usage, c)
    m.set(c.label, b)
  }
  return b
}

const total = (rows: Row[], c: PriceConfig): number => rows.reduce((s, r) => s + costOf(r, c).total, 0)
/** Pooled percent difference B vs A under one config. */
export const pooled = (c: PriceConfig) => (pairs: Pair[]): number | undefined => {
  const a = total(pairs.map(p => p.a), c)
  return a > 0 ? 100 * (total(pairs.map(p => p.b), c) / a - 1) : undefined
}
/** The registered weighted D (equal weights over the given configs). */
export const weighted = (cs: PriceConfig[]) => (pairs: Pair[]): number | undefined => {
  let s = 0
  for (const c of cs) {
    const d = pooled(c)(pairs)
    if (d === undefined) return undefined
    s += d / cs.length
  }
  return s
}
/** The pre-P1b statistic: the mean of per-scenario percent differences (how the round-1/2 numbers were computed). */
export const meanOfRatios = (c: PriceConfig) => (pairs: Pair[]): number | undefined =>
  pairs.length === 0 ? undefined : pairs.reduce((s, p) => s + 100 * (costOf(p.b, c).total / costOf(p.a, c).total - 1), 0) / pairs.length

export interface Group {
  name: string
  filter: (r: Row) => boolean
}
export const GROUPS: Group[] = [
  { name: 'dev+validation (60)', filter: r => r.split === 'dev' || r.split === 'validation' },
  { name: 'burned-r1 (48, development data)', filter: r => r.split === 'burned-r1' },
]

const sel = (rows: Row[], g: Group, arm: string, window?: number): Row[] => rows.filter(r => g.filter(r) && r.arm === arm && (window === undefined || r.window === window))
const sign = (x: number): number => (Math.abs(x) < 1e-9 ? 0 : Math.sign(x))
const clusters = (rows: Row[]): number => new Set(rows.map(r => r.cluster)).size

export interface RepriceJson {
  selfCheckOk: boolean
  selfCheckFailures: string[]
  configs: Array<{ label: string; profile: string; ttl_s: number | null; unit: number; registered: boolean }>
  crossings: Array<{ group: string; window: number; sessions: number; atLeast1: number; atLeast2: number; mean: number }>
  results: Array<{ group: string; window: number; arm: string; reference: string; weighted: Interval | undefined; perConfig: Record<string, Interval | undefined> }>
  signChanges: Array<{ group: string; window: number; arm: string; reference: string; config: string; legacy: number; repriced: number }>
  restated: Array<{ split: string; windows: string; config: string; meanOfRatios: Interval | undefined; pooled: Interval | undefined }>
}

/** Arm vs itself under every config (and the weighted D) at every window and group: every interval must be exactly 0. */
export function repricedSelfCheck(rows: Row[], configs: PriceConfig[], draws = 100, groups: Group[] = GROUPS): string[] {
  const failures: string[] = []
  const reg = registeredConfigs()
  for (const g of groups) {
    for (const window of [...new Set(rows.map(r => r.window))].sort()) {
      for (const arm of [...new Set(rows.map(r => r.arm))]) {
        const sub = sel(rows, g, arm, window)
        if (!sub.length) continue
        const stats: Array<[string, (p: Pair[]) => number | undefined]> = [...configs.map(c => [c.label, pooled(c)] as [string, (p: Pair[]) => number | undefined]), ['weighted', weighted(reg)]]
        for (const [label, stat] of stats) {
          const d = pairedStat(sub, sub, stat, draws)
          if (!d || ![d.mean, d.lo, d.hi, d.lo1, d.hi1].every(x => x === 0)) failures.push(`${g.name} ${window} ${arm} ${label}: ${JSON.stringify(d)}`)
        }
      }
    }
  }
  return failures
}

export function repriceReport(rows: Row[]): { text: string; json: RepriceJson } {
  const reg = registeredConfigs()
  const sens = sensitivityConfigs()
  const all = [...reg, ...sens]
  const legacy = sens.find(c => c.profile === LEGACY)!
  const windows = [...new Set(rows.map(r => r.window))].sort((a, b) => a - b)
  const arms = ARM_ORDER.filter(a => rows.some(r => r.arm === a))
  const failures = [...selfCheck(rows).failures, ...repricedSelfCheck(rows, all)]
  const json: RepriceJson = {
    selfCheckOk: failures.length === 0,
    selfCheckFailures: failures,
    configs: all.map(c => ({ label: c.label, profile: c.profile.name, ttl_s: ttlOf(c), unit: c.unitTokens, registered: reg.includes(c) })),
    crossings: [],
    results: [],
    signChanges: [],
    restated: [],
  }
  const out: string[] = []
  out.push(`Rows: ${rows.length}; arms: ${arms.join(', ')}; windows: ${windows.map(w => `${w / 1000}K`).join(', ')}.`)
  out.push(`Arm vs itself, every metric, every window, every price config and the weighted D: ${failures.length === 0 ? 'exactly 0' : `FAILED (${failures.length}): ${failures.slice(0, 5).join('; ')}`}.`)
  out.push(`All costs are in miss-units (one uncached input token = 1) and are REPLAY ONLY. D = pooled percent difference; weighted = registered 1/4 each of ${REGISTERED.join(', ')}.`)

  out.push('\n## Trigger crossings per window (stock arm: steps at or above the stock trigger)\n')
  out.push('| group | window | sessions | crossed >= 1 | crossed >= 2 | crossings / session |\n|---|--:|--:|--:|--:|--:|')
  for (const g of GROUPS) {
    for (const window of windows) {
      const st = sel(rows, g, 'stock', window)
      if (!st.length) continue
      const c = st.map(r => r.trigger_crossings ?? 0)
      const row = { group: g.name, window, sessions: st.length, atLeast1: c.filter(x => x >= 1).length / st.length, atLeast2: c.filter(x => x >= 2).length / st.length, mean: c.reduce((a, b) => a + b, 0) / st.length }
      json.crossings.push(row)
      out.push(`| ${g.name} | ${window / 1000}K | ${st.length} | ${fmt(100 * row.atLeast1, 0)}% | ${fmt(100 * row.atLeast2, 0)}% | ${fmt(row.mean, 1)} |`)
    }
  }

  const prim = [...reg, legacy]
  const pro = reg[0]!
  const flash = reg[1]!
  const pro5 = sens.find(c => c.profile.name === 'deepseek-v4-pro' && c.ttl === 300)!
  const pro60 = sens.find(c => c.profile.name === 'deepseek-v4-pro' && c.ttl === 3600)!
  for (const g of GROUPS) {
    if (!rows.some(g.filter)) continue
    out.push(`\n## ${g.name}`)
    for (const window of windows) {
      const ref = (name: string): Row[] => sel(rows, g, name, window)
      out.push(`\n### ${window / 1000}K: ${clusters(ref('stock'))} clusters (scenarios)\n`)
      for (const reference of ['stock', REFERENCE]) {
        out.push(`Cost vs ${reference === 'stock' ? 'stock' : 'the 1.9.0-era plugin'} (pooled %, 95% CI; weighted with its one-sided 95% upper bound):\n`)
        out.push(`| arm | weighted D | upper 1-sided | ${prim.map(c => c.label).join(' | ')} |\n|---|--|--:|${prim.map(() => '--').join('|')}|`)
        for (const arm of arms) {
          if (arm === reference || arm === 'stock') continue
          const a = ref(reference)
          const b = ref(arm)
          const w = pairedStat(a, b, weighted(reg), PRIMARY_DRAWS)
          const perConfig: Record<string, Interval | undefined> = {}
          for (const c of all) perConfig[c.label] = pairedStat(a, b, pooled(c))
          json.results.push({ group: g.name, window, arm, reference, weighted: w, perConfig })
          out.push(`| ${arm} | ${fmtInterval(w, 2)} | ${w ? fmt(w.hi1, 2, true) : 'n/a'} | ${prim.map(c => fmtInterval(perConfig[c.label], 2)).join(' | ')} |`)
          const l = perConfig[legacy.label]
          if (!l) continue
          for (const c of all) {
            const d = perConfig[c.label]
            if (c === legacy || !d || sign(d.mean) === sign(l.mean)) continue
            json.signChanges.push({ group: g.name, window, arm, reference, config: c.label, legacy: l.mean, repriced: d.mean })
          }
        }
        out.push('')
      }
      out.push('Sensitivities (pooled %, point estimates; vs stock / vs 1.9.0):\n')
      const others = arms.filter(a => a !== 'stock')
      out.push(`| config | ${others.join(' | ')} |\n|---|${others.map(() => '--').join('|')}|`)
      for (const c of all) {
        const cell = (arm: string): string => {
          const v = (refName: string): string => {
            if (arm === refName) return '-'
            const d = json.results.find(x => x.group === g.name && x.window === window && x.arm === arm && x.reference === refName)?.perConfig[c.label]
            return d ? fmt(d.mean, 2, true) : 'n/a'
          }
          return `${v('stock')} / ${v(REFERENCE)}`
        }
        out.push(`| ${c.label}${reg.includes(c) ? ' (registered)' : ''} | ${others.map(cell).join(' | ')} |`)
      }
      out.push('\nFacts kept, compactions, rewrites, cost split (mean per session; split in thousand miss-units):\n')
      out.push('| arm | facts kept | vs stock (pts) | vs 1.9.0 (pts) | compactions | rewrites | shortened | pro expiries at 5 min / 1 h | pro read / write / output | flash read / write / output |\n|---|--:|--|--|--:|--:|--:|--|--|--|')
      for (const arm of arms) {
        const mine = ref(arm)
        const n = mine.length
        if (!n) continue
        const avg = (f: (r: Row) => number): number => mine.reduce((s, r) => s + f(r), 0) / n
        const facts = (100 * mine.reduce((s, r) => s + r.facts_held, 0)) / mine.reduce((s, r) => s + r.facts_needed, 0)
        const vs = (refName: string): string => (arm === refName ? '' : fmtInterval(pairedDifference(ref(refName), mine, 'facts_kept'), 1))
        const split = (c: PriceConfig): string => `${fmt(avg(r => costOf(r, c).read) / 1000, 1)} / ${fmt(avg(r => costOf(r, c).write) / 1000, 1)} / ${fmt(avg(r => costOf(r, c).output) / 1000, 1)}`
        out.push(`| ${arm} | ${fmt(facts, 1)}% | ${vs('stock')} | ${vs(REFERENCE)} | ${fmt(avg(r => r.compactions), 2)} | ${fmt(avg(r => r.rewrites), 2)} | ${fmt(avg(r => r.shortened), 2)} | ${fmt(avg(r => costOf(r, pro5).expiries), 2)} / ${fmt(avg(r => costOf(r, pro60).expiries), 2)} | ${split(pro)} | ${split(flash)} |`)
      }
    }
  }

  out.push('\n## Sign changes against the pre-P1b pricing (legacy: read 0.1, write 1.0, summary output 4, no expiry, no unit)\n')
  if (json.signChanges.length === 0) out.push('None.')
  else {
    out.push('| group | window | arm | vs | config | legacy D | repriced D |\n|---|--:|---|---|---|--:|--:|')
    for (const s of json.signChanges) out.push(`| ${s.group} | ${s.window / 1000}K | ${s.arm} | ${s.reference === 'stock' ? 'stock' : '1.9.0'} | ${s.config} | ${fmt(s.legacy, 2, true)} | ${fmt(s.repriced, 2, true)} |`)
  }

  out.push('\n## T-0 vs the 1.9.0-era plugin, restated (round 2 reported -2.0% on dev and -1.4% on validation: 128K + 200K, mean of per-scenario ratios, legacy pricing)\n')
  out.push('| split | windows | config | mean of ratios (95% CI) | pooled (95% CI) |\n|---|---|---|--|--|')
  const restateConfigs = [legacy, pro, flash, config('deepseek-v4-pro', 300), config('deepseek-flash', 300), ...reg.slice(2)]
  for (const split of ['dev', 'validation', 'burned-r1'] as const) {
    for (const ws of [[128_000, 200_000], [128_000], [252_000]]) {
      const pick = (arm: string): Row[] => rows.filter(r => r.split === split && r.arm === arm && ws.includes(r.window))
      const a = pick(REFERENCE)
      const b = pick('T-0')
      if (!a.length || !b.length) continue
      const windowsLabel = ws.map(w => `${w / 1000}K`).join(' + ')
      for (const c of restateConfigs) {
        const m = pairedStat(a, b, meanOfRatios(c))
        const p = pairedStat(a, b, pooled(c))
        json.restated.push({ split, windows: windowsLabel, config: c.label, meanOfRatios: m, pooled: p })
        out.push(`| ${split} | ${windowsLabel} | ${c.label} | ${fmtInterval(m, 2)} | ${fmtInterval(p, 2)} |`)
      }
    }
  }
  return { text: out.join('\n'), json }
}
