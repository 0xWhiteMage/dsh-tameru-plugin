// The bar's decisions, with no React and no DOM, so they can be tested directly. The rules are docs/PLUGIN-UI.md in the engine repository.

export type Json = Record<string, any>

/** `<1K` below a thousand characters, whole K up to 999,999, whole M above. Always short enough for a 40 px column. */
export function compactChars(chars: number): string {
  if (!Number.isFinite(chars) || chars < 0) return '<1K'
  if (chars < 1000) return '<1K'
  const thousands = Math.round(chars / 1000)
  if (thousands < 1000) return `${thousands}K`
  return `${Math.round(chars / 1_000_000)}M`
}

/** Off, or how sure the engine must be: the confidence gate for each strength. Normal is the shipped default. */
export const STRENGTHS = [
  { id: 'off' },
  { id: 'less', minConfidence: 0.85 },
  { id: 'normal', minConfidence: 0.7 },
  { id: 'more', minConfidence: 0.55 },
] as const
export type StrengthId = (typeof STRENGTHS)[number]['id']

/** The strength in force, from the plugin's settings. `custom` when the profile file sets a gate that is none of ours. */
export function strengthOf(values: Json | undefined): StrengthId | 'custom' {
  if (!values) return 'normal'
  if (values.shorten === false) return 'off'
  if (typeof values.minConfidence !== 'number') return 'normal'
  const match = STRENGTHS.find(strength => 'minConfidence' in strength && Math.abs(strength.minConfidence - values.minConfidence) < 0.005)
  return match?.id ?? 'custom'
}

/** The settings change that puts a strength in force. Any strength but Off also switches shortening back on. */
export function strengthPatch(id: StrengthId): Json {
  const strength = STRENGTHS.find(candidate => candidate.id === id)
  return strength && 'minConfidence' in strength ? { shorten: true, minConfidence: strength.minConfidence } : { shorten: false }
}

export type Tone = 'idle' | 'working' | 'off' | 'problem'
export type Status = {
  key: 'loading' | 'notConnected' | 'notRunning' | 'notRunningRetrying' | 'problem' | 'waiting' | 'off' | 'shortened' | 'keptOnly' | 'idleUntil' | 'idle'
  tone: Tone
  n?: number
  percent?: number
}

/** The outputs the AI sees right now. A summary that replaced a result takes it out of every count and list. */
export const liveItems = (state: Json): Json[] => (Array.isArray(state.items) ? state.items.filter((item: Json) => item.onSurface) : [])

/** Shortened (including ones waiting for the next step) and held in full (kept, or restored for a few replies). The one definition behind every count. */
export function groupsOf(state: Json | null): { shortened: Json[]; kept: Json[] } {
  const items = state?.live ? liveItems(state) : []
  return { shortened: items.filter(item => item.state === 'shortened'), kept: items.filter(item => item.state === 'kept' || item.state === 'restored') }
}

/** The one phrase on the bar: the most important true thing wins. Never a claim about money or tokens saved, never raw error text. */
export function statusOf(state: Json | null, failed: boolean, problem: boolean): Status {
  if (!state) return failed ? { key: 'notConnected', tone: 'problem' } : { key: 'loading', tone: 'idle' }
  if (state.live === false) return { key: 'idle', tone: 'idle' }
  if (!state.python) return { key: 'notRunning', tone: 'problem' }
  if (state.engine?.state === 'disabled') return { key: 'notRunningRetrying', tone: 'problem' }
  if (problem || (typeof state.failure === 'string' && state.failure)) return { key: 'problem', tone: 'problem' }
  if (state.chat?.pending > 0) return { key: 'waiting', tone: 'working', n: state.chat.pending }
  if (strengthOf(state.settings?.values) === 'off') return { key: 'off', tone: 'off' }
  const { shortened, kept } = groupsOf(state)
  if (shortened.length > 0) return { key: 'shortened', tone: 'idle', n: shortened.length }
  if (kept.length > 0) return { key: 'keptOnly', tone: 'idle', n: kept.length }
  const gauge = state.gauge
  if (gauge && gauge.contextWindow > 0 && gauge.tokens < gauge.startsAt) return { key: 'idleUntil', tone: 'idle', percent: Math.round((gauge.startsAt / gauge.contextWindow) * 100) }
  return { key: 'idle', tone: 'idle' }
}

/** The gauge's numbers as fractions of the context window. The host's own meter gives the fill when it has one; the ticks come from the plugin. */
export function gaugeOf(pressure: Json | undefined, state: Json | null): { percent: number; starts?: number; compacts?: number } | undefined {
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens ?? state?.gauge?.tokens
  const window = pressure?.contextWindow ?? state?.gauge?.contextWindow
  if (typeof used !== 'number' || typeof window !== 'number' || window <= 0) return undefined
  const fraction = (value: unknown): number | undefined => (typeof value === 'number' && value > 0 ? Math.min(1, value / window) : undefined)
  const starts = fraction(state?.gauge?.startsAt)
  const compacts = fraction(state?.gauge?.stockTrigger)
  return { percent: Math.min(100, Math.round((used / window) * 100)), ...(starts !== undefined ? { starts } : {}), ...(compacts !== undefined ? { compacts } : {}) }
}

/** The size cells of a row: what the AI saw before and what it sees now. A held row shows only what it sees now. */
export function sizeCells(item: Json): { from: string; to: string; held: boolean } {
  const held = item.state === 'kept' || item.state === 'restored'
  return { from: held ? '' : compactChars(item.originalChars), to: compactChars(held ? item.originalChars : item.shownChars), held }
}

/** `{n}` and `{percent}` and the like in a shared string. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([a-z]+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole))
}

/** The vocabulary key for the host's own reason that a pass did nothing. */
export function emptyReasonKey(skip: string | null | undefined, belowStart: boolean): 'belowStart' | 'noCandidates' | 'notConfident' | 'tooSmall' | 'engineSilent' | 'off' {
  switch (skip) {
    case 'below_activation': return 'belowStart'
    case 'no_candidates': return 'noCandidates'
    case 'not_confident': return 'notConfident'
    case 'not_worth_it': return 'tooSmall'
    case 'engine_unavailable': return 'engineSilent'
    case 'off': return 'off'
    default: return belowStart ? 'belowStart' : 'noCandidates'
  }
}

const TAB_KEY = 'dsh-tameru.v1.tab'

type Store = Pick<Storage, 'getItem' | 'setItem'>
const storeOf = (): Store | undefined => {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

export type TabId = 'results' | 'pins'

/** The chosen tab is remembered; whether the card is open is not. Every read and write is guarded: the bar works without storage. */
export function readTab(store: Store | undefined = storeOf()): TabId {
  try {
    return store?.getItem(TAB_KEY) === 'pins' ? 'pins' : 'results'
  } catch {
    return 'results'
  }
}

export function writeTab(tab: TabId, store: Store | undefined = storeOf()): void {
  try {
    store?.setItem(TAB_KEY, tab)
  } catch {
    // the choice is a convenience
  }
}
