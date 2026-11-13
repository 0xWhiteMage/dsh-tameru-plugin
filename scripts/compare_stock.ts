// Compare the Harness's stock tool-result pruner with Tameru on the same outputs.
//
//   node scripts/compare_stock.ts [--json out.json]
//
// Each of the engine's task cases (a question, its evidence, required strings) is embedded at the head, middle or tail of a larger
// routine log. Stock: the real `ToolResultPruner.pruneContent` from dev/harness (head 4096 + marker + tail 1024 above 8192 characters).
// Tameru: the real engine through the worker, with the same settings the plugin uses. Two query styles: the exact question, and only
// a generic task statement (what a host has when the user's message does not name the needle).
//
// What this does NOT measure: cost over a whole session (prompt-cache effects), whether a model finds the answer, or logs whose
// filler is not as routine as this. It measures, per output, how much is removed and whether the required facts survive.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EngineClient } from '../src/host/engine-client.ts'
import { nodeWorkerSpawn } from '../src/host/process.ts'
import { shortenedText } from '../src/host/shorten.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const modules = join(root, 'dev', 'harness', 'node_modules')
const python = process.env.TAMERU_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')

interface Case {
  name: string
  text: string
  query: string
  required: string[]
  forbidden: string[]
}

type Where = 'head' | 'middle' | 'tail'
type QueryStyle = 'question' | 'task'

const GENERIC_TASK = 'Investigate why the build is failing and report the root cause.'

const HELD_OUT = process.argv.includes('--heldout')

/** A deterministic routine log: the kind of filler a long command prints. The held-out set uses compiler output instead. */
function filler(chars: number, seed: number): string {
  if (HELD_OUT) return compilerFiller(chars, seed)
  let state = seed >>> 0
  const next = (): number => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
  const lines: string[] = []
  let size = 0
  while (size < chars) {
    const n = next()
    const line = `2026-11-13T10:${String(n % 60).padStart(2, '0')}:${String((n >> 8) % 60).padStart(2, '0')} INFO worker-${n % 7} processed batch ${(n >> 4) % 9000} in ${(n >> 12) % 400}ms (queue=${(n >> 3) % 50})`
    lines.push(line)
    size += line.length + 1
  }
  return lines.join('\n')
}

function compilerFiller(chars: number, seed: number): string {
  let state = (seed * 7 + 12345) >>> 0
  const next = (): number => (state = (Math.imul(state, 22695477) + 1) >>> 0)
  const lines: string[] = []
  let size = 0
  while (size < chars) {
    const n = next()
    const line =
      n % 11 === 0
        ? `src/module_${n % 40}/file_${(n >> 5) % 90}.cpp:${(n >> 9) % 800}: note: candidate template ignored: deduced conflicting types`
        : `[${String((n >> 6) % 100).padStart(3)}%] Building CXX object src/module_${n % 40}/file_${(n >> 5) % 90}.cpp.o`
    lines.push(line)
    size += line.length + 1
  }
  return lines.join('\n')
}

function embed(core: string, where: Where, total: number, seed: number): string {
  const rest = Math.max(0, total - core.length)
  const before = where === 'head' ? 0 : where === 'middle' ? Math.floor(rest / 2) : rest
  return [before > 0 ? filler(before, seed) : '', core, rest - before > 0 ? filler(rest - before, seed + 1) : ''].filter(Boolean).join('\n')
}

async function stockPruner(): Promise<(text: string) => string> {
  const mod = await import(pathToFileURL(join(modules, '@deepseek-ai', 'dsh-compaction-tool-result-pruner', 'lib', 'index.js')).href)
  const self = Object.create(mod.ToolResultPruner.prototype)
  self.config = mod.resolveConfig({})
  return text => {
    const pruned = self.pruneContent([{ type: 'text', text }])
    return pruned === null ? text : pruned.map((block: { text: string }) => block.text).join('')
  }
}

interface Arm {
  kept: boolean
  savings: number
  touched: boolean
  /** The engine's own rating of this result, when it gave one. */
  risk?: string | null
  confidence?: number | null
}

interface Row {
  case: string
  where: Where
  size: number
  query: QueryStyle
  stock: Arm
  tameru: Arm
  /** Extra Tameru arms (engine options), by name. */
  extra: Record<string, Arm>
}

/** Engine option sets tried besides the plugin's default. `pinRecent` always keeps the first block and the newest N. */
const VARIANTS: Record<string, { pinRecent?: number }> = { 'pin 1': { pinRecent: 1 }, 'pin 3': { pinRecent: 3 } }

const keeps = (text: string, c: Case): boolean => c.required.every(needle => text.includes(needle))
const savings = (before: string, after: string): number => (before.length === 0 ? 0 : 1 - after.length / before.length)

async function main(): Promise<void> {
  const cases: Case[] = JSON.parse(readFileSync(join(root, 'test', 'fixtures', 'engine-cases.json'), 'utf8')).cases.filter((c: Case) => c.required.length > 0)
  const stock = await stockPruner()
  const client = new EngineClient(nodeWorkerSpawn(python, join(root, 'vendor', 'run_worker.py'), root), { timeoutMs: 60_000 })
  const rows: Row[] = []
  try {
    for (const size of [12_000, 40_000]) {
      for (const [index, c] of cases.entries()) {
        for (const where of ['head', 'middle', 'tail'] as Where[]) {
          const text = embed(c.text, where, Math.max(size, c.text.length + 2000), index * 31 + size + (HELD_OUT ? 99_991 : 0))
          const stockAfter = stock(text)
          for (const style of ['question', 'task'] as QueryStyle[]) {
            const query = style === 'question' ? c.query : GENERIC_TASK
            const run = async (extra: { pinRecent?: number }): Promise<Arm> => {
              const result = await client.compress({ text, query, minSavingsRatio: 0.25, ...extra })
              const touched = !!result && !result.failOpen && result.text.length < text.length && !result.sanitized
              const after = touched ? shortenedText(text, result!.text) : text
              return { kept: keeps(after, c), savings: savings(text, after), touched, risk: result?.risk ?? null, confidence: result?.confidence ?? null }
            }
            const extra: Record<string, Arm> = {}
            for (const [name, options] of Object.entries(VARIANTS)) extra[name] = await run(options)
            rows.push({
              case: c.name,
              where,
              size,
              query: style,
              stock: { kept: keeps(stockAfter, c), savings: savings(text, stockAfter), touched: stockAfter !== text },
              tameru: await run({}),
              extra,
            })
          }
        }
      }
    }
  } finally {
    await client.dispose()
  }
  report(rows)
  const out = process.argv.indexOf('--json')
  if (out >= 0 && process.argv[out + 1]) writeFileSync(process.argv[out + 1]!, JSON.stringify(rows, null, 1))
}

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)

function report(rows: Row[]): void {
  const names = Object.keys(VARIANTS)
  const cell = (arms: Arm[]): string => `${pct(mean(arms.map(a => (a.kept ? 1 : 0)))).padStart(6)} / ${pct(mean(arms.map(a => a.savings))).padStart(6)}`
  const line = (label: string, sel: Row[]): string =>
    `| ${label.padEnd(24)} | ${String(sel.length).padStart(3)} | ${cell(sel.map(r => r.stock))} | ${cell(sel.map(r => r.tameru))} |${names.map(n => ` ${cell(sel.map(r => r.extra[n]!))} |`).join('')}`
  console.log('Each cell: required facts kept / characters saved.\n')
  console.log(`| group                    |   n | stock | Tameru |${names.map(n => ` Tameru ${n} |`).join('')}`)
  console.log(`|--------------------------|----:|-------|--------|${names.map(() => '--------|').join('')}`)
  console.log(line('ALL', rows))
  for (const style of ['question', 'task'] as QueryStyle[]) console.log(line(`query = ${style}`, rows.filter(r => r.query === style)))
  for (const where of ['head', 'middle', 'tail'] as Where[]) console.log(line(`needle at ${where}`, rows.filter(r => r.where === where)))
  for (const size of [12_000, 40_000]) console.log(line(`output ${size / 1000}K chars`, rows.filter(r => r.size === size)))
  for (const style of ['question', 'task'] as QueryStyle[])
    for (const where of ['head', 'middle', 'tail'] as Where[]) console.log(line(`${style} / ${where}`, rows.filter(r => r.query === style && r.where === where)))
  console.log("\nTameru by the engine's own risk rating (touched results only):")
  for (const style of ['question', 'task'] as QueryStyle[]) {
    for (const risk of ['low', 'medium', 'high']) {
      const sel = rows.filter(r => r.query === style && r.tameru.touched && r.tameru.risk === risk)
      if (sel.length) console.log(`  query=${style} risk=${risk}: n=${sel.length}, facts kept ${pct(mean(sel.map(r => (r.tameru.kept ? 1 : 0))))}, saved ${pct(mean(sel.map(r => r.tameru.savings)))}`)
    }
  }
  console.log('\nGated: Tameru acts only when the engine reports confidence of at least 0.7 (otherwise the original is left as it is):')
  const gated = (r: Row): Arm => (r.tameru.touched && (r.tameru.confidence ?? 0) >= 0.7 ? r.tameru : { kept: true, savings: 0, touched: false })
  for (const [label, sel] of [['ALL', rows], ['query = question', rows.filter(r => r.query === 'question')], ['query = task', rows.filter(r => r.query === 'task')]] as Array<[string, Row[]]>) {
    console.log(`  ${label.padEnd(18)} n=${sel.length}: stock kept ${pct(mean(sel.map(r => (r.stock.kept ? 1 : 0))))} saved ${pct(mean(sel.map(r => r.stock.savings)))} | Tameru gated kept ${pct(mean(sel.map(r => (gated(r).kept ? 1 : 0))))} saved ${pct(mean(sel.map(r => gated(r).savings)))} (acts on ${sel.filter(r => gated(r).touched).length})`)
  }
  const lostByTameru = rows.filter(r => !r.tameru.kept && r.stock.kept)
  const lostByStock = rows.filter(r => !r.stock.kept && r.tameru.kept)
  console.log(`\nfacts kept by stock but lost by Tameru: ${lostByTameru.length} of ${rows.length}`)
  console.log(`facts kept by Tameru but lost by stock: ${lostByStock.length} of ${rows.length}`)
  console.log(`lost by both: ${rows.filter(r => !r.stock.kept && !r.tameru.kept).length}`)
  for (const r of lostByTameru.slice(0, 12)) console.log(`  Tameru lost: ${r.case} (${r.where}, ${r.size / 1000}K, query=${r.query})`)
}

await main()
