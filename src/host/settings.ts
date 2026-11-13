import { DEFAULT_ACTIVATION, type TameruSettings } from './step.ts'
import { DEFAULT_SHORTEN } from './shorten.ts'

export interface TameruConfig extends TameruSettings {
  enabled?: boolean
  /** Path to a Python 3.10+ interpreter for the engine. Default: the interpreter the Harness bundles. */
  pythonPath?: string
}

const number = (value: unknown, low: number, high: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high ? value : undefined

/** Settings from the user's profile, with anything out of range or of the wrong type ignored in favour of the default. */
export function normalizeSettings(raw: unknown): TameruSettings {
  const config = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const out: TameruSettings = {}
  if (typeof config.shorten === 'boolean') out.shorten = config.shorten
  const activation = number(config.activation, 0.3, 0.95)
  if (activation !== undefined) out.activation = activation
  const share = number(config.share, 0.1, 0.9)
  if (share !== undefined) out.share = share
  const protectRecent = number(config.protectRecent, 0, 100)
  if (protectRecent !== undefined) out.protectRecent = Math.floor(protectRecent)
  const minResultChars = number(config.minResultChars, 1000, 1_000_000)
  if (minResultChars !== undefined) out.minResultChars = Math.floor(minResultChars)
  const minConfidence = number(config.minConfidence, 0, 1)
  if (minConfidence !== undefined) out.minConfidence = minConfidence
  const maxPerPass = number(config.maxPerPass, 1, 100)
  if (maxPerPass !== undefined) out.maxPerPass = Math.floor(maxPerPass)
  return out
}

export const SETTING_DEFAULTS = { shorten: true, activation: DEFAULT_ACTIVATION, ...DEFAULT_SHORTEN } as const
