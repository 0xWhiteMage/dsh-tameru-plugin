/** The worker protocol (version 1): one JSON object per line each way. The Python side is `vendor/run_worker.py`. */

export const PROTOCOL_VERSION = 1

export type CompressMode = 'adaptive' | 'fixed' | 'compiler' | 'precision'

/** What the host may ask the engine to do. Nothing else is sent: the worker rejects unknown fields. */
export interface CompressRequest {
  text: string
  query?: string
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
}

export interface WorkerVersion {
  engineVersion: string
  vendoredFrom: string | null
  protocol: number
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
export function toWire(id: number, request: CompressRequest): Record<string, unknown> {
  const wire: Record<string, unknown> = { id, op: 'compress', text: request.text, query: request.query ?? '' }
  if (request.mode !== undefined) wire.mode = request.mode
  if (request.budgetRatio !== undefined) wire.budget_ratio = request.budgetRatio
  if (request.pinRecent !== undefined) wire.pin_recent = request.pinRecent
  if (request.minSavingsRatio !== undefined) wire.min_savings_ratio = request.minSavingsRatio
  if (request.deriveQuery !== undefined) wire.derive_query = request.deriveQuery
  return wire
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
  }
}

export function fromWireVersion(result: Record<string, unknown>): WorkerVersion | undefined {
  if (typeof result.engine_version !== 'string' || typeof result.protocol !== 'number') return undefined
  return {
    engineVersion: result.engine_version,
    vendoredFrom: typeof result.vendored_from === 'string' ? result.vendored_from : null,
    protocol: result.protocol,
    python: typeof result.python === 'string' ? result.python : '',
  }
}
