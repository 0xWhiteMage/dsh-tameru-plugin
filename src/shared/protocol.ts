/**
 * The worker protocol: one JSON object per line each way. The Python side is `vendor/run_worker.py`, whose fields, ranges and closed
 * enums come from the engine's own `tameru.protocol` (engine 1.10.0: protocol 3). `PROTOCOL_VERSION` is the newest this host speaks;
 * a worker that reports 1 (an engine before 1.10.0) is still served, with version 1 fields only.
 */

export const PROTOCOL_VERSION = 3
export const OLDEST_PROTOCOL = 1

/** What the host will accept, passed to the worker as data; the engine's `decide()` applies it. These are the `DSH_POLICY` fields. */
export interface AcceptPolicy {
  minConfidence: number
  minSavedRatio: number
  minTokensSaved: number
  allowSanitized: boolean
}

/** A tool call as the worker's query builder reads it. */
export interface QueryCall {
  name: string
  arguments?: unknown
}

/** The pieces of the question; the worker builds the one query from them with the engine's shared `build_query`. */
export interface QueryParts {
  call?: QueryCall
  after?: { text: string; calls: QueryCall[] }
  lastUser?: string
  firstUser?: string
}

/** The closed reason codes of the engine's `decide()`. */
export type DecisionReason = 'ok' | 'fail_open' | 'risk' | 'lost_fingerprint' | 'low_confidence' | 'no_gain' | 'sanitized' | 'not_enough_tokens' | 'negative_ev' | 'malformed'

export interface Decision {
  accept: boolean
  reason: DecisionReason
  basis: string
}

/** What the engine left out: a category (`classify_line`), how many lines, and where the first one was. */
export interface Dropped {
  category: string
  lines: number
  where: string
}

export type CompressMode = 'adaptive' | 'fixed' | 'compiler' | 'precision'

/** What the host may ask the engine to do. Nothing else is sent: the worker rejects unknown fields. */
export interface CompressRequest {
  text: string
  query?: string
  /** Version 2 fields: sent only when the worker reports protocol 2, otherwise left out. */
  preset?: string
  anchorErrors?: boolean
  redactSecrets?: boolean
  queryParts?: QueryParts
  policy?: AcceptPolicy
  mode?: CompressMode
  budgetRatio?: number
  pinRecent?: number
  minSavingsRatio?: number
  deriveQuery?: boolean
  /** Version 3: the worker builds the selector query from `queryParts` (`build_selector_query`) and passes it to the engine. */
  deriveSelectorQuery?: boolean
}

export interface CompressResult {
  /** The shortened text. Equals the input when `failOpen` is true. */
  text: string
  /** True when the engine declined to shorten (ambiguous, unsafe, or too little to save): leave the original as it is. */
  failOpen: boolean
  originalTokens: number
  keptTokens: number
  tokensSavedPct: number
  risk: string | null
  confidence: number | null
  contentType: string
  reasons: string[]
  /** True when lone surrogates in the input were replaced before compression. Do not trust `text` to be a verbatim subset. */
  sanitized: boolean
  /** From a protocol 2 worker that was sent a policy: the engine's decision. Absent otherwise. */
  decision?: Decision
  confidenceBasis?: string
  stableKey?: string
  dropped: Dropped[]
  resultSchema?: number
  preset?: string
  /** Schema 3: fact lines the extract lost (0 when none or before schema 3). */
  factLinesDropped?: number
}

export interface WorkerVersion {
  engineVersion: string
  vendoredFrom: string | null
  protocol: number
  resultSchema?: number
  presets: string[]
  python: string
}

export type WorkerState = 'idle' | 'running' | 'disabled'

export interface WorkerStatus {
  state: WorkerState
  /** A short reason code for the last failure, never request text. */
  lastError?: string
  version?: WorkerVersion
}

/** The wire fields, snake_case, exactly as `run_worker.py` accepts them. */
export function toWire(id: number, request: CompressRequest, protocol: number = OLDEST_PROTOCOL): Record<string, unknown> {
  const v2 = protocol >= 2
  const wire: Record<string, unknown> = { id, op: 'compress', text: request.text }
  if (!(v2 && request.queryParts)) wire.query = request.query ?? ''
  if (v2) {
    wire.protocol = protocol
    if (request.preset !== undefined) wire.preset = request.preset
    if (request.anchorErrors !== undefined) wire.anchor_errors = request.anchorErrors
    if (request.redactSecrets !== undefined) wire.redact_secrets = request.redactSecrets
    if (request.queryParts) wire.query_parts = queryPartsToWire(request.queryParts)
    if (request.policy) {
      wire.policy = {
        min_confidence: request.policy.minConfidence,
        min_saved_ratio: request.policy.minSavedRatio,
        min_tokens_saved: request.policy.minTokensSaved,
        allow_sanitized: request.policy.allowSanitized,
      }
    }
  }
  if (request.mode !== undefined) wire.mode = request.mode
  if (request.budgetRatio !== undefined) wire.budget_ratio = request.budgetRatio
  if (request.pinRecent !== undefined) wire.pin_recent = request.pinRecent
  if (request.minSavingsRatio !== undefined) wire.min_savings_ratio = request.minSavingsRatio
  if (request.deriveQuery !== undefined) wire.derive_query = request.deriveQuery
  if (protocol >= 3 && request.deriveSelectorQuery !== undefined) wire.derive_selector_query = request.deriveSelectorQuery
  return wire
}

function queryPartsToWire(parts: QueryParts): Record<string, unknown> {
  const wire: Record<string, unknown> = {}
  if (parts.call) wire.call = parts.call
  if (parts.after) wire.after = parts.after
  if (parts.lastUser !== undefined) wire.last_user = parts.lastUser
  if (parts.firstUser !== undefined) wire.first_user = parts.firstUser
  return wire
}

const REASONS: readonly string[] = ['ok', 'fail_open', 'risk', 'lost_fingerprint', 'low_confidence', 'no_gain', 'sanitized', 'not_enough_tokens', 'negative_ev', 'malformed']

function fromWireDecision(value: unknown): Decision | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { accept, reason, basis } = value as Record<string, unknown>
  if (typeof accept !== 'boolean' || typeof reason !== 'string' || !REASONS.includes(reason)) return undefined
  return { accept, reason: reason as DecisionReason, basis: typeof basis === 'string' ? basis : '' }
}

function fromWireDropped(value: unknown): Dropped[] {
  if (!Array.isArray(value)) return []
  const out: Dropped[] = []
  for (const row of value.slice(0, 3)) {
    if (Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'number' && Number.isFinite(row[1]) && row[1] > 0) {
      out.push({ category: row[0], lines: Math.floor(row[1]), where: typeof row[2] === 'string' ? row[2] : '' })
    }
  }
  return out
}

export function fromWireResult(result: Record<string, unknown>): CompressResult | undefined {
  if (typeof result.text !== 'string' || typeof result.fail_open !== 'boolean') return undefined
  const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    text: result.text,
    failOpen: result.fail_open,
    originalTokens: number(result.original_tokens),
    keptTokens: number(result.kept_tokens),
    tokensSavedPct: number(result.tokens_saved_pct),
    risk: typeof result.risk === 'string' ? result.risk : null,
    confidence: typeof result.confidence === 'number' ? result.confidence : null,
    contentType: typeof result.content_type === 'string' ? result.content_type : 'text',
    reasons: Array.isArray(result.reasons) ? result.reasons.filter((r): r is string => typeof r === 'string') : [],
    sanitized: result.sanitized === true,
    ...(fromWireDecision(result.decision) ? { decision: fromWireDecision(result.decision)! } : {}),
    ...(typeof result.confidence_basis === 'string' ? { confidenceBasis: result.confidence_basis } : {}),
    ...(typeof result.stable_key === 'string' && result.stable_key !== '' ? { stableKey: result.stable_key } : {}),
    dropped: fromWireDropped(result.dropped),
    ...(typeof result.fact_lines_dropped === 'number' ? { factLinesDropped: result.fact_lines_dropped } : {}),
    ...(typeof result.result_schema === 'number' ? { resultSchema: result.result_schema } : {}),
    ...(typeof result.preset === 'string' ? { preset: result.preset } : {}),
  }
}

export function fromWireVersion(result: Record<string, unknown>): WorkerVersion | undefined {
  if (typeof result.engine_version !== 'string' || typeof result.protocol !== 'number') return undefined
  return {
    engineVersion: result.engine_version,
    vendoredFrom: typeof result.vendored_from === 'string' ? result.vendored_from : null,
    protocol: result.protocol,
    ...(typeof result.result_schema === 'number' ? { resultSchema: result.result_schema } : {}),
    presets: Array.isArray(result.presets) ? result.presets.filter((p): p is string => typeof p === 'string') : [],
    python: typeof result.python === 'string' ? result.python : '',
  }
}

// ---------- protocol 3: the `plan` request ----------

/** One item for `plan()`: identity, cost, stock fate and the engine's precomputed candidate (host side, camelCase). */
export interface PlanCandidate {
  compressedChars: number
  tokensSaved: number
  confidence: number | null
  failOpen: boolean
  risk: 'low' | 'medium' | 'high'
  fingerprintsOk: boolean
  factLinesDropped?: number
}

export interface PlanItem {
  id: string
  position: number
  tokens: number
  chars: number
  ageSteps?: number
  protected?: boolean
  stockAction: 'keep' | 'cut' | 'demote'
  stockKeptChars?: number
  candidate?: PlanCandidate | null
  factLines?: number
  supersededBy?: string | null
  factsCoveredBySuccessor?: boolean
  stratum?: string
}

export interface PlanEv {
  priceProfile: string
  lossProfile: string
  strength?: 'less' | 'normal' | 'more'
  quantile?: number
}

export interface PlanPolicy {
  minConfidence?: number | null
  maxRisk?: 'low' | 'medium' | 'high'
  requireFingerprints?: boolean
  minSavedRatio?: number | null
  minTokensSaved?: number | null
  allowSanitized?: boolean
  ev?: PlanEv | null
}

export interface PlanRequest {
  event: 'trigger' | 'cache_cold' | 'prefix_rewritten' | 'step'
  hostMode: 'prune' | 'compact'
  promptTokens: number
  triggerTokens: number
  items: PlanItem[]
  cache: { warm: boolean; nEff: number }
  policy: PlanPolicy
  stepsSinceLastAct?: number | null
  K?: number
  H?: number
  stepsToTrigger?: number | null
  retainedBudgetChars?: number
}

export interface PlanAction {
  id: string
  event: string
  action: 'keep' | 'extract' | 'stub' | 'brief' | 'header' | 'superseded'
  reason: string
  pHat: number | null
  V: number | null
  L: number | null
}

export interface PlanReply {
  event: string
  hostMode: string
  acted: boolean
  gate: string
  actions: PlanAction[]
  predictedCharsAfter: number
  predictedCharsStock: number
  predictedV: number
  predictedL: number
}

/** The `plan` request on the wire, snake_case, exactly as `validate_plan_request` accepts it. */
export function planToWire(id: number, request: PlanRequest): Record<string, unknown> {
  const item = (it: PlanItem): Record<string, unknown> => {
    const wire: Record<string, unknown> = {
      id: it.id,
      position: it.position,
      tokens: it.tokens,
      chars: it.chars,
      stock_action: it.stockAction,
    }
    if (it.ageSteps !== undefined) wire.age_steps = it.ageSteps
    if (it.protected !== undefined) wire.protected = it.protected
    if (it.stockKeptChars !== undefined) wire.stock_kept_chars = it.stockKeptChars
    if (it.candidate !== undefined) {
      wire.candidate = it.candidate === null ? null : {
        compressed_chars: it.candidate.compressedChars,
        tokens_saved: it.candidate.tokensSaved,
        confidence: it.candidate.confidence,
        fail_open: it.candidate.failOpen,
        risk: it.candidate.risk,
        fingerprints_ok: it.candidate.fingerprintsOk,
        ...(it.candidate.factLinesDropped !== undefined ? { fact_lines_dropped: it.candidate.factLinesDropped } : {}),
      }
    }
    if (it.factLines !== undefined) wire.fact_lines = it.factLines
    if (it.supersededBy !== undefined) wire.superseded_by = it.supersededBy
    if (it.factsCoveredBySuccessor !== undefined) wire.facts_covered_by_successor = it.factsCoveredBySuccessor
    if (it.stratum !== undefined) wire.stratum = it.stratum
    return wire
  }
  const policy: Record<string, unknown> = {}
  const p = request.policy
  if (p.minConfidence !== undefined) policy.min_confidence = p.minConfidence
  if (p.maxRisk !== undefined) policy.max_risk = p.maxRisk
  if (p.requireFingerprints !== undefined) policy.require_fingerprints = p.requireFingerprints
  if (p.minSavedRatio !== undefined) policy.min_saved_ratio = p.minSavedRatio
  if (p.minTokensSaved !== undefined) policy.min_tokens_saved = p.minTokensSaved
  if (p.allowSanitized !== undefined) policy.allow_sanitized = p.allowSanitized
  if (p.ev !== undefined) {
    policy.ev = p.ev === null ? null : {
      price_profile: p.ev.priceProfile,
      loss_profile: p.ev.lossProfile,
      ...(p.ev.strength !== undefined ? { strength: p.ev.strength } : {}),
      ...(p.ev.quantile !== undefined ? { quantile: p.ev.quantile } : {}),
    }
  }
  const wire: Record<string, unknown> = {
    id,
    op: 'plan',
    protocol: 3,
    event: request.event,
    host_mode: request.hostMode,
    prompt_tokens: request.promptTokens,
    trigger_tokens: request.triggerTokens,
    items: request.items.map(item),
    cache: { warm: request.cache.warm, n_eff: request.cache.nEff },
    policy,
  }
  if (request.stepsSinceLastAct !== undefined) wire.steps_since_last_act = request.stepsSinceLastAct
  if (request.K !== undefined) wire.K = request.K
  if (request.H !== undefined) wire.H = request.H
  if (request.stepsToTrigger !== undefined) wire.steps_to_trigger = request.stepsToTrigger
  if (request.retainedBudgetChars !== undefined) wire.retained_budget_chars = request.retainedBudgetChars
  return wire
}

/** The worker's `plan` reply; `undefined` when it cannot be read (the caller fails open on it). */
export function fromWirePlan(result: Record<string, unknown>): PlanReply | undefined {
  if (typeof result.acted !== 'boolean' || typeof result.gate !== 'string') return undefined
  if (!Array.isArray(result.actions)) return undefined
  const actions: PlanAction[] = []
  const nullableNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  for (const raw of result.actions) {
    if (typeof raw !== 'object' || raw === null) return undefined
    const action = raw as Record<string, unknown>
    if (typeof action.id !== 'string' || typeof action.action !== 'string' || typeof action.reason !== 'string') return undefined
    actions.push({
      id: action.id,
      event: typeof action.event === 'string' ? action.event : '',
      action: action.action as PlanAction['action'],
      reason: action.reason,
      pHat: nullableNumber(action.p_hat),
      V: nullableNumber(action.V),
      L: nullableNumber(action.L),
    })
  }
  const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    event: typeof result.event === 'string' ? result.event : '',
    hostMode: typeof result.host_mode === 'string' ? result.host_mode : '',
    acted: result.acted,
    gate: result.gate,
    actions,
    predictedCharsAfter: number(result.predicted_chars_after),
    predictedCharsStock: number(result.predicted_chars_stock),
    predictedV: number(result.predicted_V),
    predictedL: number(result.predicted_L),
  }
}
