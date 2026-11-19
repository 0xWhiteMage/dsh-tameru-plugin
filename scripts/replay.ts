// Whole-session comparison: stock Harness behaviour against stock plus Tameru, on identical simulated sessions. REPLAY ONLY.
//
//   node scripts/replay.ts --split dev+validation --out docs/results/replay-1.10.0-rows.jsonl [--shard 1/3] [--arms stock,G-0.7]
//                          [--baseline-vendor DIR]   (DIR holds run_worker.py and tameru/ of the 1.9.0-era plugin: git archive 922d171 vendor)
//   node scripts/replay.ts --report rows.jsonl [more.jsonl] [--selection out.json]
//   node scripts/replay.ts --selfcheck rows.jsonl
//   node scripts/replay.ts --holdout --out rows.jsonl        # the one logged look; needs docs/FROZEN-1.10.0-SETTINGS.md and a matching hash
//
// Rows are in the shared jsonl format (see scripts/replay/stats.ts); differences are paired and use a seeded cluster bootstrap by
// scenario, with the number of clusters printed next to every interval. See scripts/replay/run.ts for what is real and what is simulated.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngineClient } from '../src/host/engine-client.ts'
import { nodeWorkerSpawn } from '../src/host/process.ts'
import { fullReport } from './replay/report.ts'
import { ARMS, WINDOWS, runArm, type ArmSpec } from './replay/run.ts'
import { scenariosFor, sha256, splitOf, type Scenario } from './replay/scenarios.ts'
import { fromJsonl, selfCheck, toJsonl, type Row } from './replay/stats.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const python = process.env.TAMERU_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const argv = process.argv.slice(2)
const flag = (name: string): boolean => argv.includes(`--${name}`)
const option = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const files = (): string[] => argv.slice(argv.indexOf('--report') + 1).filter(a => !a.startsWith('--') && a.endsWith('.jsonl'))

const FROZEN_FILE = join(root, 'docs', 'FROZEN-1.10.0-SETTINGS.md')

function git(...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

async function holdoutScenarios(): Promise<{ scenarios: Scenario[]; arm: ArmSpec; settingHash: string }> {
  const holdout = await import('./replay/holdout.ts')
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

async function run(): Promise<void> {
  const out = option('out')
  if (!out) throw new Error('--out FILE.jsonl is required')
  const isHoldout = flag('holdout')
  let scenarios: Scenario[]
  let arms: ArmSpec[]
  if (isHoldout) {
    const h = await holdoutScenarios()
    scenarios = h.scenarios
    arms = [ARMS[0]!, ARMS[1]!, h.arm]
  } else {
    const which = option('split') ?? 'dev+validation'
    if (which.includes('holdout')) throw new Error('the holdout is read only with --holdout (one logged look)')
    scenarios = [...(which.includes('dev') ? scenariosFor('dev') : []), ...(which.includes('validation') ? scenariosFor('validation') : [])]
    const wanted = option('arms')?.split(',')
    arms = wanted ? ARMS.filter(a => wanted.includes(a.name)) : ARMS
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
          rows.push(await runArm(arm, sc, window, clientFor(arm.engine), isHoldout ? 'holdout' : splitOf(sc.id), arm.engine === 'none' ? 'none' : arm.engine))
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
