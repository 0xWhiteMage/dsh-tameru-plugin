// Post-hoc pricing of replay rows under any dated price profile (round 2, P1b). REPLAY ONLY: every figure here is a simulation.
//
// A row records the token quantities pricing needs (`requests`: per model request the cached prefix it shares with the previous
// request, its whole prompt, and the idle gap before it; `summary_requests`: the compaction requests and the context each re-read;
// `summary_output_tokens`), so cost under ANY profile is a pure function of the row:
//
//   cost = r · read + w · written + o · output        (in miss-units: one uncached input token = 1)
//
// - TTL: a request after an idle gap longer than the TTL finds nothing cached; its whole prompt is written again (the first request of
//   that step: the compaction request if there is one, else the step's request). The DeepSeek profiles have no fixed TTL (best effort),
//   so their primary is no expiry and 5 min / 1 h are sensitivities. Every profile is treated as "alive while requests keep coming at
//   intervals <= TTL" (refresh on use), which is the documented Anthropic 5-minute rule and an assumption for the others.
// - Prefix units: a request that shares the WHOLE previous prompt hits all of it (units form at request boundaries); a request that
//   diverges earlier hits only whole units of the shared prefix, `floor(cached / unit) · unit`. The unit is a parameter, default 64
//   tokens, ASSUMED AND UNVERIFIED (DeepSeek does not state its interval; Anthropic breakpoints and OpenAI increments are modelled by the
//   same rule). The shared prefix is measured at message boundaries, so a hit never extends into the edited message.
// - Long-context tiers: a request whose prompt is above a tier's `above_prompt_tokens` pays the tier multiplier on its input side (read
//   and write); on output too when the tier says "every price" (Anthropic Haiku 5.5 above 100K; OpenAI GPT-5.4 2x above 272K is input only).
// - A profile with no output price (generic OpenAI) prices output at o = 5, stated as an assumption (round-2 analysis plan, section 4).
//
// The profiles are read from the engine's `prices.json`: from REPLAY_PRICES when set, otherwise the committed copy
// `docs/results/prices-2026-11-19.json`, whose sha256 a test pins to the engine file.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const PRICES_COPY = join(here, '..', '..', 'docs', 'results', 'prices-2026-11-19.json')
/** sha256 of the engine's src/tameru/prices.json at commit 7a7bb83 (LF line endings), the same value the engine's test pins. */
export const PRICES_SHA256 = '070dcfa3551e875c310334781f534346817c3d73008299d872a432c17543faa0'
export const DEFAULT_UNIT_TOKENS = 64
export const OUTPUT_FALLBACK = 5

export interface Tier {
  above_prompt_tokens: number
  multiplier: number
  applies_to: string
}

export interface PriceProfile {
  name: string
  provider: string
  date: string
  r: number
  w: number
  o: number | null
  ttl_s: number | null
  tiers: Tier[]
}

export const pricesPath = (): string => process.env.REPLAY_PRICES ?? PRICES_COPY
export const sha256Lf = (text: string): string => createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex')

let cache: { path: string; profiles: Map<string, PriceProfile> } | undefined

/** Every profile in the prices file, by name. */
export function loadProfiles(path = pricesPath()): Map<string, PriceProfile> {
  if (cache?.path === path) return cache.profiles
  const data = JSON.parse(readFileSync(path, 'utf8')) as { profiles: Record<string, any> }
  const profiles = new Map<string, PriceProfile>()
  for (const [name, raw] of Object.entries(data.profiles)) {
    const r = Number(raw.relative.r)
    const w = Number(raw.relative.w)
    if (!(r > 0 && r <= w)) throw new Error(`price profile ${name}: need 0 < r <= w`)
    profiles.set(name, {
      name,
      provider: String(raw.provider),
      date: String(raw.date),
      r,
      w,
      o: raw.relative.o == null ? null : Number(raw.relative.o),
      ttl_s: raw.ttl_s == null ? null : Number(raw.ttl_s),
      tiers: (raw.tiers ?? []).map((t: any) => ({ above_prompt_tokens: Number(t.above_prompt_tokens), multiplier: Number(t.multiplier), applies_to: String(t.applies_to ?? '') })),
    })
  }
  cache = { path, profiles }
  return profiles
}

export function profile(name: string): PriceProfile {
  const p = loadProfiles().get(name)
  if (!p) throw new Error(`unknown price profile ${name}`)
  return p
}

/** The pricing the replay used before P1b, as a profile: read 0.1, write 1.0, summary output 4, no expiry, no units, no tiers. */
export const LEGACY: PriceProfile = { name: 'legacy-r0.1-w1.0', provider: 'replay', date: '2026-11-18', r: 0.1, w: 1.0, o: 4, ttl_s: null, tiers: [] }
export const LEGACY_W125: PriceProfile = { ...LEGACY, name: 'legacy-r0.1-w1.25', w: 1.25 }

/** One way of pricing: a profile plus the TTL rule and the prefix unit. */
export interface PriceConfig {
  /** Shown in tables. */
  label: string
  profile: PriceProfile
  /** `profile`: the profile's own TTL (none for DeepSeek); `none`: never expires; a number: that TTL in seconds (a sensitivity). */
  ttl: 'profile' | 'none' | number
  unitTokens: number
}

export const config = (name: string | PriceProfile, ttl: PriceConfig['ttl'] = 'profile', unitTokens = DEFAULT_UNIT_TOKENS, label?: string): PriceConfig => {
  const p = typeof name === 'string' ? profile(name) : name
  const suffix = ttl === 'profile' ? '' : ttl === 'none' ? ' (no expiry)' : ` (TTL ${ttl >= 3600 ? `${ttl / 3600} h` : `${ttl / 60} min`})`
  return { label: label ?? `${p.name}${suffix}${unitTokens === DEFAULT_UNIT_TOKENS ? '' : ` (unit ${unitTokens})`}`, profile: p, ttl, unitTokens }
}

/** What one priced session cost, split by kind, in miss-units. */
export interface Breakdown {
  read: number
  write: number
  output: number
  total: number
  /** Requests whose cache had expired (after an idle gap longer than the TTL). */
  expiries: number
}

/** The quantities a row must carry to be priced. */
export interface Usage {
  /** Per model request: [cached shared prefix tokens, whole prompt tokens, idle seconds since the previous request]. */
  requests: Array<[number, number, number]>
  /** Per compaction request: [step index, context tokens it re-read]. */
  summary_requests: Array<[number, number]>
  summary_output_tokens: number
}

const tierFor = (p: PriceProfile, promptTokens: number): { input: number; output: number } => {
  let input = 1
  let output = 1
  for (const t of p.tiers) {
    if (promptTokens > t.above_prompt_tokens) {
      input = t.multiplier
      output = /every price/i.test(t.applies_to) ? t.multiplier : 1
    }
  }
  return { input, output }
}

export const ttlOf = (c: PriceConfig): number | null => (c.ttl === 'none' ? null : c.ttl === 'profile' ? c.profile.ttl_s : c.ttl)

/** Price one session. Pure: the same usage and config always give the same numbers. */
export function price(u: Usage, c: PriceConfig): Breakdown {
  const p = c.profile
  const o = p.o ?? OUTPUT_FALLBACK
  const ttl = ttlOf(c)
  const unit = Math.max(1, Math.floor(c.unitTokens))
  const byStep = new Map<number, number[]>()
  for (const [step, tokens] of u.summary_requests) byStep.set(step, [...(byStep.get(step) ?? []), tokens])
  let read = 0
  let write = 0
  let output = 0
  let expiries = 0
  u.requests.forEach(([cached, all, gap], k) => {
    let cold = k > 0 && ttl !== null && gap > ttl
    if (cold) expiries++
    for (const replay of byStep.get(k) ?? []) {
      const m = tierFor(p, replay)
      if (cold) {
        write += p.w * replay * m.input
        cold = false // the compaction request wrote the prefix again; the step's own request finds it
      } else {
        read += p.r * replay * m.input
      }
      output += o * u.summary_output_tokens * m.output
    }
    const previous = k > 0 ? u.requests[k - 1]![1] : 0
    let hit = k === 0 ? 0 : cached >= previous ? cached : Math.floor(cached / unit) * unit
    if (cold) hit = 0
    const m = tierFor(p, all)
    read += p.r * hit * m.input
    write += p.w * (all - hit) * m.input
  })
  return { read, write, output, total: read + write + output, expiries }
}

// ---- the registered weights and the sensitivities (engine docs/ANALYSIS-PLAN-ROUND2.md, section 4) ---------------------------------

/** The DeepSeek plugin's registered profiles, 1/4 each. */
export const REGISTERED = ['deepseek-v4-pro', 'deepseek-flash', 'anthropic-sonnet-5.5-5m', 'openai-generic-30m'] as const

export const registeredConfigs = (): PriceConfig[] => REGISTERED.map(n => config(n))

/** Every sensitivity: the DeepSeek TTL variants, every other profile, the registered ones without expiry, and the old pricing. */
export function sensitivityConfigs(): PriceConfig[] {
  const out: PriceConfig[] = []
  for (const n of ['deepseek-v4-pro', 'deepseek-flash']) out.push(config(n, 300), config(n, 3600), config(n, 'profile', 1024))
  for (const n of ['anthropic-sonnet-5.5-5m', 'openai-generic-30m']) out.push(config(n, 'none'))
  for (const n of loadProfiles().keys()) if (!(REGISTERED as readonly string[]).includes(n)) out.push(config(n))
  out.push(config(LEGACY, 'none', 1, 'legacy (read 0.1, write 1.0, output 4)'), config(LEGACY_W125, 'none', 1, 'legacy (read 0.1, write 1.25, output 4)'))
  return out
}

// ---- idle gaps ------------------------------------------------------------------------------------------------------------------------

/**
 * The idle seconds before each request of a scenario. ASSUMED, NOT LOGGED FROM REAL SESSIONS: the simulated sessions have no clock, so a
 * seeded model stands in (think and tool time 4 s plus an exponential with mean 20 s; with probability 0.03 per step the user is away
 * for a log-uniform 2 min to 3 h). It depends only on the scenario's seed and the step, never on the arm, so arms stay paired.
 */
export function idleGaps(seed: number, steps: number, random: (seed: number) => () => number): number[] {
  const r = random(seed * 104_729 + 7)
  const out: number[] = []
  for (let k = 0; k < steps; k++) {
    const busy = 4 + -Math.log(1 - r()) * 20
    const away = r() < 0.03 ? Math.exp(Math.log(120) + r() * (Math.log(10_800) - Math.log(120))) : 0
    out.push(k === 0 ? 0 : Math.round((busy + away) * 10) / 10)
  }
  return out
}
