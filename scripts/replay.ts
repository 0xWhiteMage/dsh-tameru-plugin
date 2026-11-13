// Whole-session comparison: stock Harness behaviour against stock plus Tameru, on identical simulated sessions.
//
//   node scripts/replay.ts [--seeds 10] [--steps 50] [--json out.json]
//
// REAL parts: the Harness's session log, token meter and tool-result pruner (extracted into dev/harness), the plugin's own shortening
// pass (`onPreStep`), and the Tameru engine through the worker. SIMULATED parts: the model (it only produces tool calls), and the
// Harness's summary compaction, which is replaced by a fixed-size summary that keeps NO facts (the worst case for both arms alike).
// Prices are in input-token equivalents. Cache reads cost R and rewritten or new tokens cost W; the primary pricing is DeepSeek-like
// (R=0.1, W=1.0: cached input is discounted, there is no write premium) and R=0.1/W=1.25 is shown as a sensitivity.
// Output tokens are not priced except the summary a compaction writes (4x), because the model's replies are identical in both arms.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EngineClient } from '../src/host/engine-client.ts'
import { nodeWorkerSpawn } from '../src/host/process.ts'
import { readSurface } from '../src/host/shorten.ts'
import { onPreStep, type ChatStats, type StepAgent, type StepDeps, type TameruSettings } from '../src/host/step.ts'
import { stockThreshold } from '../src/host/stock.ts'
import { root, world } from '../test/helpers/harness.ts'

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}
const SEEDS = arg('seeds', 10)
const STEPS = arg('steps', 50)
const OUTPUT_CAP = 8000
const OVERHEAD_TOKENS = 4000 // system prompt and tool schemas, identical in both arms and always cached after the first request
const SUMMARY_TOKENS = 2000
const SUMMARY_OUTPUT_WEIGHT = 4
const python = process.env.TAMERU_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')

// ---- scenario -------------------------------------------------------------------------------------------------------------------

type QueryStyle = 'specific' | 'vague'
interface Scenario {
  seed: number
  task: string
  steps: Array<{ command: string; output: string }>
  /** Values the final answer needs, each present in exactly one tool output (the latest assignment of its key). */
  needed: string[]
}

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = ['payment', 'checkout', 'inventory', 'session', 'billing', 'search', 'upload', 'gateway', 'router', 'cache']
const SETTINGS = ['timeout', 'retries', 'limit', 'pool', 'region', 'quota', 'window', 'backoff']

function routineLine(style: number, r: () => number): string {
  const n = Math.floor(r() * 1e9)
  if (style === 0) return `2026-11-13T10:${String(n % 60).padStart(2, '0')}:${String((n >> 8) % 60).padStart(2, '0')} INFO worker-${n % 7} processed batch ${(n >> 4) % 9000} in ${(n >> 12) % 400}ms (queue=${(n >> 3) % 50})`
  if (style === 1) return `[${String((n >> 6) % 100).padStart(3)}%] Building CXX object src/module_${n % 40}/file_${(n >> 5) % 90}.cpp.o`
  return `PASS tests/unit/${WORDS[n % WORDS.length]}_${(n >> 4) % 60}.test.ts (${(n >> 9) % 900} ms)`
}

function makeScenario(seed: number, style: QueryStyle): Scenario {
  const r = rng(seed * 7919 + 13)
  const keys = Array.from({ length: 5 }, (_, i) => `${WORDS[(seed + i * 3) % WORDS.length]}.${SETTINGS[(seed * 5 + i) % SETTINGS.length]}.zone_${i}`)
  const values = keys.map((_, i) => `v${(Math.floor(r() * 36 ** 5) + i).toString(36).padStart(5, 'q')}`)
  const where = new Map<number, string[]>() // step index -> lines to bury in that output
  const place = (step: number, line: string): void => void where.set(step, [...(where.get(step) ?? []), line])
  keys.forEach((key, i) => {
    const latest = 4 + Math.floor(r() * (STEPS - 12))
    place(latest, `config: ${key} = ${values[i]} (set by deploy ${100 + i})`)
    if (r() < 0.5 && latest > 3) place(Math.floor(r() * latest), `config: ${key} = stale${i}x (superseded)`)
  })
  const steps = Array.from({ length: STEPS }, (_, i) => {
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
    return { command: `make test -k suite_${i}`, output: lines.join('\n') }
  })
  const task = style === 'specific' ? `Find the current values of ${keys.join(', ')} and report them.` : 'Review the recent test output and report anything that explains the checkout failures.'
  return { seed, task, steps, needed: values }
}

// ---- one run --------------------------------------------------------------------------------------------------------------------

interface Run {
  /** (cached, total) prompt tokens per model request. */
  requests: Array<[number, number]>
  /** Prompt tokens a compaction replayed (read from cache) when it wrote its summary. */
  summaries: number[]
  compactions: number
  shortened: number
  passMs: number[]
  factsHeld: number
  needed: number
  finalTokens: number
  /** Why the Tameru pass did nothing, counted over the session's steps. */
  skips: Record<string, number>
}

const hash = (m: unknown): string => createHash('sha1').update(JSON.stringify(m)).digest('hex')

/** The arms compared: stock, and Tameru with the shipped settings and with the confidence gate lowered or removed. */
const ARMS: Record<string, TameruSettings | undefined> = { stock: undefined, tameru: {}, 'tameru gate 0.5': { minConfidence: 0.5 }, 'tameru no gate': { minConfidence: 0 } }

async function runArm(arm: string, sc: Scenario, window: number, client: EngineClient): Promise<Run> {
  const w = await world(sc.task)
  w.header(OUTPUT_CAP)
  const threshold = stockThreshold({ contextWindow: window, reservedCompletionTokens: OUTPUT_CAP })!
  const retain = Math.floor((window - OUTPUT_CAP) * 0.16)
  const stats = new WeakMap<object, ChatStats>()
  const deps: StepDeps = {
    client,
    meter: () => w.meter,
    resolveModelInfo: async () => ({ context: { contextWindow: window }, defaultMaxTokens: OUTPUT_CAP }),
    backendFor: () => ({ config: { auto: true } }),
    settings: ARMS[arm] ?? {},
    stats,
  }
  const agent = { session: w.session } as unknown as StepAgent
  const run: Run = { requests: [], summaries: [], compactions: 0, shortened: 0, passMs: [], factsHeld: 0, needed: sc.needed.length, finalTokens: 0, skips: {} }
  let previous: Array<{ key: string; tokens: number }> = []
  const tokens = (m: any): number => w.meter.estimateMessage(m)
  const total = (): number => w.meter.measure(w.session, w.session.requestHeader()).totalTokens

  const compact = (): boolean => {
    const entries = readSurface(w.session)
    let sum = 0
    let tail = entries.length
    while (tail > 1 && sum < retain) sum += tokens(entries[--tail]!.message)
    while (tail < entries.length && entries[tail]!.message.role !== 'assistant') tail++
    if (tail <= 2 || tail >= entries.length) return false
    const range = entries.slice(1, tail).map(e => e.seq)
    run.summaries.push(OVERHEAD_TOKENS + entries.reduce((s, e) => s + tokens(e.message), 0))
    const text = `Summary of earlier work. Task: ${sc.task} ${'The agent ran test suites and reviewed their output; routine progress was made. '.repeat(Math.ceil((SUMMARY_TOKENS * 3.5) / 80))}`.slice(0, SUMMARY_TOKENS * 3.5)
    w.session.append('user/message', { id: `sum${run.compactions}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: { op: 'replace', startSeq: range[0]!, endSeq: range.at(-1)! }, sourceEventSeqs: range })
    run.compactions++
    return true
  }

  for (const [i, step] of sc.steps.entries()) {
    w.step({ name: 'bash', args: { command: step.command } }, step.output)
    if (ARMS[arm] !== undefined) {
      const started = performance.now()
      const outcome = await onPreStep(deps, agent)
      run.passMs.push(performance.now() - started)
      if (outcome.kind === 'applied') run.shortened += outcome.applied.length
      else run.skips[outcome.reason] = (run.skips[outcome.reason] ?? 0) + 1
    }
    if (total() >= threshold) {
      ;(w.ctx as any).toolResultPruner.pruneSession(w.session) // the Harness's own pruner, as its backend calls it at pressure
      for (let guard = 0; guard < 3 && total() >= threshold; guard++) if (!compact()) break
    }
    // the model request: price it against what the previous request left in the provider's cache
    const messages = w.session.deriveMessages()
    const entries = messages.map((m: any) => ({ key: hash(m), tokens: tokens(m) }))
    const all = OVERHEAD_TOKENS + entries.reduce((s: number, e: any) => s + e.tokens, 0)
    let cached = i === 0 ? 0 : OVERHEAD_TOKENS
    if (i > 0) for (let k = 0; k < Math.min(previous.length, entries.length) && previous[k]!.key === entries[k]!.key; k++) cached += entries[k]!.tokens
    run.requests.push([cached, all])
    previous = entries
  }
  const finalText = w.session.deriveMessages().map((m: any) => JSON.stringify(m.content)).join('\n')
  run.factsHeld = sc.needed.filter(v => finalText.includes(v)).length
  run.finalTokens = total()
  await w.ctx.fiber.dispose()
  return run
}

// ---- pricing and statistics ------------------------------------------------------------------------------------------------------

interface Pricing {
  name: string
  read: number
  write: number
}
const PRICINGS: Pricing[] = [
  { name: 'DeepSeek-like (read 0.1, write 1.0)', read: 0.1, write: 1.0 },
  { name: 'write premium (read 0.1, write 1.25)', read: 0.1, write: 1.25 },
]
const cost = (run: Run, p: Pricing): number =>
  run.requests.reduce((s, [cached, all]) => s + p.read * cached + p.write * (all - cached), 0) + run.summaries.reduce((s, replay) => s + p.read * replay + SUMMARY_TOKENS * SUMMARY_OUTPUT_WEIGHT, 0)

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
function bootstrap(xs: number[], draws = 4000): [number, number] {
  const r = rng(99)
  const means = Array.from({ length: draws }, () => mean(xs.map(() => xs[Math.floor(r() * xs.length)]!))).sort((a, b) => a - b)
  return [means[Math.floor(draws * 0.025)]!, means[Math.floor(draws * 0.975)]!]
}
const pct = (x: number): string => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}%`

interface Cell {
  window: number
  style: QueryStyle
  seed: number
  runs: Record<string, Run>
}

async function main(): Promise<void> {
  const client = new EngineClient(nodeWorkerSpawn(python, join(root, 'vendor', 'run_worker.py'), root), { timeoutMs: 60_000 })
  const results: Cell[] = []
  try {
    for (const window of [128_000, 200_000]) {
      for (const style of ['specific', 'vague'] as QueryStyle[]) {
        for (let seed = 1; seed <= SEEDS; seed++) {
          const sc = makeScenario(seed, style)
          const runs: Record<string, Run> = {}
          for (const arm of Object.keys(ARMS)) runs[arm] = await runArm(arm, sc, window, client)
          results.push({ window, style, seed, runs })
          process.stderr.write('.')
        }
      }
    }
  } finally {
    await client.dispose()
  }
  process.stderr.write('\n')
  const groups: Array<[string, Cell[]]> = []
  for (const window of [128_000, 200_000]) for (const style of ['specific', 'vague'] as QueryStyle[]) groups.push([`${window / 1000}K | ${style}`, results.filter(r => r.window === window && r.style === style)])
  groups.push(['all | all', results])
  for (const pricing of PRICINGS) {
    console.log(`
## ${pricing.name}
`)
    console.log('Cost is in input-token equivalents; "change" is Tameru against stock on the same session (negative is cheaper), mean over sessions with a 95% bootstrap interval.\n')
    console.log('| window | query | arm | n | mean cost | change vs stock | 95% interval | compactions | facts held | shortened/session | ms per step |')
    console.log('|---|---|---|--:|--:|--:|--|--:|--:|--:|--:|')
    for (const [label, rows] of groups) {
      for (const arm of Object.keys(ARMS)) {
        const ratios = rows.map(r => cost(r.runs[arm]!, pricing) / cost(r.runs.stock!, pricing) - 1)
        const [lo, hi] = bootstrap(ratios)
        const runs = rows.map(r => r.runs[arm]!)
        const change = arm === 'stock' ? '' : pct(mean(ratios))
        const interval = arm === 'stock' ? '' : `${pct(lo)} to ${pct(hi)}`
        console.log(
          `| ${label} | ${arm} | ${rows.length} | ${Math.round(mean(runs.map(r => cost(r, pricing)))).toLocaleString('en-US')} | ${change} | ${interval} | ${mean(runs.map(r => r.compactions)).toFixed(1)} | ${mean(runs.map(r => r.factsHeld)).toFixed(2)} of ${runs[0]!.needed} | ${arm === 'stock' ? '' : mean(runs.map(r => r.shortened)).toFixed(1)} | ${arm === 'stock' ? '' : mean(runs.flatMap(r => r.passMs)).toFixed(0)} |`,
        )
      }
    }
  }
  const skips: Record<string, Record<string, number>> = {}
  for (const r of results) for (const arm of Object.keys(ARMS)) for (const [k, v] of Object.entries(r.runs[arm]!.skips)) (skips[arm] ??= {})[k] = ((skips[arm] ??= {})[k] ?? 0) + v
  console.log(`
Why the pass did nothing at a step (all sessions): ${JSON.stringify(skips)}`)
  const out = process.argv.indexOf('--json')
  if (out >= 0 && process.argv[out + 1]) writeFileSync(process.argv[out + 1]!, JSON.stringify(results, null, 1))
}

await main()
