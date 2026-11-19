// THE ONE SETTINGS TABLE. Every setting key, its type, range, default, the channel it takes effect on, and what it means. Everything else
// is derived from it: the host's defaults and validation (src/host/settings.ts, step.ts, shorten.ts), the keys the panel may change
// (SETTING_KEYS), the strengths the panel offers, and the settings table in README.md. A test fails if any of them drifts from this file.

export type Channel = 'stable' | 'beta'
export type Policy = 'every-step' | 'at-trigger' | 'hybrid'
export const CHANNELS: readonly Channel[] = ['stable', 'beta']
export const POLICIES: readonly Policy[] = ['every-step', 'at-trigger', 'hybrid']

export interface SettingSpec {
  key: string
  type: 'boolean' | 'number' | 'integer' | 'enum' | 'string'
  /** Inclusive range for numbers; an integer setting is floored after the range check. */
  min?: number
  max?: number
  values?: readonly string[]
  /** The built-in default (undefined: none, see `defaultText`). */
  default: boolean | number | string | undefined
  /** How the README states the default when it is not a plain value. */
  defaultText?: string
  /** `stable`: in effect on both channels. `beta`: only in effect on the beta channel (stored, but ignored on stable). */
  channel: Channel
  /** `profile`: set in the profile's patch file only, never through the panel. */
  scope: 'panel' | 'profile'
  /** Accepted and stored, not yet used by anything. */
  reserved?: boolean
  description: string
}

export const SETTINGS_TABLE: readonly SettingSpec[] = [
  { key: 'enabled', type: 'boolean', default: true, channel: 'stable', scope: 'profile', description: '`false` turns the host half off (the bar still loads but cannot reach it).' },
  { key: 'pythonPath', type: 'string', default: undefined, defaultText: "the Harness's bundled Python", channel: 'stable', scope: 'profile', description: 'A Python 3.10+ interpreter for the engine. On Windows there is no fallback to a bare `python`.' },
  { key: 'shorten', type: 'boolean', default: true, channel: 'stable', scope: 'panel', description: '`false` stops shortening but keeps `/tameru` (the strength menu\'s Off).' },
  { key: 'channel', type: 'enum', values: CHANNELS, default: 'stable', channel: 'stable', scope: 'panel', description: '`stable` always runs the incumbent behaviour (`every-step`, whatever `policy` says). `beta` honours `policy`; with no `policy` set it runs the unconfirmed round 1 candidate, `at-trigger` with no confidence gate (its holdout look failed gate 8).' },
  { key: 'policy', type: 'enum', values: POLICIES, default: 'every-step', defaultText: '`every-step` (`at-trigger` on beta when unset)', channel: 'beta', scope: 'panel', description: 'When to act (beta channel only). `every-step`: at every step boundary past `activation`, old results only, with the confidence gate. `at-trigger`: only where the Harness\'s own pruner is about to cut, the extract in place of its head/tail cut. `hybrid`: at the trigger, ordinary candidates, share rule beyond the stock cut. Measured in [docs/REPLAY-1.10.0.md](docs/REPLAY-1.10.0.md), replay only.' },
  { key: 'activation', type: 'number', min: 0.3, max: 0.95, default: 0.75, channel: 'stable', scope: 'panel', description: 'Start acting at this fraction of the Harness\'s own compaction trigger (`every-step` only; the trigger policies act at 1.0).' },
  { key: 'minConfidence', type: 'number', min: 0, max: 1, default: 0.7, defaultText: '`0.7` (`0` for `at-trigger` on beta when unset)', channel: 'stable', scope: 'panel', description: 'The engine must be at least this confident in an extract, or the result is left alone. Less, Normal and More set 0.85, 0.7 and 0.55; any other stored value shows as Custom and is kept as a hard minimum.' },
  { key: 'share', type: 'number', min: 0.1, max: 0.9, default: 0.35, channel: 'stable', scope: 'panel', description: 'A change must free at least this share of the tokens it makes the provider rewrite.' },
  { key: 'protectRecent', type: 'integer', min: 0, max: 100, default: 4, channel: 'stable', scope: 'panel', description: 'The newest read tool results always left as they are.' },
  { key: 'minResultChars', type: 'integer', min: 1000, max: 1_000_000, default: 6000, channel: 'stable', scope: 'panel', description: 'Results shorter than this are never touched.' },
  { key: 'maxPerPass', type: 'integer', min: 1, max: 100, default: 24, channel: 'stable', scope: 'panel', description: 'Most results shortened at one step boundary.' },
  { key: 'lambdaMultiplier', type: 'number', min: 0.001, max: 1000, default: 1, channel: 'beta', scope: 'panel', reserved: true, description: 'For the expected-value rule (risk appetite): accepted and stored, not used yet.' },
]

export const specOf = (key: string): SettingSpec | undefined => SETTINGS_TABLE.find(spec => spec.key === key)

/** The keys the panel may change, in table order. */
export const SETTING_KEYS = SETTINGS_TABLE.filter(spec => spec.scope === 'panel').map(spec => spec.key)

/** The built-in default of every panel key. */
export const SETTING_DEFAULTS: Readonly<Record<string, boolean | number | string>> = Object.fromEntries(
  SETTINGS_TABLE.filter(spec => spec.scope === 'panel' && spec.default !== undefined).map(spec => [spec.key, spec.default!]),
)

const numberDefault = (key: string): number => {
  const value = specOf(key)?.default
  if (typeof value !== 'number') throw new Error(`settings table: ${key} has no numeric default`)
  return value
}

/** The incumbent behaviour (the stable channel): every-step, gate 0.7, activation 0.75, share 0.35, protectRecent 4, 6000 chars, 24 per pass. */
export const INCUMBENT = {
  policy: 'every-step' as Policy,
  minConfidence: numberDefault('minConfidence'),
  activation: numberDefault('activation'),
  share: numberDefault('share'),
  protectRecent: numberDefault('protectRecent'),
  minResultChars: numberDefault('minResultChars'),
  maxPerPass: numberDefault('maxPerPass'),
}

/** What the beta channel runs when no `policy` is stored: the round 1 candidate (UNCONFIRMED: its one holdout look failed gate 8). */
export const BETA_DEFAULT = { policy: 'at-trigger' as Policy, triggerMinConfidence: 0 }

/** Off, or how sure the engine must be under `every-step`: the confidence gate for each strength. Normal is the stable default. */
export const STRENGTHS = [
  { id: 'off' },
  { id: 'less', minConfidence: 0.85 },
  { id: 'normal', minConfidence: INCUMBENT.minConfidence },
  { id: 'more', minConfidence: 0.55 },
] as const
export type StrengthId = (typeof STRENGTHS)[number]['id']
export type StrengthLabel = StrengthId | 'custom'

/**
 * The strength label for an effective setting: Off when shortening is off; Less, Normal or More when the policy is `every-step` and the
 * gate is that strength's; anything else is Custom (a stored gate is kept as a hard minimum, never rewritten).
 */
export function strengthFor(shorten: boolean, policy: Policy, gate: number): StrengthLabel {
  if (!shorten) return 'off'
  if (policy !== 'every-step') return 'custom'
  const match = STRENGTHS.find(strength => 'minConfidence' in strength && Math.abs(strength.minConfidence - gate) < 0.005)
  return match?.id ?? 'custom'
}

/** Accept one raw value for `key`, or undefined when it is of the wrong type or out of range. */
export function acceptValue(key: string, value: unknown): boolean | number | string | undefined {
  const spec = specOf(key)
  if (!spec) return undefined
  switch (spec.type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined
    case 'string':
      return typeof value === 'string' && value.length > 0 ? value : undefined
    case 'enum':
      return typeof value === 'string' && spec.values!.includes(value) ? value : undefined
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min! || value > spec.max!) return undefined
      return spec.type === 'integer' ? Math.floor(value) : value
    }
  }
}

const cell = (text: string): string => text.replace(/\|/g, '\\|')
const shown = (spec: SettingSpec): string => spec.defaultText ?? `\`${typeof spec.default === 'string' ? spec.default : JSON.stringify(spec.default)}\``
const rangeOf = (spec: SettingSpec): string =>
  spec.type === 'enum' ? spec.values!.map(v => `\`${v}\``).join(', ') : spec.type === 'number' || spec.type === 'integer' ? `${spec.min} to ${spec.max}${spec.type === 'integer' ? ' (whole)' : ''}` : spec.type

/** The README's settings table, generated from this file (README.md must contain exactly this text). */
export function settingsMarkdown(): string {
  const rows = SETTINGS_TABLE.map(spec =>
    `| \`${spec.key}\` | ${shown(spec)} | ${cell(rangeOf(spec))} | ${spec.channel === 'beta' ? 'beta' : 'both'}${spec.scope === 'profile' ? ', profile only' : ''} | ${spec.reserved ? '**Reserved.** ' : ''}${cell(spec.description)} |`)
  return ['| Setting | Default | Range | Channel | Meaning |', '|---|---|---|---|---|', ...rows].join('\n')
}
