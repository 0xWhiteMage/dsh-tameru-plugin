import type { EngineClient } from './engine-client.ts'
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
  shortened: number
  freedTokens: number
  passes: number
  /** Why the latest pass did nothing, if it did nothing. */
  lastSkip?: string
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

const statsOf = (deps: StepDeps, session: object): ChatStats => {
  let stats = deps.stats.get(session)
  if (!stats) deps.stats.set(session, (stats = { shortened: 0, freedTokens: 0, passes: 0 }))
  return stats
}

/** The outcome of the pass, or the reason it did not run. Never throws: a problem here must never cost the user a turn. */
export async function onPreStep(deps: StepDeps, agent: StepAgent, signal?: AbortSignal): Promise<PassOutcome | { kind: 'skipped'; reason: string }> {
  const stats = statsOf(deps, agent.session)
  const skip = (reason: string) => {
    stats.lastSkip = reason
    return { kind: 'skipped' as const, reason }
  }
  try {
    if (deps.settings.shorten === false) return skip('off')
    const meter = deps.meter()
    if (!meter) return skip('no_token_meter')
    const backend = deps.backendFor(agent)
    if (compactionIsManagedElsewhere(backend)) return skip('managed_elsewhere')
    const header = agent.session.requestHeader()
    if (!header?.config.provider || !header.config.model) return skip('no_request_yet')
    const { provider, model } = header.config
    const info = await deps.resolveModelInfo(provider, model, signal)
    const contextWindow = info?.context?.contextWindow
    if (contextWindow === undefined) return skip('no_context_window')
    const threshold = stockThreshold({
      contextWindow,
      reservedCompletionTokens: header.config.maxTokens ?? info?.defaultMaxTokens ?? 0,
      ...policyFor(backend, provider, model),
    })
    if (threshold === undefined) return skip('unusable_context_window')
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
      header,
      activationTokens: Math.floor(threshold * (deps.settings.activation ?? DEFAULT_ACTIVATION)),
      options,
      ...(signal ? { signal } : {}),
    })
    stats.passes++
    if (outcome.kind === 'applied') {
      stats.shortened += outcome.applied.length
      stats.freedTokens += outcome.freedTokens
      delete stats.lastSkip
      deps.log?.info(`dsh-tameru: shortened ${outcome.applied.length} tool result(s), about ${outcome.freedTokens} tokens (Harness compaction would start at ${threshold})`)
    } else {
      stats.lastSkip = outcome.reason
    }
    return outcome
  } catch (error) {
    deps.log?.warn(`dsh-tameru: skipped a step: ${error instanceof Error ? error.message : String(error)}`)
    return skip('error')
  }
}
