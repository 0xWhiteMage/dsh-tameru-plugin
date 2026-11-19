// Simulated sessions for the whole-session replay: development families (the original generator plus two more) and the splits.
// A scenario is a task, a series of tool calls with their outputs, and the values the final answer needs, each present in exactly one
// output (the latest assignment of its key) among distractors and superseded values. Everything is generated from fixed seeds: no clock,
// no randomness outside `rng`. The fresh holdout lives in `holdout.ts` and is not importable from here.
import { createHash } from 'node:crypto'
import { rng } from './stats.ts'

export interface Step {
  tool: string
  args: Record<string, unknown>
  output: string
}

export interface Scenario {
  id: string
  family: string
  seed: number
  lang: 'en' | 'zh'
  style: 'specific' | 'vague'
  task: string
  steps: Step[]
  /** Values the final answer needs. */
  needed: string[]
}

export type Rand = () => number
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

// ---- a generic family -------------------------------------------------------------------------------------------------------------------

export interface FamilySpec {
  id: string
  /** Added to the index to make the scenario's seed. */
  base: number
  lang: 'en' | 'zh'
  steps: [number, number]
  /** Characters of an ordinary output, and the share of outputs that are small (1.5K to 5.5K, below every threshold). */
  size: [number, number]
  smallShare: number
  /** How a step's command looks (tool name and arguments). */
  call(i: number, r: Rand): { tool: string; args: Record<string, unknown> }
  /** Routine line generators; each output uses one of them throughout. */
  fill: Array<(n: number, r: Rand) => string>
  key(i: number, n: number): string
  value(i: number, r: Rand): string
  /** The line that holds a key's current value, a superseded one, and an unrelated line that looks the same. */
  fact(key: string, value: string, i: number): string
  stale(key: string, i: number): string
  noise(i: number, r: Rand): string
  task(style: 'specific' | 'vague', keys: string[], index: number): string
}

export function generate(spec: FamilySpec, index: number): Scenario {
  const seed = spec.base + index
  const r = rng(seed * 7919 + 13)
  const style: 'specific' | 'vague' = index % 2 === 0 ? 'specific' : 'vague'
  const nSteps = spec.steps[0] + Math.floor(r() * (spec.steps[1] - spec.steps[0] + 1))
  const nFacts = 3 + (index % 4)
  const keys = Array.from({ length: nFacts }, (_, i) => spec.key(i, seed))
  const values = keys.map((_, i) => spec.value(i, r))
  const where = new Map<number, string[]>()
  const place = (step: number, line: string): void => void where.set(step, [...(where.get(step) ?? []), line])
  keys.forEach((key, i) => {
    // one scenario in five has its facts in the last few steps (the pass never touches the newest results)
    const late = index % 5 === 4
    const latest = late ? nSteps - 4 + Math.floor(r() * 3) : 3 + Math.floor(r() * (nSteps - 9))
    place(latest, spec.fact(key, values[i]!, 100 + i))
    if (r() < 0.5 && latest > 3) place(Math.floor(r() * latest), spec.stale(key, i))
  })
  const steps: Step[] = Array.from({ length: nSteps }, (_, i) => {
    const small = r() < spec.smallShare
    const target = small ? 1500 + Math.floor(r() * 4000) : spec.size[0] + Math.floor(r() * (spec.size[1] - spec.size[0]))
    const fill = spec.fill[Math.floor(r() * spec.fill.length)]!
    const lines: string[] = []
    let size = 0
    while (size < target) {
      const line = fill(Math.floor(r() * 1e9), r)
      lines.push(line)
      size += line.length + 1
    }
    for (const bury of where.get(i) ?? []) lines.splice(Math.floor(r() * lines.length), 0, bury)
    if (r() < 0.5) lines.splice(Math.floor(r() * lines.length), 0, spec.noise(i, r))
    return { ...spec.call(i, r), output: lines.join('\n') }
  })
  return { id: `${spec.id}-${String(index).padStart(2, '0')}`, family: spec.id, seed, lang: spec.lang, style, task: spec.task(style, keys, index), steps, needed: values }
}

/** The canonical form of a scenario for hashing: everything a run reads. */
export const canonical = (s: Scenario): string => JSON.stringify([s.id, s.family, s.seed, s.lang, s.style, s.task, s.needed, s.steps.map(x => [x.tool, x.args, x.output])])

// ---- the original generator (kept as it was: its sessions are comparable with docs/results/replay-full.md) -------------------------

const WORDS = ['payment', 'checkout', 'inventory', 'session', 'billing', 'search', 'upload', 'gateway', 'router', 'cache']
const SETTINGS = ['timeout', 'retries', 'limit', 'pool', 'region', 'quota', 'window', 'backoff']

function routineLine(style: number, r: Rand): string {
  const n = Math.floor(r() * 1e9)
  if (style === 0) return `2026-11-13T10:${String(n % 60).padStart(2, '0')}:${String((n >> 8) % 60).padStart(2, '0')} INFO worker-${n % 7} processed batch ${(n >> 4) % 9000} in ${(n >> 12) % 400}ms (queue=${(n >> 3) % 50})`
  if (style === 1) return `[${String((n >> 6) % 100).padStart(3)}%] Building CXX object src/module_${n % 40}/file_${(n >> 5) % 90}.cpp.o`
  return `PASS tests/unit/${WORDS[n % WORDS.length]}_${(n >> 4) % 60}.test.ts (${(n >> 9) % 900} ms)`
}

export function legacyScenario(seed: number, style: 'specific' | 'vague', steps = 50): Scenario {
  const r = rng(seed * 7919 + 13)
  const keys = Array.from({ length: 5 }, (_, i) => `${WORDS[(seed + i * 3) % WORDS.length]}.${SETTINGS[(seed * 5 + i) % SETTINGS.length]}.zone_${i}`)
  const values = keys.map((_, i) => `v${(Math.floor(r() * 36 ** 5) + i).toString(36).padStart(5, 'q')}`)
  const where = new Map<number, string[]>()
  const place = (step: number, line: string): void => void where.set(step, [...(where.get(step) ?? []), line])
  keys.forEach((key, i) => {
    const latest = 4 + Math.floor(r() * (steps - 12))
    place(latest, `config: ${key} = ${values[i]} (set by deploy ${100 + i})`)
    if (r() < 0.5 && latest > 3) place(Math.floor(r() * latest), `config: ${key} = stale${i}x (superseded)`)
  })
  const out = Array.from({ length: steps }, (_, i) => {
    const target = 6000 + Math.floor(r() * 24_000)
    const fill = Math.floor(r() * 3)
    const lines: string[] = []
    let size = 0
    while (size < target) {
      const line = routineLine(fill, r)
      lines.push(line)
      size += line.length + 1
    }
    for (const bury of where.get(i) ?? []) lines.splice(Math.floor(r() * lines.length), 0, bury)
    if (r() < 0.5) lines.splice(Math.floor(r() * lines.length), 0, `config: ${WORDS[Math.floor(r() * 10)]}.${SETTINGS[Math.floor(r() * 8)]}.other_${i} = n${i} (unrelated)`)
    return { tool: 'bash', args: { command: `make test -k suite_${i}` }, output: lines.join('\n') }
  })
  const task = style === 'specific' ? `Find the current values of ${keys.join(', ')} and report them.` : 'Review the recent test output and report anything that explains the checkout failures.'
  return { id: `legacy-${String(seed).padStart(2, '0')}`, family: 'legacy', seed, lang: 'en', style, task, steps: out, needed: values }
}

// ---- two more development families ---------------------------------------------------------------------------------------------------

const hex = (r: Rand, width = 8): string => Array.from({ length: width }, () => Math.floor(r() * 16).toString(16)).join('')

export const GRADLE: FamilySpec = {
  id: 'gradle',
  base: 3100,
  lang: 'en',
  steps: [44, 56],
  size: [7000, 24_000],
  smallShare: 0.2,
  call: i => ({ tool: 'gradle', args: { task: i % 3 === 0 ? ':app:test' : i % 3 === 1 ? ':core:build' : ':api:check', flags: '--info' } }),
  fill: [
    (n, r) => `> Task :module${n % 30}:compileJava${r() < 0.4 ? ' UP-TO-DATE' : ''}`,
    n => `[ant:checkstyle] [WARN] /src/main/java/com/acme/m${n % 40}/Service${(n >> 5) % 90}.java:${(n >> 9) % 700}:${(n >> 3) % 80}: Line is longer than 120 characters.`,
    n => `    ${(n >> 7) % 400} tests completed, ${n % 3} skipped in suite ${WORDS[n % WORDS.length]}Suite${(n >> 4) % 50}`,
  ],
  key: (i, n) => `ext.${['db', 'cache', 'queue', 'mail', 'auth', 'cdn'][(n + i) % 6]}Setting${i}`,
  value: (_i, r) => hex(r),
  fact: (key, value, i) => `> Configure project :app  ${key} = '${value}' (gradle.properties line ${i})`,
  stale: key => `> Configure project :legacy  ${key} = 'deadbeef' (overridden)`,
  noise: i => `> Configure project :tools  ext.unrelated${i} = 'cafe${i}' (unused)`,
  task: (style, keys) => (style === 'specific' ? `Report the value each of these Gradle properties ends up with: ${keys.join(', ')}.` : 'Look through the build output and report what is making the build unstable.'),
}

export const ANSIBLE: FamilySpec = {
  id: 'ansible',
  base: 3200,
  lang: 'zh',
  steps: [42, 54],
  size: [7000, 22_000],
  smallShare: 0.15,
  call: (i, r) => ({ tool: 'ansible_playbook', args: { playbook: `site_${i % 4}.yml`, limit: `web-${Math.floor(r() * 30)}` } }),
  fill: [
    (n, r) => `ok: [web-${n % 40}] => (item=pkg${(n >> 6) % 120})${r() < 0.3 ? ' 已是最新版本' : ''}`,
    n => `TASK [common : 安装依赖 ${(n >> 3) % 90}] ${'*'.repeat(30 + (n % 20))}`,
    n => `changed: [db-${n % 12}] => {"changed": true, "msg": "已更新 ${(n >> 5) % 500} 个文件", "rc": 0}`,
  ],
  key: (i, n) => `${['nginx', 'redis', 'kafka', 'mysql', 'etcd', 'consul'][(n + i) % 6]}_${['port', 'maxmem', 'replicas', 'workers', 'ttl', 'timeout'][(n * 3 + i) % 6]}`,
  value: (i, r) => `${10 + Math.floor(r() * 9000)}${['ms', 'mb', 'x', 's'][i % 4]}`,
  fact: (key, value, i) => `ok: [web-${i % 9}] => {"msg": "${key} = ${value}"}`,
  stale: key => `ok: [web-0] => {"msg": "${key} = 0 (默认值)"}`,
  noise: i => `ok: [web-1] => {"msg": "unrelated_flag_${i} = ${i * 7}"}`,
  task: (style, keys) => (style === 'specific' ? `请找出 ${keys.join('、')} 当前的取值并汇报。` : '回顾最近的部署输出，说明服务不稳定的原因并汇报。'),
}

// ---- the development pool and its splits ----------------------------------------------------------------------------------------------

export type Split = 'dev' | 'validation'

/**
 * 60% / 40% by a hash of the scenario id: within each family the ids are ordered by the hash of their id and the first 60% (rounded)
 * are development, the rest validation, so every family is in both and the split is exact. It depends only on the ids.
 */
let splitCache: Map<string, Split> | undefined
export function splitOf(id: string): Split {
  if (!splitCache) {
    splitCache = new Map()
    const byFamily = new Map<string, string[]>()
    for (const s of developmentPool()) byFamily.set(s.family, [...(byFamily.get(s.family) ?? []), s.id])
    for (const ids of byFamily.values()) {
      const ordered = [...ids].sort((a, b) => (sha256(`split:${a}`) < sha256(`split:${b}`) ? -1 : 1))
      const dev = Math.round(ids.length * 0.6)
      ordered.forEach((id, i) => splitCache!.set(id, i < dev ? 'dev' : 'validation'))
    }
  }
  const found = splitCache.get(id)
  if (!found) throw new Error(`unknown development scenario ${id}`)
  return found
}

const LEGACY_COUNT = 40
const FAMILY_COUNT = 10

/** The 60 development scenarios: the original generator (40 seeds, the query style alternating by seed) and two more families (10 each). */
export function developmentPool(): Scenario[] {
  const out: Scenario[] = []
  for (let seed = 1; seed <= LEGACY_COUNT; seed++) out.push(legacyScenario(seed, seed % 2 === 1 ? 'specific' : 'vague'))
  for (const spec of [GRADLE, ANSIBLE]) for (let i = 0; i < FAMILY_COUNT; i++) out.push(generate(spec, i))
  return out
}

export function scenariosFor(split: Split): Scenario[] {
  return developmentPool().filter(s => splitOf(s.id) === split)
}
