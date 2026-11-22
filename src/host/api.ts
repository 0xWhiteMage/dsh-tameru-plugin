import { requestHold } from './commands.ts'
import { MAX_READ_CHARS, listItems, readOriginal, turnOpen, type Item } from './originals.ts'
import { MAX_PINS, MAX_PIN_CHARS, type PinStore } from './pins.ts'
import { normalizeSettings } from './settings.ts'
import { DEFAULT_SHORTEN, type MeterLike, type SessionLike } from './shorten.ts'
import { DEFAULT_ACTIVATION, chatStatsOf, type ChatStats, type Pressure, type TameruSettings } from './step.ts'
import { textOnly } from './messages.ts'
import type { WorkerStatus } from '../shared/protocol.ts'

/** What the panel's route needs from the plugin. Everything the panel can do goes through the same functions the `/tameru` commands use. */
export interface ApiEnv {
  version: string
  /** The live session with this id, if any. A session that is not live is never reached. */
  sessionFor(id: string): SessionLike | undefined
  meter(): MeterLike | undefined
  stats: WeakMap<object, ChatStats>
  pins: PinStore
  /** The settings the plugin runs on right now; the route changes them in place. */
  settings: TameruSettings
  /** What the profile's patch file says, and what the user changed in the panel on top of it. Only `saved` is ever written. */
  profile: TameruSettings
  saved: TameruSettings
  saveSettings(settings: TameruSettings): string | undefined
  engine(): WorkerStatus | undefined
  pythonPath(): string | undefined
  pressure(session: SessionLike): Promise<{ ok: true; pressure: Pressure } | { ok: false; reason: string }>
}

export type ApiResult = { ok: true; [key: string]: unknown } | { ok: false; error: string }

const fail = (error: string): ApiResult => ({ ok: false, error })
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const VIEW_CHARS = 3000
const FAILURE_SHOWN_MS = 30_000

export const SETTING_KEYS = ['shorten', 'activation', 'minConfidence', 'share', 'protectRecent', 'minResultChars', 'maxPerPass'] as const

/** The settings in effect, with the default each one falls back to. */
export function effectiveSettings(settings: TameruSettings, saved?: TameruSettings): { values: Record<string, unknown>; defaults: Record<string, unknown>; saved: boolean } {
  const defaults: Record<string, unknown> = { shorten: true, activation: DEFAULT_ACTIVATION, ...DEFAULT_SHORTEN }
  const values: Record<string, unknown> = {}
  for (const key of SETTING_KEYS) values[key] = (settings as Record<string, unknown>)[key] ?? defaults[key]
  return { values, defaults, saved: saved !== undefined && Object.keys(saved).length > 0 }
}

function describe(item: Item, queued: Set<number>): Record<string, unknown> {
  return { ref: item.ref, tool: item.toolName, label: item.label, state: item.state, originalChars: item.originalChars, shownChars: item.shownChars, onSurface: item.onSurface, cutByHarness: item.cutByHarness, queued: queued.has(item.ref) }
}

/**
 * Why a request to the panel's route is refused before it is read, if it is. The panel always sends JSON from its own page, and a pin
 * lands in the system prompt, so a request another site could make without a preflight (a form or a `text/plain` fetch, which still
 * carries the browser's credentials) or one the browser marks as cross-site is turned away.
 */
export function refuseRequest(headers: { get(name: string): string | null }): { status: number; error: string } | undefined {
  if (headers.get('sec-fetch-site') === 'cross-site') return { status: 403, error: 'cross-site request' }
  const type = (headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'application/json') return { status: 415, error: 'JSON is needed' }
  return undefined
}

/** One panel request. `endpoint` and `payload` come from the browser: nothing in them is trusted beyond its validated shape. */
export async function handleApi(endpoint: string, payload: unknown, env: ApiEnv): Promise<ApiResult> {
  const body = isObject(payload) ? payload : {}
  try {
    if (endpoint === 'settings') return settingsEndpoint(body, env)
    const sessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0 && body.sessionId.length < 200 ? body.sessionId : undefined
    if (!sessionId) return fail('a session is needed')
    const session = env.sessionFor(sessionId)
    if (endpoint === 'state') {
      if (!session) return { ok: true, live: false, version: env.version }
      return await stateEndpoint(session, env)
    }
    if (!session) return fail('that chat is not open')
    const stats = chatStatsOf(env.stats, session)
    const ref = typeof body.ref === 'number' && Number.isInteger(body.ref) ? body.ref : undefined
    switch (endpoint) {
      case 'hold': {
        const op = body.op
        if (ref === undefined || (op !== 'keep' && op !== 'restore' && op !== 'unkeep')) return fail('a reference and an action are needed')
        const reply = requestHold({ session, meter: env.meter(), stats }, { op, ref })
        return reply.kind === 'success' ? { ok: true, text: reply.text, queued: reply.text.startsWith('Queued') } : fail(reply.text)
      }
      case 'view': {
        if (ref === undefined) return fail('a reference is needed')
        const offset = typeof body.offset === 'number' && Number.isInteger(body.offset) ? body.offset : 0
        if (body.which === 'shown') {
          const item = listItems(session).find(candidate => candidate.ref === ref)
          const text = item ? textOnly(session.eventAt(item.currentSeq)?.data.message ?? { role: '', content: [] }) : undefined
          if (!item || text === undefined) return fail('that result is not in the chat')
          const start = Math.max(0, Math.min(offset, text.length))
          return { ok: true, text: text.slice(start, start + VIEW_CHARS), offset: start, end: Math.min(text.length, start + VIEW_CHARS), total: text.length }
        }
        const read = readOriginal(session, ref, offset, VIEW_CHARS)
        return read.ok ? { ok: true, text: read.text, offset: read.offset, end: read.end, total: read.total } : fail(read.reason)
      }
      case 'pin': {
        if (typeof body.text !== 'string') return fail('some text is needed')
        const result = env.pins.add(sessionId, body.text)
        return result.ok ? { ok: true, pins: result.pins } : fail(result.reason)
      }
      case 'unpin': {
        const result = env.pins.remove(sessionId, typeof body.position === 'number' ? body.position : NaN)
        return result.ok ? { ok: true, pins: result.pins } : fail(result.reason)
      }
      default:
        return fail('unknown request')
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'something went wrong')
  }
}

async function stateEndpoint(session: SessionLike, env: ApiEnv): Promise<ApiResult> {
  const stats = chatStatsOf(env.stats, session)
  const found = await env.pressure(session).catch(() => ({ ok: false as const, reason: 'error' }))
  const gauge = found.ok
    ? { tokens: found.pressure.tokens, contextWindow: found.pressure.contextWindow, stockTrigger: found.pressure.stockTrigger, startsAt: found.pressure.startsAt }
    : undefined
  const items = listItems(session)
  const queued = new Set(stats.pending.map(op => op.ref))
  // a queued change that could not be applied is shown for 30 seconds, to every panel that asks (a second panel or a refresh sees it too)
  const failure = stats.lastFailure !== undefined && Date.now() - (stats.lastFailureAt ?? 0) < FAILURE_SHOWN_MS ? stats.lastFailure : null
  return {
    ok: true,
    live: true,
    version: env.version,
    engine: env.engine() ?? { state: 'idle' },
    python: env.pythonPath() ?? null,
    working: turnOpen(session),
    gauge: gauge ?? null,
    gaugeUnavailable: found.ok ? null : found.reason,
    chat: { shortened: stats.shortened, freedTokens: stats.freedTokens, passes: stats.passes, lastSkip: stats.lastSkip ?? null, pending: stats.pending.length },
    items: items.map(item => describe(item, queued)),
    failure,
    pins: session.id ? env.pins.list(session.id) : [],
    limits: { pins: MAX_PINS, pinChars: MAX_PIN_CHARS, view: VIEW_CHARS, read: MAX_READ_CHARS },
    settings: effectiveSettings(env.settings, env.saved),
  }
}

function settingsEndpoint(body: Record<string, unknown>, env: ApiEnv): ApiResult {
  const patch = isObject(body.patch) ? body.patch : undefined
  if (patch) {
    const next: Record<string, unknown> = { ...(env.saved as Record<string, unknown>) }
    for (const [key, value] of Object.entries(patch)) {
      if (!(SETTING_KEYS as readonly string[]).includes(key)) return fail(`unknown setting "${key.slice(0, 40)}"`)
      if (value === null) {
        // back to what the profile (or the default) says
        delete next[key]
        continue
      }
      const accepted = normalizeSettings({ [key]: value }) as Record<string, unknown>
      if (accepted[key] === undefined) return fail(`"${key}" is out of range`)
      next[key] = accepted[key]
    }
    const failure = env.saveSettings(next as TameruSettings)
    if (failure) return fail(`could not save the settings: ${failure}`)
    for (const key of Object.keys(env.saved)) delete (env.saved as Record<string, unknown>)[key]
    Object.assign(env.saved, next)
    for (const key of Object.keys(env.settings)) delete (env.settings as Record<string, unknown>)[key]
    Object.assign(env.settings, env.profile, env.saved)
  }
  return { ok: true, settings: effectiveSettings(env.settings, env.saved) }
}
