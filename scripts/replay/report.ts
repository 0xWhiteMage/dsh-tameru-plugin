// Tables and the pre-registered selection for the policy comparison (dev and validation only; replay only).
import { ARMS, SETTINGS_TRIED } from './run.ts'
import {
  armStat,
  factsKeptShare,
  fmt,
  fmtInterval,
  meanOf,
  pairedDifference,
  selfCheck,
  shareOf,
  type Interval,
  type Row,
} from './stats.ts'

export const BASELINE = 'baseline-1.9.0'
/** The analysis plan's margins (docs/ANALYSIS-PLAN-1.10.md in the engine repository): one-sided 95% bounds. */
export const COST_MARGIN_POINTS = 1.0
export const FACTS_MARGIN_POINTS = -1.0

const armRows = (rows: Row[], arm: string, split?: string, window?: number): Row[] => rows.filter(r => r.arm === arm && (split === undefined || r.split === split) && (window === undefined || r.window === window))
const clusters = (rows: Row[]): number => new Set(rows.map(r => r.cluster)).size

export interface Verdict {
  arm: string
  cost: Interval | undefined
  costVsStock: Interval | undefined
  facts: Interval | undefined
  factsVsStock: Interval | undefined
  /** Cost upper bound within the margin against the 1.9.0-era plugin, and facts lower bound within the margin. */
  meetsMargins: boolean
}

export function verdict(rows: Row[], arm: string, split: string): Verdict {
  const mine = armRows(rows, arm, split)
  const cost = pairedDifference(armRows(rows, BASELINE, split), mine, 'cost')
  const facts = pairedDifference(armRows(rows, BASELINE, split), mine, 'facts_kept')
  return {
    arm,
    cost,
    costVsStock: pairedDifference(armRows(rows, 'stock', split), mine, 'cost'),
    facts,
    factsVsStock: pairedDifference(armRows(rows, 'stock', split), mine, 'facts_kept'),
    meetsMargins: cost !== undefined && facts !== undefined && cost.hi1 <= COST_MARGIN_POINTS && facts.lo1 >= FACTS_MARGIN_POINTS,
  }
}

/** The candidate with the most facts kept (against the 1.9.0-era plugin) among those inside both margins; ties go to the more conservative setting. */
export function bestOf(verdicts: Verdict[]): Verdict | undefined {
  const ok = verdicts.filter(v => v.meetsMargins && v.facts !== undefined)
  ok.sort((a, b) => b.facts!.mean - a.facts!.mean || verdicts.indexOf(b) - verdicts.indexOf(a))
  return ok[0]
}

export interface Selection {
  settingsTried: number
  devG: Verdict[]
  devT: Verdict[]
  chosenG: string | undefined
  chosenT: string | undefined
  validation: Verdict[]
  /** Every 1.10.0 arm on validation, for information only: selection used the development choices. */
  validationAll: Verdict[]
  winner: string | undefined
  /** The winner beat the 1.9.0-era plugin on facts kept (point estimate above 0) as well as meeting the margins. */
  improves: boolean
}

export function select(rows: Row[]): Selection {
  const gArms = ARMS.filter(a => a.name.startsWith('G-')).map(a => a.name)
  const tArms = ARMS.filter(a => a.name.startsWith('T-')).map(a => a.name)
  const devG = gArms.map(a => verdict(rows, a, 'dev'))
  const devT = tArms.map(a => verdict(rows, a, 'dev'))
  const chosenG = bestOf(devG)?.arm
  const chosenT = bestOf(devT)?.arm
  const validation = [chosenG, chosenT].filter((x): x is string => x !== undefined).map(a => verdict(rows, a, 'validation'))
  const best = bestOf(validation)
  const validationAll = ARMS.filter(a => a.engine === '1.10.0').map(a => verdict(rows, a.name, 'validation'))
  return { settingsTried: SETTINGS_TRIED, devG, devT, chosenG, chosenT, validation, validationAll, winner: best?.arm, improves: best?.facts !== undefined && best.facts.mean > 0 }
}

// ---- tables ---------------------------------------------------------------------------------------------------------------------------

const money = (x: number): string => Math.round(x).toLocaleString('en-US')

function line(rows: Row[], arm: string, split: string, all: Row[]): string {
  const mine = armRows(rows, arm, split)
  if (mine.length === 0) return ''
  const vs = (against: string, metric: string, digits = 1): string => (arm === against ? '' : fmtInterval(pairedDifference(armRows(all, against, split), mine, metric), digits))
  const facts = armStat(mine, factsKeptShare)
  const share = armStat(mine, shareOf(r => r.accepted, r => r.eligible))
  const per = (f: (r: Row) => number): string => fmt(mine.reduce((s, r) => s + f(r), 0) / mine.length, 1)
  return `| ${arm} | ${mine.length} | ${clusters(mine)} | ${money(mine.reduce((s, r) => s + r.cost, 0) / mine.length)} | ${arm === 'stock' ? '' : vs('stock', 'cost')} | ${arm === 'stock' || arm === BASELINE ? '' : vs(BASELINE, 'cost')} | ${facts ? fmt(100 * facts.mean, 1) : ''}% | ${arm === 'stock' ? '' : vs('stock', 'facts_kept')} | ${arm === 'stock' || arm === BASELINE ? '' : vs(BASELINE, 'facts_kept')} | ${per(r => r.shortened)} | ${per(r => r.rewrites)} | ${per(r => r.compactions)} | ${share && arm !== 'stock' ? fmt(100 * share.mean, 1) : ''} |`
}

const HEAD = '| arm | runs | clusters | mean cost | cost vs stock (pct, 95% CI) | cost vs 1.9.0 | facts kept | vs stock (pts) | vs 1.9.0 (pts) | shortened / session | rewrites / session | compactions / session | accepted share (%) |\n|---|--:|--:|--:|--|--|--:|--|--|--:|--:|--:|--:|'

export function table(rows: Row[], split: string): string {
  const out = ARMS.map(a => line(rows, a.name, split, rows)).filter(Boolean)
  return [HEAD, ...out].join('\n')
}

export function windowTable(rows: Row[], split: string): string {
  const out = ['| arm | window | cost vs stock, write 1.0 | cost vs stock, write 1.25 | sign flips |', '|---|--:|--|--|--|']
  for (const a of ARMS.filter(x => x.name !== 'stock')) {
    for (const window of [128_000, 200_000, undefined]) {
      const mine = armRows(rows, a.name, split, window)
      const stock = armRows(rows, 'stock', split, window)
      if (!mine.length) continue
      const c1 = pairedDifference(stock, mine, 'cost')
      const c2 = pairedDifference(stock, mine, 'cost_w125')
      const flip = c1 && c2 && Math.sign(c1.mean) !== Math.sign(c2.mean) ? 'yes' : ''
      out.push(`| ${a.name} | ${window === undefined ? 'both' : `${window / 1000}K`} | ${fmtInterval(c1)} | ${fmtInterval(c2)} | ${flip} |`)
    }
  }
  return out.join('\n')
}

/** The non-inert tests of gate 8(b) and the extract-quality test of 8(a), for every Tameru arm on one split. */
export function gateTable(rows: Row[], split: string): string {
  const out = [
    '| arm | accepted share vs 1.9.0 (pts, 95% CI; 1-sided lower) | applied share | accepted extracts keep their facts (cluster 1-sided lower) | trigger events where an extract replaced the stock cut (share, 1-sided lower) | stock cuts replaced (share) | second rewrites |',
    '|---|--|--|--|--|--|--:|',
  ]
  for (const a of ARMS.filter(x => x.engine !== 'none')) {
    const mine = armRows(rows, a.name, split)
    if (!mine.length) continue
    const acc = a.name === BASELINE ? undefined : pairedDifference(armRows(rows, BASELINE, split), mine, 'accepted_share')
    const app = a.name === BASELINE ? undefined : pairedDifference(armRows(rows, BASELINE, split), mine, 'applied_share')
    const keep = armStat(mine, shareOf(r => r.extract_facts_kept, r => r.extract_facts_possible))
    const ev = armStat(mine, shareOf(r => r.trigger_events_replaced, r => r.trigger_events))
    const cuts = armStat(mine, shareOf(r => r.cuts_replaced, r => r.cuts_eligible))
    const f = (i: Interval | undefined, scale = 1): string => (i === undefined ? 'n/a' : `${fmt(scale * i.mean, 1)} (lower ${fmt(scale * i.lo1, 1)})`)
    out.push(`| ${a.name} | ${acc ? `${fmtInterval(acc)}; lower ${fmt(acc.lo1, 1, true)}` : 'reference'} | ${app ? `${fmtInterval(app)}` : ''} | ${f(keep, 100)}% | ${a.settings.policy === 'at-trigger' ? `${f(ev, 100)}%` : ''} | ${a.settings.policy === 'at-trigger' ? `${f(cuts, 100)}%` : ''} | ${mine.reduce((s, r) => s + r.second_rewrites, 0)} |`)
  }
  return out.join('\n')
}

const verdictLine = (v: Verdict): string =>
  `| ${v.arm} | ${fmtInterval(v.cost)}; upper ${v.cost ? fmt(v.cost.hi1, 1, true) : 'n/a'} | ${fmtInterval(v.facts)}; lower ${v.facts ? fmt(v.facts.lo1, 1, true) : 'n/a'} | ${fmtInterval(v.costVsStock)}; upper ${v.costVsStock ? fmt(v.costVsStock.hi1, 1, true) : 'n/a'} | ${fmtInterval(v.factsVsStock)} | ${v.meetsMargins ? 'yes' : 'no'} |`

export function selectionTable(vs: Verdict[]): string {
  return ['| arm | cost vs 1.9.0 (pct) | facts kept vs 1.9.0 (pts) | cost vs stock (pct) | facts kept vs stock (pts) | inside both margins |', '|---|--|--|--|--|---|', ...vs.map(verdictLine)].join('\n')
}

export function fullReport(rows: Row[]): { text: string; selection: Selection } {
  const check = selfCheck(rows)
  const selection = select(rows)
  const parts: string[] = []
  const splits = ['dev', 'validation'] as const
  parts.push(`Rows: ${rows.length}; scenarios: ${new Set(rows.map(r => r.scenario)).size}; arm-vs-itself on every metric: ${check.ok ? 'exactly 0' : `FAILED ${check.failures.join('; ')}`}.`)
  for (const split of splits) {
    const sub = rows.filter(r => r.split === split)
    parts.push(`\n### ${split}: ${clusters(sub)} scenarios (clusters)\n\n${table(rows, split)}`)
    parts.push(`\nCache-price sensitivity, ${split}:\n\n${windowTable(rows, split)}`)
    parts.push(`\nGate 8(a) and 8(b) quantities, ${split}:\n\n${gateTable(rows, split)}`)
  }
  parts.push(`\n### Selection (settings tried: ${selection.settingsTried})\n\nPolicy G on dev, by gate:\n\n${selectionTable(selection.devG)}\n\nPolicy T on dev, by gate:\n\n${selectionTable(selection.devT)}\n\nChosen on dev: G ${selection.chosenG ?? 'none'}, T ${selection.chosenT ?? 'none'}.\n\nOn validation:\n\n${selectionTable(selection.validation)}\n\nEvery 1.10.0 arm on validation, for information (selection used the development choices only):\n\n${selectionTable(selection.validationAll)}\n\nWinner: ${selection.winner ?? 'none'}${selection.winner ? (selection.improves ? '' : ' (but facts kept are not above the 1.9.0-era plugin)') : ''}.`)
  return { text: parts.join('\n'), selection }
}

export { meanOf }
