// The report for session-corpus rows (round 2, P2b; dev and validation only). REPLAY ONLY: no model ran and no cache was probed.
//
// Per window: trigger crossings of the stock arm by split (the round-2 rule: >= 70% of sessions cross once and >= 30% twice in every
// split for a gated window), wall time per run, whole-session cost vs stock and vs the 1.9.0-era plugin under the registered price
// profiles (weighted D, 10,000-draw cluster bootstrap by scenario) and every sensitivity (point estimates), facts kept (by family,
// language, style, question stratum, fact kind, position; worst family), shortenings / rewrites / compactions per session, the
// acceptance share, 8(a) (accepted extracts keep their facts) by style and language, the pass outcomes of the at-trigger policy (why it
// skipped), and the cost split read / write / output. Arm vs itself must be exactly zero at every window, profile and split.
import { REGISTERED, registeredConfigs, sensitivityConfigs, ttlOf, type PriceConfig } from './pricing.ts'
import { PRIMARY_DRAWS, REFERENCE, costOf, pooled, repricedSelfCheck, weighted, type Group } from './reprice.ts'
import { armStat, fmt, fmtInterval, pairedDifference, pairedStat, selfCheck, type Interval, type Row } from './stats.ts'

const ARM_ORDER = ['stock', 'baseline-1.9.0', 'default-1.10.0', 'G-0.7', 'G-0.85', 'T-0', 'T-0.7']
/** Round-2 analysis plan section 3, the DeepSeek plugin: 128K, 252K, 500K gated; 1M report-only. */
export const GATED = new Set([128_000, 252_000, 500_000])
const SPLITS = ['dev', 'validation'] as const

export const CORPUS_GROUPS: Group[] = [
  { name: 'dev+validation', filter: r => r.split === 'dev' || r.split === 'validation' },
  { name: 'dev', filter: r => r.split === 'dev' },
  { name: 'validation', filter: r => r.split === 'validation' },
]

const windowLabel = (w: number): string => (w >= 1_000_000 ? `${fmt(w / 1_000_000, 0)}M` : `${fmt(w / 1000, 0)}K`)
const pct = (x: number | undefined, digits = 1): string => (x === undefined || Number.isNaN(x) ? 'n/a' : `${fmt(100 * x, digits)}%`)
const sum = (rows: Row[], f: (r: Row) => number): number => rows.reduce((s, r) => s + f(r), 0)
const mean = (rows: Row[], f: (r: Row) => number): number => (rows.length ? sum(rows, f) / rows.length : NaN)
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN
}
const clusters = (rows: Row[]): number => new Set(rows.map(r => r.cluster)).size
const factShare = (rows: Row[]): number | undefined => {
  const n = sum(rows, r => r.facts_needed)
  return n ? sum(rows, r => r.facts_held) / n : undefined
}
const factsWhere = (rows: Row[], keep: (f: NonNullable<Row['corpus_facts']>[number]) => boolean): { held: number; n: number } => {
  let held = 0
  let n = 0
  for (const r of rows) for (const f of r.corpus_facts ?? []) if (keep(f)) {
    n++
    if (f.line_present) held++
  }
  return { held, n }
}
const ratio = (x: { held: number; n: number }): string => (x.n ? `${fmt((100 * x.held) / x.n, 1)}% (${x.n})` : 'n/a')

export interface CorpusJson {
  selfCheckOk: boolean
  selfCheckFailures: string[]
  configs: Array<{ label: string; profile: string; ttl_s: number | null; unit: number; registered: boolean }>
  crossings: Array<{ window: number; split: string; sessions: number; atLeast1: number; atLeast2: number; mean: number; meetsRule: boolean; gated: boolean }>
  runtime: Array<{ window: number; arm: string; runs: number; meanMs: number; medianMs: number; maxMs: number; totalMin: number }>
  cost: Array<{ window: number; group: string; arm: string; reference: string; clusters: number; weighted: Interval | undefined; perConfig: Record<string, number | undefined>; perRegistered: Record<string, Interval | undefined> }>
  arms: Array<{
    window: number
    arm: string
    sessions: number
    factsKept: number | undefined
    factsVsStock: Interval | undefined
    factsVs190: Interval | undefined
    byLanguage: Record<string, number | undefined>
    byStyle: Record<string, number | undefined>
    byFamily: Record<string, number | undefined>
    worstFamily: string | undefined
    byStratum: Record<string, number | undefined>
    shortened: number
    rewrites: number
    compactions: number
    acceptedShare: Interval | undefined
    extract8a: Record<string, Interval | undefined>
    extract8aByFamily: Record<string, Interval | undefined>
    extract8aWorstFamily: string | undefined
    passReasons: Record<string, number>
    split: Record<string, { read: number; write: number; output: number }>
  }>
}

export function corpusReport(rows: Row[]): { text: string; json: CorpusJson } {
  const reg = registeredConfigs()
  const sens = sensitivityConfigs()
  const all = [...reg, ...sens]
  const windows = [...new Set(rows.map(r => r.window))].sort((a, b) => a - b)
  const arms = ARM_ORDER.filter(a => rows.some(r => r.arm === a))
  const failures = [...selfCheck(rows).failures, ...repricedSelfCheck(rows, all, 100, CORPUS_GROUPS)]
  const json: CorpusJson = {
    selfCheckOk: failures.length === 0,
    selfCheckFailures: failures,
    configs: all.map(c => ({ label: c.label, profile: c.profile.name, ttl_s: ttlOf(c), unit: c.unitTokens, registered: reg.includes(c) })),
    crossings: [],
    runtime: [],
    cost: [],
    arms: [],
  }
  const sel = (arm: string, window: number, group = CORPUS_GROUPS[0]!): Row[] => rows.filter(r => r.arm === arm && r.window === window && group.filter(r))
  const out: string[] = []
  out.push(`Rows: ${rows.length}; arms: ${arms.join(', ')}; windows: ${windows.map(windowLabel).join(', ')}; scenarios per window: ${windows.map(w => `${windowLabel(w)} ${sel('stock', w).length}`).join(', ')}.`)
  out.push(`Arm vs itself, every legacy metric and every price config plus the weighted D, at every window, in dev+validation, dev and validation: ${failures.length === 0 ? 'exactly 0' : `FAILED (${failures.length}): ${failures.slice(0, 5).join('; ')}`}.`)
  out.push(`All costs are miss-units (one uncached input token = 1) and are REPLAY ONLY. D = pooled percent difference; weighted = registered 1/4 each of ${REGISTERED.join(', ')}.`)

  out.push('\n## Trigger crossings (stock arm; steps at or above the stock trigger before anything acted)\n')
  out.push('| window | split | sessions | crossed >= 1 | crossed >= 2 | crossings / session | rule (>=70% / >=30%) | window gated (plan) |\n|--:|---|--:|--:|--:|--:|---|---|')
  for (const window of windows) {
    for (const split of SPLITS) {
      const st = rows.filter(r => r.arm === 'stock' && r.window === window && r.split === split)
      if (!st.length) continue
      const c = st.map(r => r.trigger_crossings ?? 0)
      const a1 = c.filter(x => x >= 1).length / st.length
      const a2 = c.filter(x => x >= 2).length / st.length
      const row = { window, split, sessions: st.length, atLeast1: a1, atLeast2: a2, mean: c.reduce((a, b) => a + b, 0) / st.length, meetsRule: a1 >= 0.7 && a2 >= 0.3, gated: GATED.has(window) }
      json.crossings.push(row)
      out.push(`| ${windowLabel(window)} | ${split} | ${st.length} | ${pct(a1, 0)} | ${pct(a2, 0)} | ${fmt(row.mean, 1)} | ${row.meetsRule ? 'met' : '**not met**'} | ${row.gated ? 'gated' : 'report-only'} |`)
    }
  }

  out.push('\n## Wall time per run (one arm on one scenario at one window; 16 processes in parallel on one PC)\n')
  out.push('| window | arm | runs | mean s | median s | max s | sum (CPU-process minutes) |\n|--:|---|--:|--:|--:|--:|--:|')
  for (const window of windows) {
    for (const arm of arms) {
      const ms = rows.filter(r => r.arm === arm && r.window === window && r.run_ms !== undefined).map(r => r.run_ms!)
      if (!ms.length) continue
      const rt = { window, arm, runs: ms.length, meanMs: ms.reduce((a, b) => a + b, 0) / ms.length, medianMs: median(ms), maxMs: Math.max(...ms), totalMin: ms.reduce((a, b) => a + b, 0) / 60_000 }
      json.runtime.push(rt)
      out.push(`| ${windowLabel(window)} | ${arm} | ${rt.runs} | ${fmt(rt.meanMs / 1000, 1)} | ${fmt(rt.medianMs / 1000, 1)} | ${fmt(rt.maxMs / 1000, 1)} | ${fmt(rt.totalMin, 1)} |`)
    }
  }

  const maxScenarios = Math.max(...windows.map(w => sel('stock', w).length))
  const scenarioNote = (window: number): string => {
    const mine = sel('stock', window)
    if (mine.length >= maxScenarios) return `${clusters(mine)} clusters (scenarios)`
    const perFamily = new Map<string, number>()
    for (const r of mine) perFamily.set(r.family, (perFamily.get(r.family) ?? 0) + 1)
    const counts = [...new Set(perFamily.values())]
    const how = counts.length === 1 ? `stratified subsample` : `subsample (${[...perFamily.entries()].map(([f, n]) => `${f} ${n}`).join(', ')})`
    const per = counts.length === 1 ? ` (${counts[0]} per family)` : ''
    return `${how}, ${mine.length} of ${maxScenarios} scenarios${per}`
  }
  for (const window of windows) {
    out.push(`\n## ${windowLabel(window)} (${GATED.has(window) ? 'gated window' : 'report-only'}): ${scenarioNote(window)}`)
    for (const group of CORPUS_GROUPS) {
      const ref = (name: string): Row[] => sel(name, window, group)
      if (!ref('stock').length) continue
      for (const reference of ['stock', REFERENCE]) {
        if (!ref(reference).length) continue
        const label = reference === 'stock' ? 'stock' : 'the 1.9.0-era plugin'
        if (group === CORPUS_GROUPS[0]) {
          out.push(`\n### Cost vs ${label}, ${group.name} (pooled %, 95% CI; weighted with its one-sided 95% upper bound; ${clusters(ref('stock'))} clusters)\n`)
          out.push(`| arm | weighted D | upper 1-sided | ${reg.map(c => c.label).join(' | ')} |\n|---|--|--:|${reg.map(() => '--').join('|')}|`)
        }
        for (const arm of arms) {
          if (arm === reference || arm === 'stock') continue
          const a = ref(reference)
          const b = ref(arm)
          if (!b.length) continue
          const full = group === CORPUS_GROUPS[0]
          const w = pairedStat(a, b, weighted(reg), full ? PRIMARY_DRAWS : 2000)
          const perRegistered: Record<string, Interval | undefined> = {}
          if (full) for (const c of reg) perRegistered[c.label] = pairedStat(a, b, pooled(c))
          const perConfig: Record<string, number | undefined> = {}
          const pairs = b.map(rb => ({ a: a.find(ra => ra.scenario === rb.scenario)!, b: rb })).filter(p => p.a)
          for (const c of all) perConfig[c.label] = pooled(c)(pairs)
          json.cost.push({ window, group: group.name, arm, reference, clusters: clusters(b), weighted: w, perConfig, perRegistered })
          if (full) out.push(`| ${arm} | ${fmtInterval(w, 2)} | ${w ? fmt(w.hi1, 2, true) : 'n/a'} | ${reg.map(c => fmtInterval(perRegistered[c.label], 2)).join(' | ')} |`)
        }
      }
    }
    out.push('\nWeighted D by split (point [95% CI]; vs stock / vs 1.9.0):\n')
    out.push(`| arm | dev vs stock | dev vs 1.9.0 | validation vs stock | validation vs 1.9.0 |\n|---|--|--|--|--|`)
    for (const arm of arms) {
      if (arm === 'stock') continue
      const cell = (group: string, reference: string): string => {
        if (arm === reference) return '-'
        const c = json.cost.find(x => x.window === window && x.group === group && x.arm === arm && x.reference === reference)
        return c ? fmtInterval(c.weighted, 2) : 'n/a'
      }
      out.push(`| ${arm} | ${cell('dev', 'stock')} | ${cell('dev', REFERENCE)} | ${cell('validation', 'stock')} | ${cell('validation', REFERENCE)} |`)
    }
    const others = arms.filter(a => a !== 'stock')
    out.push('\nSensitivities, dev+validation (pooled %, point estimates; vs stock / vs 1.9.0):\n')
    out.push(`| config | ${others.join(' | ')} |\n|---|${others.map(() => '--').join('|')}|`)
    for (const c of all) {
      const cell = (arm: string): string => {
        const v = (refName: string): string => {
          if (arm === refName) return '-'
          const d = json.cost.find(x => x.window === window && x.group === 'dev+validation' && x.arm === arm && x.reference === refName)?.perConfig[c.label]
          return d === undefined ? 'n/a' : fmt(d, 2, true)
        }
        return `${v('stock')} / ${v(REFERENCE)}`
      }
      out.push(`| ${c.label}${reg.includes(c) ? ' (registered)' : ''} | ${others.map(cell).join(' | ')} |`)
    }

    // per-arm tables
    const families = [...new Set(sel('stock', window).map(r => r.family))].sort()
    const per: CorpusJson['arms'] = []
    for (const arm of arms) {
      const mine = sel(arm, window)
      if (!mine.length) continue
      const byFamily: Record<string, number | undefined> = {}
      for (const f of families) byFamily[f] = factShare(mine.filter(r => r.family === f))
      const byLanguage: Record<string, number | undefined> = {}
      for (const l of ['en', 'zh', 'mixed']) byLanguage[l] = factShare(mine.filter(r => r.lang === l))
      const byStyle: Record<string, number | undefined> = {}
      for (const s of ['specific', 'vague']) byStyle[s] = factShare(mine.filter(r => r.style === s))
      const byStratum: Record<string, number | undefined> = {}
      for (const s of ['single', 'buried', 'superseded', 'aggregate', 'real']) {
        const qs = mine.flatMap(r => (r.questions_held ?? []).filter(q => q.stratum === s))
        byStratum[s] = qs.length ? qs.filter(q => q.held).length / qs.length : undefined
      }
      const extract8a: Record<string, Interval | undefined> = {}
      const share8a = (rs: Row[]): number | undefined => {
        const n = sum(rs, r => r.extract_facts_possible)
        return n ? sum(rs, r => r.extract_facts_kept) / n : undefined
      }
      extract8a.all = armStat(mine, share8a)
      for (const s of ['specific', 'vague']) extract8a[s] = armStat(mine.filter(r => r.style === s), share8a)
      for (const l of ['en', 'zh', 'mixed']) extract8a[l] = armStat(mine.filter(r => r.lang === l), share8a)
      const extract8aByFamily: Record<string, Interval | undefined> = {}
      const familyPossible: Record<string, number> = {}
      for (const f of families) {
        const rs = mine.filter(r => r.family === f)
        familyPossible[f] = sum(rs, r => r.extract_facts_possible)
        extract8aByFamily[f] = armStat(rs, share8a)
      }
      const worst8a = families.filter(f => familyPossible[f]! > 0 && extract8aByFamily[f] !== undefined)
        .sort((a, b) => extract8aByFamily[a]!.mean - extract8aByFamily[b]!.mean)[0]
      const passReasons: Record<string, number> = {}
      for (const r of mine) for (const [k, v] of Object.entries(r.pass_reasons ?? {})) passReasons[k] = (passReasons[k] ?? 0) + v
      const costSplit: Record<string, { read: number; write: number; output: number }> = {}
      for (const c of reg) costSplit[c.label] = { read: mean(mine, r => costOf(r, c).read), write: mean(mine, r => costOf(r, c).write), output: mean(mine, r => costOf(r, c).output) }
      const worst = families.filter(f => byFamily[f] !== undefined).sort((a, b) => byFamily[a]! - byFamily[b]!)[0]
      per.push({
        window,
        arm,
        sessions: mine.length,
        factsKept: factShare(mine),
        factsVsStock: arm === 'stock' ? undefined : pairedDifference(sel('stock', window), mine, 'facts_kept'),
        factsVs190: arm === REFERENCE || !sel(REFERENCE, window).length ? undefined : pairedDifference(sel(REFERENCE, window), mine, 'facts_kept'),
        byLanguage,
        byStyle,
        byFamily,
        worstFamily: worst,
        byStratum,
        shortened: mean(mine, r => r.shortened),
        rewrites: mean(mine, r => r.rewrites),
        compactions: mean(mine, r => r.compactions),
        acceptedShare: armStat(mine, rs => {
          const n = sum(rs, r => r.eligible)
          return n ? sum(rs, r => r.accepted) / n : undefined
        }),
        extract8a,
        extract8aByFamily,
        extract8aWorstFamily: worst8a,
        passReasons,
        split: costSplit,
      })
    }
    json.arms.push(...per)
    out.push('\nFacts kept (line check, end of session; pooled over facts) and per-session counts, dev+validation:\n')
    out.push('| arm | facts kept | vs stock (pts, 95% CI) | vs 1.9.0 (pts, 95% CI) | en | zh | mixed | specific | vague | worst family | shortened | rewrites | compactions | accepted / asked |\n|---|--:|--|--|--:|--:|--:|--:|--:|---|--:|--:|--:|--|')
    for (const p of per) {
      out.push(`| ${p.arm} | ${pct(p.factsKept)} | ${p.arm === 'stock' ? '' : fmtInterval(p.factsVsStock, 1)} | ${p.factsVs190 ? fmtInterval(p.factsVs190, 1) : ''} | ${pct(p.byLanguage.en)} | ${pct(p.byLanguage.zh)} | ${pct(p.byLanguage.mixed)} | ${pct(p.byStyle.specific)} | ${pct(p.byStyle.vague)} | ${p.worstFamily ?? 'n/a'} ${pct(p.worstFamily ? p.byFamily[p.worstFamily] : undefined)} | ${fmt(p.shortened, 2)} | ${fmt(p.rewrites, 2)} | ${fmt(p.compactions, 2)} | ${p.acceptedShare ? `${fmt(100 * p.acceptedShare.mean, 1)}%` : 'n/a'} |`)
    }
    out.push('\nQuestions held by stratum (share of questions whose every fact is held):\n')
    out.push('| arm | single | buried | superseded | aggregate | real |\n|---|--:|--:|--:|--:|--:|')
    for (const p of per) out.push(`| ${p.arm} | ${pct(p.byStratum.single)} | ${pct(p.byStratum.buried)} | ${pct(p.byStratum.superseded)} | ${pct(p.byStratum.aggregate)} | ${pct(p.byStratum.real)} |`)
    out.push('\nFacts held by fact kind and position (held % (facts)):\n')
    out.push('| arm | natural | error | buried | real | early | middle | late | value present (any line) |\n|---|--:|--:|--:|--:|--:|--:|--:|--:|')
    for (const arm of arms) {
      const mine = sel(arm, window)
      if (!mine.length) continue
      const vp = { held: 0, n: 0 }
      for (const r of mine) for (const f of r.corpus_facts ?? []) {
        vp.n++
        if (f.value_present) vp.held++
      }
      out.push(`| ${arm} | ${['natural', 'error', 'buried', 'real'].map(k => ratio(factsWhere(mine, f => f.kind === k))).join(' | ')} | ${['early', 'middle', 'late'].map(k => ratio(factsWhere(mine, f => f.position === k))).join(' | ')} | ${ratio(vp)} |`)
    }
    out.push('\nFacts kept by family (dev+validation):\n')
    out.push(`| family | ${per.map(p => p.arm).join(' | ')} |\n|---|${per.map(() => '--:').join('|')}|`)
    for (const f of families) out.push(`| ${f} | ${per.map(p => pct(p.byFamily[f])).join(' | ')} |`)
    out.push('\n8(a): of the needed facts in an accepted result, the share its extract kept (line check; 95% CI, one-sided 95% lower bound):\n')
    out.push('| arm | all | specific | vague | en | zh | mixed |\n|---|--|--|--|--|--|--|')
    for (const p of per) {
      if (p.arm === 'stock') continue
      const c = (k: string): string => {
        const i = p.extract8a[k]
        return i ? `${fmt(100 * i.mean, 1)} [${fmt(100 * i.lo, 1)}, ${fmt(100 * i.hi, 1)}] (lo ${fmt(100 * i.lo1, 1)})` : 'n/a'
      }
      out.push(`| ${p.arm} | ${c('all')} | ${c('specific')} | ${c('vague')} | ${c('en')} | ${c('zh')} | ${c('mixed')} |`)
    }
    const nonStock = per.filter(p => p.arm !== 'stock')
    out.push('\n8(a) by family (mean %, one-sided 95% lower bound; n = possible facts):\n')
    out.push(`| family | ${nonStock.map(p => p.arm).join(' | ')} |\n|---|${nonStock.map(() => '--').join('|')}|`)
    for (const f of families) {
      const cell = (p: CorpusJson['arms'][number]): string => {
        const i = p.extract8aByFamily[f]
        const n = sum(sel(p.arm, window).filter(r => r.family === f), r => r.extract_facts_possible)
        return i ? `${fmt(100 * i.mean, 1)} (lo ${fmt(100 * i.lo1, 1)}; n ${n})` : 'n/a'
      }
      out.push(`| ${f} | ${nonStock.map(cell).join(' | ')} |`)
    }
    out.push(`\nWorst family (lowest 8(a) point estimate): ${nonStock.map(p => {
      const f = p.extract8aWorstFamily
      const i = f ? p.extract8aByFamily[f] : undefined
      return f && i ? `${p.arm} ${f} ${fmt(100 * i.mean, 1)} (lo ${fmt(100 * i.lo1, 1)})` : `${p.arm} n/a`
    }).join('; ')}.`)
    out.push('\nPass outcomes summed over sessions (steps; `applied` = an extract was written; the rest are why the pass did nothing):\n')
    for (const p of per) {
      if (p.arm === 'stock') continue
      const entries = Object.entries(p.passReasons).sort((a, b) => b[1] - a[1])
      out.push(`- ${p.arm}: ${entries.map(([k, v]) => `${k} ${v}`).join(', ')}`)
    }
    out.push('\nCost split, mean per session in thousand miss-units (read / write / output):\n')
    out.push(`| arm | ${reg.map(c => c.label).join(' | ')} |\n|---|${reg.map(() => '--').join('|')}|`)
    for (const p of per) out.push(`| ${p.arm} | ${reg.map(c => `${fmt(p.split[c.label]!.read / 1000, 1)} / ${fmt(p.split[c.label]!.write / 1000, 1)} / ${fmt(p.split[c.label]!.output / 1000, 1)}`).join(' | ')} |`)
  }
  return { text: out.join('\n'), json }
}

export type { PriceConfig }
