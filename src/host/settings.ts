import { BETA_DEFAULT, INCUMBENT, SETTINGS_TABLE, acceptValue, strengthFor, type Channel, type Policy, type StrengthLabel } from '../shared/settings-table.ts'
import { ENGINE_PRESET } from './shorten.ts'
import type { TameruSettings } from './step.ts'

export interface TameruConfig extends TameruSettings {
  enabled?: boolean
  /** Path to a Python 3.10+ interpreter for the engine. Default: the interpreter the Harness bundles. */
  pythonPath?: string
}

/** Settings from the user's profile, with anything out of range or of the wrong type ignored in favour of the default (src/shared/settings-table.ts). */
export function normalizeSettings(raw: unknown): TameruSettings {
  const config = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const spec of SETTINGS_TABLE) {
    if (spec.scope !== 'panel') continue
    const value = acceptValue(spec.key, config[spec.key])
    if (value !== undefined) out[spec.key] = value
  }
  return out as TameruSettings
}

/**
 * The settings in force, resolved once. The panel shows only this object and the pass runs on it, so the label can never say one thing
 * while the plugin does another.
 */
export interface Effective {
  channel: Channel
  policy: Policy
  shorten: boolean
  strength: StrengthLabel
  /** The confidence gate in force (a stored value is a hard minimum and is never rewritten). */
  minConfidence: number
  /** The fraction of the Harness's trigger at which the pass starts (1 for the trigger policies). */
  activation: number
  /** The pay-back share and protected results in force (0 and 0 under `at-trigger`, which sets them itself). */
  share: number
  protectRecent: number
  /** Reserved (stored, not used yet). */
  lambdaMultiplier: number
  engineVersion: string | null
  presetId: string
}

/**
 * Stable: the incumbent behaviour whatever beta-only keys say (`every-step`; the strength's gate, default 0.7). Beta: the stored `policy`
 * and `minConfidence` exactly as stored; with no `policy`, the unconfirmed round 1 candidate (`at-trigger`, gate 0 unless one is stored).
 */
export function resolveEffective(settings: TameruSettings, engineVersion: string | null = null): Effective {
  const channel: Channel = settings.channel === 'beta' ? 'beta' : 'stable'
  const policy: Policy = channel === 'stable' ? INCUMBENT.policy : (settings.policy ?? BETA_DEFAULT.policy)
  const unsetGate = channel === 'beta' && policy === 'at-trigger' ? BETA_DEFAULT.triggerMinConfidence : INCUMBENT.minConfidence
  const minConfidence = settings.minConfidence ?? unsetGate
  const shorten = settings.shorten !== false
  return {
    channel,
    policy,
    shorten,
    strength: strengthFor(shorten, policy, minConfidence),
    minConfidence,
    activation: policy === 'every-step' ? (settings.activation ?? INCUMBENT.activation) : 1,
    share: policy === 'at-trigger' ? 0 : (settings.share ?? INCUMBENT.share),
    protectRecent: policy === 'at-trigger' ? 0 : (settings.protectRecent ?? INCUMBENT.protectRecent),
    lambdaMultiplier: settings.lambdaMultiplier ?? 1,
    engineVersion,
    presetId: ENGINE_PRESET,
  }
}
