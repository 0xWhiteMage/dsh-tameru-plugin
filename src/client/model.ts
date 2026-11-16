// The bar's decisions, with no React and no DOM, so they can be tested directly.

export type Json = Record<string, any>

/** `20000` → `20.0K`, `1250000` → `1.3M`, small numbers as they are. */
export function compact(chars: number): string {
  if (!Number.isFinite(chars) || chars < 0) return '0'
  if (chars < 1000) return String(Math.round(chars))
  if (chars < 1_000_000) return `${(chars / 1000).toFixed(1)}K`
  return `${(chars / 1_000_000).toFixed(1)}M`
}

/** How eager the shortening is: the engine's confidence gate for each named mode. Balanced is the shipped default. */
export const MODES = [
  { id: 'more', minConfidence: 0.55 },
  { id: 'balanced', minConfidence: 0.7 },
  { id: 'less', minConfidence: 0.85 },
] as const
export type ModeId = (typeof MODES)[number]['id']

export function modeOf(minConfidence: unknown): ModeId | 'custom' {
  if (typeof minConfidence !== 'number') return 'balanced'
  return MODES.find(mode => Math.abs(mode.minConfidence - minConfidence) < 0.005)?.id ?? 'custom'
}

export type Tone = 'ok' | 'idle' | 'warn' | 'off'
export type Status =
  | { tone: 'off'; key: 'loading' | 'notOpen' | 'unreachable' | 'paused' }
  | { tone: 'warn'; key: 'noPython' | 'enginePaused' }
  | { tone: 'warn'; key: 'failure'; text: string }
  | { tone: 'idle'; key: 'waiting'; count: number }
  | { tone: 'ok'; key: 'shortened'; count: number; fresh: number }
  | { tone: 'ok'; key: 'kept'; count: number }
  | { tone: 'idle'; key: 'startsAt'; percent: number }
  | { tone: 'idle'; key: 'watching' }

/** How many results are in the model's view now: the ones a compaction summarised away no longer count. */
export const liveItems = (state: Json): Json[] => (Array.isArray(state.items) ? state.items.filter((item: Json) => item.onSurface) : [])

/** The one phrase the bar shows. The most important true thing wins; nothing here is a claim about money or tokens saved. */
export function statusOf(state: Json | null, failed: boolean, seenRef: number): Status {
  if (!state) return { tone: 'off', key: failed ? 'unreachable' : 'loading' }
  if (state.live === false) return { tone: 'off', key: 'notOpen' }
  if (!state.python) return { tone: 'warn', key: 'noPython' }
  if (state.engine?.state === 'disabled') return { tone: 'warn', key: 'enginePaused' }
  if (typeof state.failure === 'string' && state.failure) return { tone: 'warn', key: 'failure', text: state.failure }
  if (state.chat?.pending > 0) return { tone: 'idle', key: 'waiting', count: state.chat.pending }
  if (state.settings?.values?.shorten === false) return { tone: 'off', key: 'paused' }
  const items = liveItems(state)
  // "shortened" counts only what the model really sees shortened now; a result held in full, or waiting to be, is not one
  const shortened = items.filter(item => item.state === 'shortened' && !item.queued)
  if (shortened.length > 0) return { tone: 'ok', key: 'shortened', count: shortened.length, fresh: shortened.filter(item => item.ref > seenRef).length }
  if (items.length > 0) return { tone: 'ok', key: 'kept', count: items.length }
  const gauge = state.gauge
  if (gauge && gauge.contextWindow > 0) return { tone: 'idle', key: 'startsAt', percent: Math.round((gauge.startsAt / gauge.contextWindow) * 100) }
  return { tone: 'idle', key: 'watching' }
}

/** The gauge's numbers as fractions of the context window. The host's own meter gives the fill; the ticks come from the plugin. */
export function gaugeOf(pressure: Json | undefined, state: Json | null): { percent: number; starts?: number; compacts?: number } | undefined {
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens ?? state?.gauge?.tokens
  const window = pressure?.contextWindow ?? state?.gauge?.contextWindow
  if (typeof used !== 'number' || typeof window !== 'number' || window <= 0) return undefined
  const fraction = (value: unknown): number | undefined => (typeof value === 'number' && value > 0 ? Math.min(1, value / window) : undefined)
  const starts = fraction(state?.gauge?.startsAt)
  const compacts = fraction(state?.gauge?.stockTrigger)
  return { percent: Math.min(100, Math.round((used / window) * 100)), ...(starts !== undefined ? { starts } : {}), ...(compacts !== undefined ? { compacts } : {}) }
}

/** A row's one-line size: `20.0K → 1.2K` while shortened, `20.0K in full` while held. */
export function sizeOf(item: Json, inFull: string): string {
  return item.state === 'shortened' ? `${compact(item.originalChars)} → ${compact(item.shownChars)}` : `${compact(item.originalChars)} ${inFull}`
}

const SEEN_KEY = 'dsh-tameru.v1.seen'
const TAB_KEY = 'dsh-tameru.v1.tab'

type Store = Pick<Storage, 'getItem' | 'setItem'>
const storeOf = (): Store | undefined => {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** Remembered per viewer, never required: every read and write is guarded. */
export function readSeen(sessionId: string, store: Store | undefined = storeOf()): number {
  try {
    const all = JSON.parse(store?.getItem(SEEN_KEY) ?? '{}') as Record<string, unknown>
    const value = all[sessionId]
    return typeof value === 'number' && Number.isFinite(value) ? value : -1
  } catch {
    return -1
  }
}

export function writeSeen(sessionId: string, ref: number, store: Store | undefined = storeOf()): void {
  try {
    const all = JSON.parse(store?.getItem(SEEN_KEY) ?? '{}') as Record<string, number>
    const entries = Object.entries(all).slice(-49)
    store?.setItem(SEEN_KEY, JSON.stringify({ ...Object.fromEntries(entries), [sessionId]: ref }))
  } catch {
    // the marker is a convenience
  }
}

export type TabId = 'results' | 'pins'

/** The chosen tab is remembered; whether the card is open is not (a floating card that reopens itself on every load is a nuisance). */
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

/** What a row needs to draw itself, in one place. */
export function rowFlags(item: Json): { kept: boolean; gone: boolean; queued: boolean; cut: boolean; restored: boolean } {
  return { kept: item.state === 'kept', gone: item.onSurface === false, queued: item.queued === true, cut: item.cutByHarness === true, restored: item.state === 'restored' }
}
