import type { EngineClient } from './engine-client.ts'
import { drainPending, type PendingOp } from './commands.ts'
import type { TrailState } from './trail.ts'
import { shortenPass, DEFAULT_SHORTEN, type MeterLike, type PassOutcome, type SessionLike, type ShortenOptions } from './shorten.ts'
import { compactionIsManagedElsewhere, policyFor, stockThreshold, type BackendLike } from './stock.ts'

export interface TameruSettings extends Partial<ShortenOptions> {
  /** Shorten tool results at step boundaries. Default true. */
  shorten?: boolean
  /** Start acting at this fraction of the Harness's own compaction trigger. Default 0.75. */
  activation?: number
}

export const DEFAULT_ACTIVATION = 0.75

/** What the pass did in one chat, for `/tameru`. Kept in memory only. */
export interface ChatStats {
  /** Results the engine already declined in this chat (not asked again). */
  declined: Set<string>
  /** Keep, restore and unkeep requests made while the agent was working; applied at the next step boundary. */
  pending: PendingOp[]
  /** Where the Artifact Trail scan has got to in this chat's log, and a trail still owed to the chat. */
  trail: TrailState
  shortened: number
  freedTokens: number
  passes: number
  /** Why the latest pass did nothing, if it did nothing. */
  lastSkip?: string
  /** Why the latest queued change could not be applied, for the panel to show once. */
  lastFailure?: string
}

export interface StepAgent {
  session: SessionLike & { requestHeader(): { config: { provider: string; model: string; maxTokens?: number } } | undefined }
}

export interface StepDeps {
  client: EngineClient
  meter: () => MeterLike | undefined
  resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) => Promise<{ context?: { contextWindow: number }; defaultMaxTokens?: number } | undefined>
  backendFor: (agent: StepAgent) => BackendLike | undefined
  settings: TameruSettings
  stats: WeakMap<object, ChatStats>
  log?: { info(message: string): unknown; warn(message: string): unknown }
}

export const chatStatsOf = (store: WeakMap<object, ChatStats>, session: object): ChatStats => {
  let stats = store.get(session)
  if (!stats) store.set(session, (stats = { declined: new Set(), pending: [], trail: { scanned: 0 }, shortened: 0, freedTokens: 0, passes: 0 }))
  return stats
}

export interface Pressure {
  header: NonNullable<ReturnType<StepAgent['session']['requestHeader']>>
  /** Tokens the chat holds now, as the Harness's own meter prices it. */
  tokens: number
  contextWindow: number
  /** The point at which the Harness's own backend would start compacting. */
  stockTrigger: number
  /** The point at which Tameru starts shortening. */
  startsAt: number
}

/** How full the chat is against the Harness's own trigger, or why that cannot be said. Used by the pass and by the panel's gauge. */
export async function pressureOf(deps: StepDeps, agent: StepAgent, signal?: AbortSignal): Promise<{ ok: true; pressure: Pressure } | { ok: false; reason: string }> {
  const meter = deps.meter()
  if (!meter) return { ok: false, reason: 'no_token_meter' }
  const backend = deps.backendFor(agent)
  if (compactionIsManagedElsewhere(backend)) return { ok: false, reason: 'managed_elsewhere' }
  const header = agent.session.requestHeader()
  if (!header?.config.provider || !header.config.model) return { ok: false, reason: 'no_request_yet' }
  const { provider, model } = header.config
  const info = await deps.resolveModelInfo(provider, model, signal)
  const contextWindow = info?.context?.contextWindow
  if (contextWindow === undefined) return { ok: false, reason: 'no_context_window' }
  const stockTrigger = stockThreshold({
    contextWindow,
    reservedCompletionTokens: header.config.maxTokens ?? info?.defaultMaxTokens ?? 0,
    ...policyFor(backend, provider, model),
  })
  if (stockTrigger === undefined) return { ok: false, reason: 'unusable_context_window' }
  return {
    ok: true,
    pressure: {
      header,
      tokens: meter.measure(agent.session, header).totalTokens,
      contextWindow,
      stockTrigger,
      startsAt: Math.floor(stockTrigger * (deps.settings.activation ?? DEFAULT_ACTIVATION)),
    },
  }
}

/** The outcome of the pass, or the reason it did not run. Never throws: a problem here must never cost the user a turn. */
export async function onPreStep(deps: StepDeps, agent: StepAgent, signal?: AbortSignal): Promise<PassOutcome | { kind: 'skipped'; reason: string }> {
  const stats = chatStatsOf(deps.stats, agent.session)
  const skip = (reason: string) => {
    stats.lastSkip = reason
    return { kind: 'skipped' as const, reason }
  }
  try {
    const meter = deps.meter()
    if (!meter) return skip('no_token_meter')
    // what the user asked for while the agent was working (keep, restore, unkeep) is done first, even with shortening switched off
    for (const failure of drainPending(agent.session, meter, stats)) {
      stats.lastFailure = failure.reason
      deps.log?.warn(`dsh-tameru: could not ${failure.op.op} reference ${failure.op.ref}: ${failure.reason}`)
    }
    if (deps.settings.shorten === false) return skip('off')
    const found = await pressureOf(deps, agent, signal)
    if (!found.ok) return skip(found.reason)
    const { pressure } = found
    const options: ShortenOptions = {
      protectRecent: deps.settings.protectRecent ?? DEFAULT_SHORTEN.protectRecent,
      minResultChars: deps.settings.minResultChars ?? DEFAULT_SHORTEN.minResultChars,
      share: deps.settings.share ?? DEFAULT_SHORTEN.share,
      maxPerPass: deps.settings.maxPerPass ?? DEFAULT_SHORTEN.maxPerPass,
      minConfidence: deps.settings.minConfidence ?? DEFAULT_SHORTEN.minConfidence,
    }
    const outcome = await shortenPass({
      session: agent.session,
      meter,
      client: deps.client,
      header: pressure.header,
      activationTokens: pressure.startsAt,
      options,
      declined: stats.declined,
      ...(signal ? { signal } : {}),
    })
    stats.passes++
    if (outcome.kind === 'applied') {
      stats.shortened += outcome.applied.length
      stats.freedTokens += outcome.freedTokens
      delete stats.lastSkip
      deps.log?.info(`dsh-tameru: shortened ${outcome.applied.length} tool result(s), about ${outcome.freedTokens} tokens (Harness compaction would start at ${pressure.stockTrigger})`)
    } else {
      stats.lastSkip = outcome.reason
    }
    return outcome
  } catch (error) {
    deps.log?.warn(`dsh-tameru: skipped a step: ${error instanceof Error ? error.message : String(error)}`)
    return skip('error')
  }
}
