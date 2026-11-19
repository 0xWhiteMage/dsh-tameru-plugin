/**
 * The worker protocol: one JSON object per line each way. The Python side is `vendor/run_worker.py`, whose fields, ranges and closed
 * enums come from the engine's own `tameru.protocol` (engine 1.10.0: protocol 2). `PROTOCOL_VERSION` is the newest this host speaks;
 * a worker that reports 1 (an engine before 1.10.0) is still served, with version 1 fields only.
 */

export const PROTOCOL_VERSION = 2
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
export type DecisionReason = 'ok' | 'fail_open' | 'risk' | 'lost_fingerprint' | 'low_confidence' | 'no_gain' | 'sanitized' | 'not_enough_tokens'

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
    wire.protocol = 2
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

const REASONS: readonly string[] = ['ok', 'fail_open', 'risk', 'lost_fingerprint', 'low_confidence', 'no_gain', 'sanitized', 'not_enough_tokens']

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
