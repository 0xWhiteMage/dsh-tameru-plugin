import type { EngineClient } from './engine-client.ts'
import { drainPending, type PendingOp } from './commands.ts'
import type { TrailState } from './trail.ts'
import { shortenPass, DEFAULT_SHORTEN, type MeterLike, type PassEvent, type PassOutcome, type SessionLike, type ShortenOptions } from './shorten.ts'
import { planPass } from './plan.ts'
import { STOCK_PRUNE_DEFAULTS } from './stub.ts'
import { resolveEffective } from './settings.ts'
import { BETA_DEFAULT, INCUMBENT, type Channel, type Policy, type PriceProfile } from '../shared/settings-table.ts'
import { STOCK_PRUNE_CUT_CHARS, STOCK_PRUNE_THRESHOLD_CHARS, compactionIsManagedElsewhere, policyFor, stockThreshold, type BackendLike } from './stock.ts'

export interface TameruSettings extends Partial<ShortenOptions> {
  /** Shorten tool results at step boundaries. Default true. */
  shorten?: boolean
  /** Start acting at this fraction of the Harness's own compaction trigger. Default 0.75 (`every-step` only). */
  activation?: number
  /** `stable` (default): the incumbent behaviour, whatever `policy` says. `beta`: `policy` is honoured (see src/shared/settings-table.ts). */
  channel?: Channel
  /**
   * When to act (beta channel only; stable always runs `every-step`). `every-step` (the incumbent, stable behaviour): at every step
   * boundary once the chat is `activation` of the way to the Harness's trigger, on old results, with the confidence gate. `at-trigger`
   * (the beta default when unset; UNCONFIRMED, its round 1 holdout look failed gate 8, see docs/FROZEN-1.10.0-SETTINGS.md): only when
   * the Harness's own pruner is about to cut, in place of its head/tail cut, with no confidence gate unless one is set. `hybrid`: at the
   * trigger, ordinary candidates, share rule beyond the stock cut. `plan`: at the trigger, the engine's `plan()` covers every result
   * stock would cut — an extract where the EV rule accepts it, the stock cut otherwise; the strength picks the EV strength.
   */
  policy?: Policy
  /** The engine price profile `plan`'s EV rule prices rewrites with (beta, `plan` only). */
  priceProfile?: PriceProfile
  /** Reserved for the expected-value rule: accepted and stored, not used yet. */
  lambdaMultiplier?: number
}

export const DEFAULT_ACTIVATION = INCUMBENT.activation
/** The stable default: the incumbent behaviour. `at-trigger` and `hybrid` are beta-channel policies. */
export const DEFAULT_POLICY = INCUMBENT.policy
/** The gate the beta channel's unset `at-trigger` uses: none (the stock cut it replaces has no confidence check either). */
export const DEFAULT_TRIGGER_CONFIDENCE = BETA_DEFAULT.triggerMinConfidence
/** The policy in force (channel rules applied): see `resolveEffective`. */
export const policyOfSettings = (settings: TameruSettings): Policy => resolveEffective(settings).policy

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
  /** How often the engine's decision came out with each closed reason code (`ok`, `low_confidence`, `no_gain`, ...). */
  reasons: Record<string, number>
  /** `plan`: prompt tokens at the previous step, and the mean growth over this chat's steps (for `n_eff`). */
  prevTokens?: number
  stepTokensSum?: number
  stepTokensCount?: number
  /** `plan`: `passes` at the last act (the hysteresis input). */
  lastPlanAct?: number
  /** Why the latest pass did nothing, if it did nothing. */
  lastSkip?: string
  /** Why the latest queued change could not be applied, for the panel to show once. */
  lastFailure?: string
  /** When it happened (ms); the panel shows it for a short while, to every panel that asks. */
  lastFailureAt?: number
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
  /** The stock pruner's cut, for `policy: 'at-trigger'`/`'hybrid'`/`'plan'` (default: the Harness's own defaults). */
  stockPruner?: { thresholdChars: number; cutChars: number; headChars?: number; tailChars?: number }
  /** A listener for what each pass decided and wrote (measurements only). */
  observe?: (event: PassEvent) => void
  log?: { info(message: string): unknown; warn(message: string): unknown }
}

export const chatStatsOf = (store: WeakMap<object, ChatStats>, session: object): ChatStats => {
  let stats = store.get(session)
  if (!stats) store.set(session, (stats = { declined: new Set(), pending: [], trail: { scanned: 0 }, shortened: 0, freedTokens: 0, passes: 0, reasons: {} }))
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
      startsAt: Math.floor(stockTrigger * resolveEffective(deps.settings).activation),
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
      stats.lastFailureAt = Date.now()
      deps.log?.warn(`dsh-tameru: could not ${failure.op.op} reference ${failure.op.ref}: ${failure.reason}`)
    }
    if (deps.settings.shorten === false) return skip('off')
    const found = await pressureOf(deps, agent, signal)
    if (!found.ok) return skip(found.reason)
    const { pressure } = found
    const effective = resolveEffective(deps.settings)
    // the session's own growth: mean tokens a step adds, for `plan`'s `n_eff` (only positive deltas are "added")
    if (stats.prevTokens !== undefined && pressure.tokens !== stats.prevTokens) {
      stats.stepTokensSum = (stats.stepTokensSum ?? 0) + Math.max(0, pressure.tokens - stats.prevTokens)
      stats.stepTokensCount = (stats.stepTokensCount ?? 0) + 1
    }
    stats.prevTokens = pressure.tokens
    const options: ShortenOptions = {
      protectRecent: deps.settings.protectRecent ?? DEFAULT_SHORTEN.protectRecent,
      minResultChars: deps.settings.minResultChars ?? DEFAULT_SHORTEN.minResultChars,
      share: deps.settings.share ?? DEFAULT_SHORTEN.share,
      maxPerPass: deps.settings.maxPerPass ?? DEFAULT_SHORTEN.maxPerPass,
      minConfidence: effective.minConfidence,
    }
    const outcome = effective.policy === 'plan'
      ? await planPass({
          session: agent.session,
          meter,
          client: deps.client,
          header: pressure.header,
          activationTokens: pressure.stockTrigger,
          stockPruner: {
            thresholdChars: deps.stockPruner?.thresholdChars ?? STOCK_PRUNE_DEFAULTS.thresholdChars,
            headChars: deps.stockPruner?.headChars ?? STOCK_PRUNE_DEFAULTS.headChars,
            tailChars: deps.stockPruner?.tailChars ?? STOCK_PRUNE_DEFAULTS.tailChars,
          },
          ev: { priceProfile: effective.priceProfile, strength: effective.evStrength },
          ...(stats.lastPlanAct !== undefined ? { stepsSinceLastAct: stats.passes - stats.lastPlanAct } : {}),
          meanStepTokens: stats.stepTokensCount ? stats.stepTokensSum! / stats.stepTokensCount : undefined,
          declined: stats.declined,
          reasons: stats.reasons,
          ...(deps.observe ? { observe: deps.observe } : {}),
          ...(signal ? { signal } : {}),
        })
      : await shortenPass({
      session: agent.session,
      meter,
      client: deps.client,
      header: pressure.header,
      activationTokens: pressure.startsAt,
      options,
      declined: stats.declined,
      reasons: stats.reasons,
      ...(effective.policy !== 'every-step' ? { trigger: { ...(deps.stockPruner ?? { thresholdChars: STOCK_PRUNE_THRESHOLD_CHARS, cutChars: STOCK_PRUNE_CUT_CHARS }), ...(effective.policy === 'hybrid' ? { hybrid: true } : {}) } } : {}),
      ...(deps.observe ? { observe: deps.observe } : {}),
      ...(signal ? { signal } : {}),
        })
    stats.passes++
    if (outcome.kind === 'applied') {
      stats.shortened += outcome.applied.length
      stats.freedTokens += outcome.freedTokens
      if (effective.policy === 'plan') stats.lastPlanAct = stats.passes
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
