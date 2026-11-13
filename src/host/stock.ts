/**
 * The Harness's own automatic compaction trigger, read the way its backend computes it, so Tameru can act before it.
 *
 * `dsh-compaction-basic` triggers at `floor(min(window * thresholdRatio, window - output - headroom))` tokens, with documented defaults
 * 0.8 and 65,536. This mirrors that arithmetic only; the backend's own code stays untouched and is the authority.
 */

export const STOCK_THRESHOLD_RATIO = 0.8
export const STOCK_HEADROOM_TOKENS = 65_536

export interface StockInput {
  contextWindow: number
  /** Output tokens one request reserves (the request's own cap, else the model's default, else 0). */
  reservedCompletionTokens: number
  thresholdRatio?: number
  headroomTokens?: number
}

/** The token count at which the stock backend would start compacting, or `undefined` when its own arithmetic would reject the setup. */
export function stockThreshold(input: StockInput): number | undefined {
  const { contextWindow, reservedCompletionTokens } = input
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return undefined
  if (!Number.isInteger(reservedCompletionTokens) || reservedCompletionTokens < 0) return undefined
  const ratio = input.thresholdRatio ?? STOCK_THRESHOLD_RATIO
  const headroom = input.headroomTokens ?? STOCK_HEADROOM_TOKENS
  const pressureBudget = contextWindow - reservedCompletionTokens - headroom
  if (pressureBudget <= 0) return undefined
  return Math.floor(Math.min(contextWindow * ratio, pressureBudget))
}

/** What a backend exposes of its configuration; any of it may be absent. */
export interface BackendLike {
  config?: {
    auto?: boolean
    thresholdRatio?: number
    headroomTokens?: number
    modelPolicies?: Array<{ provider: string; model: string; thresholdRatio?: number; headroomTokens?: number }>
  }
  [key: string]: unknown
}

/** The ratio and headroom the backend would use for one routed model: its per-model override, else its own setting, else the default. */
export function policyFor(backend: BackendLike | undefined, provider: string, model: string): { thresholdRatio?: number; headroomTokens?: number } {
  const config = backend?.config
  if (!config) return {}
  const override = config.modelPolicies?.find(policy => policy.provider === provider && policy.model === model)
  const thresholdRatio = override?.thresholdRatio ?? config.thresholdRatio
  const headroomTokens = override?.headroomTokens ?? config.headroomTokens
  return {
    ...(typeof thresholdRatio === 'number' ? { thresholdRatio } : {}),
    ...(typeof headroomTokens === 'number' ? { headroomTokens } : {}),
  }
}

/**
 * True when something other than the backend itself has taken over its automatic compaction for this agent. DS Bot does this for its
 * Bots: it assigns its own functions to the engine object, shadowing the backend's. Tameru then does nothing for that agent, because
 * the other plugin is managing the context and our changes would shift the counts it relies on.
 */
export function compactionIsManagedElsewhere(backend: BackendLike | undefined): boolean {
  if (!backend) return false
  for (const method of ['compactIfNeeded', 'compactNow', 'compactRegion', 'summarize'] as const) {
    if (Object.hasOwn(backend, method)) return true
  }
  return backend.config?.auto === false
}
