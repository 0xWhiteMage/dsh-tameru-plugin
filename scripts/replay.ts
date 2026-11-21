// Whole-session comparison: stock Harness behaviour against stock plus Tameru, on identical simulated sessions. REPLAY ONLY.
//
//   node scripts/replay.ts --split dev+validation --out docs/results/replay-1.10.0-rows.jsonl [--shard 1/3] [--arms stock,G-0.7]
//                          [--baseline-vendor DIR]   (DIR holds run_worker.py and tameru/ of the 1.9.0-era plugin: git archive 922d171 vendor)
//   node scripts/replay.ts --report rows.jsonl [more.jsonl] [--selection out.json]
//   node scripts/replay.ts --selfcheck rows.jsonl
//   node scripts/replay.ts --reprice rows.jsonl [more.jsonl] [--json out.json]   # every price profile, post hoc (scripts/replay/pricing.ts)
//   --split dev+validation+burned-r1 adds the burned round-1 holdout as development data (rows labelled burned-r1; no look is logged)
//   Every non-reference arm must be in the settings-tried ledger (REPLAY_LEDGER, else docs/results/settings-tried-ledger.json).
//   node scripts/replay.ts --holdout --out rows.jsonl        # the one logged look; needs docs/FROZEN-1.10.0-SETTINGS.md and a matching hash
//   node scripts/replay.ts --corpus DIR --split dev+validation --windows 128000,252000 --arms ... --out rows.jsonl [--shard k/n]
//                          [--per-family K --subsample-seed S] [--ids a,b] [--no-records]
//       the round-2 session corpus (scripts/replay/corpus.ts; DIR = the engine build CLI's --out, e.g. dev/session_corpus); dev and
//       validation only, the holdout is refused. `--per-family K` runs a deterministic stratified subsample (K per family, logged in
//       OUT.subsample.json). Reports: node scripts/replay.ts --corpus-report rows.jsonl [...] [--json out.json]
//
// Rows are in the shared jsonl format (see scripts/replay/stats.ts); differences are paired and use a seeded cluster bootstrap by
// scenario, with the number of clusters printed next to every interval. See scripts/replay/run.ts for what is real and what is simulated.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngineClient } from '../src/host/engine-client.ts'
import { nodeWorkerSpawn } from '../src/host/process.ts'
import { refuseUnledgered } from './replay/ledger.ts'
import { fullReport } from './replay/report.ts'
import { repriceReport } from './replay/reprice.ts'
import { ARMS, WINDOWS, runArm, type ArmSpec } from './replay/run.ts'
import { scenariosFor, sha256, splitOf, type Scenario } from './replay/scenarios.ts'
import { CORPUS_WINDOWS, loadScenarioWindows, readIndex, stratifiedSubsample, type CorpusSplit, type IndexEntry } from './replay/corpus.ts'
import { fromJsonl, selfCheck, toJsonl, type Row } from './replay/stats.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const python = process.env.TAMERU_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const argv = process.argv.slice(2)
const flag = (name: string): boolean => argv.includes(`--${name}`)
const option = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const files = (after = '--report'): string[] => argv.slice(argv.indexOf(after) + 1).filter(a => !a.startsWith('--') && a.endsWith('.jsonl'))

const FROZEN_FILE = join(root, 'docs', 'FROZEN-1.10.0-SETTINGS.md')

function git(...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

async function holdoutScenarios(): Promise<{ scenarios: Scenario[]; arm: ArmSpec; settingHash: string }> {
  const holdout = await import('./replay/holdout.ts')
  // a burned holdout is refused first, before anything is read or logged
  holdout.refuseBurned(holdout.holdoutHash().hash)
  if (!existsSync(FROZEN_FILE)) throw new Error('no frozen setting (docs/FROZEN-1.10.0-SETTINGS.md): the holdout is not looked at before one is frozen')
  const frozen = readFileSync(FROZEN_FILE, 'utf8')
  const armName = /^arm:\s*(\S+)\s*$/m.exec(frozen)?.[1]
  const arm = ARMS.find(a => a.name === armName)
  if (!arm || arm.engine !== '1.10.0') throw new Error(`the frozen file names no runnable arm ("${armName}")`)
  const { hash, count } = holdout.holdoutHash()
  if (hash !== holdout.registeredHash()) throw new Error('the holdout scenarios do not match HOLDOUT.sha256: do not look')
  const settingHash = sha256(frozen.replace(/\r\n/g, '\n'))
  const engineCommit = /VENDORED_FROM\s*=\s*"([0-9a-f]{40})"/.exec(readFileSync(join(root, 'vendor', 'tameru', '__init__.py'), 'utf8'))?.[1] ?? 'unknown'
  // the look is logged before it is taken
  const looks = existsSync(holdout.HOLDOUT_LOOKS_FILE) ? (JSON.parse(readFileSync(holdout.HOLDOUT_LOOKS_FILE, 'utf8')) as unknown[]) : []
  looks.push({ date: new Date().toISOString(), plugin_commit: git('rev-parse', 'HEAD'), plugin_dirty: git('status', '--porcelain') !== '', engine_commit: engineCommit, setting_hash: settingHash, arm: arm.name, holdout_hash: hash, scenarios: count })
  writeFileSync(holdout.HOLDOUT_LOOKS_FILE, `${JSON.stringify(looks, null, 2)}\n`)
  return { scenarios: holdout.loadHoldout(holdout.LOOK_TOKEN), arm, settingHash }
}

function engineClients(baselineVendor: string | undefined): { clientFor: (engine: ArmSpec['engine']) => EngineClient | undefined; dispose: () => Promise<void> } {
  const clients = new Map<string, EngineClient>()
  const clientFor = (engine: ArmSpec['engine']): EngineClient | undefined => {
    if (engine === 'none') return undefined
    let c = clients.get(engine)
    if (!c) {
      const dir = engine === '1.9.0' ? baselineVendor : join(root, 'vendor')
      if (!dir) throw new Error('--baseline-vendor DIR is needed for the 1.9.0 arm (git archive 922d171 vendor)')
      c = new EngineClient(nodeWorkerSpawn(python, join(dir, 'run_worker.py'), root), { timeoutMs: 60_000 })
      clients.set(engine, c)
    }
    return c
  }
  return { clientFor, dispose: async () => { for (const c of clients.values()) await c.dispose() } }
}

/** The round-2 session corpus (dev and validation only): each scenario file is read once and sliced at every window. */
async function runCorpus(dir: string, out: string): Promise<void> {
  const which = option('split') ?? 'dev+validation'
  if (which.includes('holdout') || flag('holdout')) throw new Error('the session corpus holdout is sealed: this runner never reads it')
  const splits = which.split('+') as CorpusSplit[]
  let entries: Array<IndexEntry & { split: CorpusSplit }> = splits.flatMap(split => readIndex(dir, split).map(e => ({ ...e, split })))
  const windows = (option('windows') ?? CORPUS_WINDOWS.join(',')).split(',').map(Number)
  for (const w of windows) if (!(CORPUS_WINDOWS as readonly number[]).includes(w)) throw new Error(`window ${w} is not a corpus replay window (${CORPUS_WINDOWS.join(', ')})`)
  const wanted = option('arms')?.split(',')
  if (!wanted) throw new Error('--arms is required with --corpus')
  const arms = ARMS.filter(a => wanted.includes(a.name))
  if (arms.length !== wanted.length) throw new Error(`unknown arm in --arms: ${wanted.filter(w => !ARMS.some(a => a.name === w)).join(', ')}`)
  refuseUnledgered(arms)
  const perFamily = option('per-family')
  if (perFamily) {
    const seed = option('subsample-seed')
    if (!seed) throw new Error('--per-family needs --subsample-seed (logged)')
    entries = stratifiedSubsample(entries, Number(perFamily), seed)
    writeFileSync(`${out}.subsample.json`, `${JSON.stringify({ rule: 'within every family, ids ordered by sha256(seed + ":" + id), first K taken', per_family: Number(perFamily), seed, splits, windows, ids: entries.map(e => e.id) }, null, 1)}
`)
  }
  const ids = option('ids')?.split(',')
  if (ids) entries = entries.filter(e => ids.includes(e.id))
  const [shard, shards] = (option('shard') ?? '1/1').split('/').map(Number) as [number, number]
  entries = entries.filter((_, i) => i % shards === shard - 1)
  const keepRecords = !flag('no-records')
  const { clientFor, dispose } = engineClients(option('baseline-vendor') ?? process.env.REPLAY_BASELINE_VENDOR)
  const lines: string[] = []
  try {
    for (const e of entries) {
      const sliced = loadScenarioWindows(dir, e.split, e, windows)
      for (const sc of sliced) {
        for (const arm of arms) {
          const started = performance.now()
          const row = await runArm(arm, sc, sc.corpus!.window, clientFor(arm.engine), e.split, arm.engine === 'none' ? 'none' : arm.engine)
          row.run_ms = Math.round(performance.now() - started)
          if (!keepRecords) delete row.records
          lines.push(JSON.stringify(row))
          process.stderr.write('.')
        }
      }
      writeFileSync(out, lines.length ? `${lines.join('\n')}
` : '') // after every scenario, so a stopped run keeps its rows
    }
  } finally {
    await dispose()
  }
  process.stderr.write('\n')
  writeFileSync(out, lines.length ? `${lines.join('\n')}
` : '')
  console.log(`wrote ${lines.length} rows to ${out}`)
}

async function run(): Promise<void> {
  const out = option('out')
  if (!out) throw new Error('--out FILE.jsonl is required')
  const corpusDir = option('corpus')
  if (corpusDir) return runCorpus(corpusDir, out)
  const isHoldout = flag('holdout')
  let scenarios: Scenario[]
  let arms: ArmSpec[]
  const burned = new Set<string>()
  if (isHoldout) {
    const h = await holdoutScenarios()
    scenarios = h.scenarios
    arms = [ARMS[0]!, ARMS[1]!, h.arm]
  } else {
    const which = option('split') ?? 'dev+validation'
    if (which.includes('holdout')) throw new Error('the holdout is read only with --holdout (one logged look)')
    const parts = which.split('+')
    scenarios = [...(parts.includes('dev') ? scenariosFor('dev') : []), ...(parts.includes('validation') ? scenariosFor('validation') : [])]
    if (parts.includes('burned-r1')) {
      const { loadBurnedAsDev } = await import('./replay/holdout.ts')
      for (const s of loadBurnedAsDev()) {
        burned.add(s.id)
        scenarios.push(s)
      }
    }
    const wanted = option('arms')?.split(',')
    arms = wanted ? ARMS.filter(a => wanted.includes(a.name)) : ARMS
    if (wanted && arms.length !== wanted.length) throw new Error(`unknown arm in --arms: ${wanted.filter(w => !ARMS.some(a => a.name === w)).join(', ')}`)
    refuseUnledgered(arms)
  }
  const [shard, shards] = (option('shard') ?? '1/1').split('/').map(Number) as [number, number]
  scenarios = scenarios.filter((_, i) => i % shards === shard - 1)
  const baselineVendor = option('baseline-vendor') ?? process.env.REPLAY_BASELINE_VENDOR
  const clients = new Map<string, EngineClient>()
  const clientFor = (engine: ArmSpec['engine']): EngineClient | undefined => {
    if (engine === 'none') return undefined
    let c = clients.get(engine)
    if (!c) {
      const dir = engine === '1.9.0' ? baselineVendor : join(root, 'vendor')
      if (!dir) throw new Error('--baseline-vendor DIR is needed for the 1.9.0 arm (git archive 922d171 vendor)')
      c = new EngineClient(nodeWorkerSpawn(python, join(dir, 'run_worker.py'), root), { timeoutMs: 60_000 })
      clients.set(engine, c)
    }
    return c
  }
  const rows: Row[] = []
  try {
    for (const sc of scenarios) {
      for (const window of WINDOWS) {
        for (const arm of arms) {
          rows.push(await runArm(arm, sc, window, clientFor(arm.engine), isHoldout ? 'holdout' : burned.has(sc.id) ? 'burned-r1' : splitOf(sc.id), arm.engine === 'none' ? 'none' : arm.engine))
          process.stderr.write('.')
        }
      }
    }
  } finally {
    for (const c of clients.values()) await c.dispose()
  }
  process.stderr.write('\n')
  writeFileSync(out, toJsonl(rows))
  console.log(`wrote ${rows.length} rows to ${out}`)
}

async function main(): Promise<void> {
  if (flag('selfcheck')) {
    const rows = fromJsonl(readFileSync(resolve(option('selfcheck')!), 'utf8'))
    const check = selfCheck(rows)
    console.log(check.ok ? 'arm-vs-itself is exactly 0 on every metric' : `FAILED:\n${check.failures.join('\n')}`)
    process.exitCode = check.ok ? 0 : 1
    return
  }
  if (flag('reprice')) {
    const rows = files('--reprice').flatMap(f => fromJsonl(readFileSync(resolve(f), 'utf8')))
    const { text, json } = repriceReport(rows)
    console.log(text)
    const out = option('json')
    if (out) writeFileSync(out, `${JSON.stringify(json, null, 2)}
`)
    process.exitCode = json.selfCheckOk ? 0 : 1
    return
  }
  if (flag('corpus-report')) {
    const { corpusReport } = await import('./replay/corpus-report.ts')
    const rows = files('--corpus-report').flatMap(f => fromJsonl(readFileSync(resolve(f), 'utf8')))
    const { text, json } = corpusReport(rows)
    console.log(text)
    const out = option('json')
    if (out) writeFileSync(out, `${JSON.stringify(json, null, 1)}
`)
    process.exitCode = json.selfCheckOk ? 0 : 1
    return
  }
  if (flag('report')) {
    const rows = files().flatMap(f => fromJsonl(readFileSync(resolve(f), 'utf8')))
    const { text, selection } = fullReport(rows)
    console.log(text)
    const sel = option('selection')
    if (sel) writeFileSync(sel, `${JSON.stringify(selection, null, 2)}\n`)
    return
  }
  await run()
}

await main()
