// THE FRESH HOLDOUT for the DeepSeek whole-session replay: 48 scenarios in 8 families that share nothing with the development pool
// (other filler, other tools, other fact formats and value shapes, other languages, Chinese user messages in half of them).
//
// Nothing here is read by the normal runner. `loadHoldout` throws unless it is called with the explicit look token the `--holdout`
// flag builds, and the runner appends every look to `holdout_looks.json` before it starts. The canonical text of every scenario is
// hashed into `test/fixtures/replay/HOLDOUT.sha256`, and that hash is registered in the engine's analysis plan before any setting is
// tuned. Do not run this set to choose between settings: a setting chosen after a look may not be confirmed on this holdout.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical, generate, sha256, type FamilySpec, type Rand, type Scenario } from './scenarios.ts'

const here = dirname(fileURLToPath(import.meta.url))
export const HOLDOUT_DIR = join(here, '..', '..', 'test', 'fixtures', 'replay')
export const HOLDOUT_HASH_FILE = join(HOLDOUT_DIR, 'HOLDOUT.sha256')
export const HOLDOUT_LOOKS_FILE = join(HOLDOUT_DIR, 'holdout_looks.json')
export const LOOK_TOKEN = Symbol('spend-the-one-holdout-look')

const hexs = (r: Rand, width = 8): string => Array.from({ length: width }, () => Math.floor(r() * 16).toString(16)).join('')
const b36 = (r: Rand, width = 6): string => Math.floor(r() * 36 ** width).toString(36).padStart(width, 'z')
const pick = <T>(xs: readonly T[], n: number): T => xs[n % xs.length]!

const FAMILIES: FamilySpec[] = [
  {
    id: 'pytest-zh', base: 5100, lang: 'zh', steps: [40, 56], size: [8000, 26_000], smallShare: 0.15,
    call: (i, r) => ({ tool: 'pytest', args: { path: `tests/${pick(['api', 'billing', 'search', 'etl'], i)}`, args: ['-x', '-q', `--seed=${Math.floor(r() * 99)}`] } }),
    fill: [
      (n, r) => `tests/${pick(['api', 'billing', 'search', 'etl'], n)}/test_${pick(['order', 'refund', 'index', 'sync', 'login'], n >> 3)}_${(n >> 6) % 60}.py::test_case_${(n >> 9) % 40} PASSED  [${String(Math.floor(r() * 100)).padStart(3)}%]`,
      n => `  /usr/lib/python3.11/site-packages/${pick(['urllib3', 'sqlalchemy', 'pydantic'], n)}/util.py:${(n >> 4) % 900}: DeprecationWarning: 该接口将在 v${(n >> 8) % 9} 移除`,
      n => `tests/${pick(['api', 'billing'], n)}/test_${(n >> 5) % 80}.py::test_skip_${(n >> 11) % 30} SKIPPED (需要网络访问)`,
    ],
    key: (i, n) => `${pick(['FEATURE', 'RATE', 'SYNC', 'BATCH', 'AUTH', 'POOL'], n + i)}_${pick(['LIMIT', 'WINDOW', 'TTL', 'SIZE', 'RETRY', 'DEPTH'], n * 5 + i)}`,
    value: (i, r) => `0x${hexs(r, 6)}${i}`,
    fact: (key, value, i) => `conftest.py:${i}: 夹具覆盖 ${key} -> ${value}（来自环境变量）`,
    stale: key => `conftest.py:12: 夹具覆盖 ${key} -> 0x000000 (旧默认值)`,
    noise: i => `conftest.py:${40 + i}: 夹具覆盖 UNRELATED_FLAG_${i} -> 0x0000${i}`,
    task: (style, keys) => (style === 'specific' ? `请找出这些环境变量最终生效的取值：${keys.join('、')}。` : '回顾最近几次测试输出，说明为什么结算测试不稳定，并汇报。'),
  },
  {
    id: 'maven-en', base: 5200, lang: 'en', steps: [46, 60], size: [7000, 22_000], smallShare: 0.2,
    call: (i, r) => ({ tool: 'run_maven', args: { goals: pick(['test', 'verify', 'package -DskipITs'], i), module: `services/svc-${Math.floor(r() * 12)}` } }),
    fill: [
      (n, r) => `[INFO] Running com.acme.${pick(['orders', 'ledger', 'catalog', 'notify'], n)}.${pick(['Order', 'Entry', 'Item', 'Mail'], n >> 2)}Test${(n >> 6) % 50}`,
      n => `[INFO] Tests run: ${(n >> 4) % 40}, Failures: 0, Errors: 0, Skipped: ${n % 3}, Time elapsed: ${((n >> 9) % 900) / 100} s - in com.acme.Suite${(n >> 2) % 70}`,
      n => `[INFO] Downloading from central: https://repo.maven.apache.org/maven2/org/lib${n % 90}/artifact${(n >> 5) % 60}/1.${(n >> 9) % 20}.0/artifact-1.${(n >> 9) % 20}.0.jar`,
    ],
    key: (i, n) => `${pick(['spring', 'hikari', 'kafka', 'flyway', 'logback', 'jetty'], n + i)}.${pick(['maxPool', 'timeoutMs', 'batchSize', 'baseline', 'level', 'threads'], n * 7 + i)}`,
    value: (i, r) => `${pick(['eu-west', 'us-east', 'ap-south', 'sa-east'], i)}-${Math.floor(r() * 900) + 100}${pick(['a', 'b', 'c'], i)}`,
    fact: (key, value, i) => `[WARNING] Overriding property ${key} with ${value} (profile ci-${i})`,
    stale: key => `[WARNING] Overriding property ${key} with default-0 (profile base)`,
    noise: i => `[WARNING] Overriding property unrelated.setting${i} with n/a-${i} (profile docs)`,
    task: (style, keys) => (style === 'specific' ? `Which values do these Maven properties end up with after the profile overrides: ${keys.join(', ')}?` : 'Read through the build output so far and tell me what looks wrong with the nightly build.'),
  },
  {
    id: 'kubectl-zh', base: 5300, lang: 'zh', steps: [42, 58], size: [8000, 28_000], smallShare: 0.1,
    call: (i, r) => ({ tool: 'kubectl', args: { verb: 'logs', namespace: pick(['prod', 'staging'], i), pod: `api-${hexs(r, 5)}`, tail: 2000 } }),
    fill: [
      (n, r) => `{"ts":"2026-11-13T10:${String(n % 60).padStart(2, '0')}:${String((n >> 8) % 60).padStart(2, '0')}Z","level":"info","msg":"请求完成","path":"/v1/${pick(['orders', 'items', 'users'], n)}/${(n >> 5) % 9000}","ms":${(n >> 9) % 800},"trace":"${hexs(r, 12)}"}`,
      n => `{"ts":"2026-11-13T10:00:${String(n % 60).padStart(2, '0')}Z","level":"debug","msg":"连接池状态","active":${n % 30},"idle":${(n >> 4) % 30},"waiting":${(n >> 8) % 4}}`,
    ],
    key: (i, n) => `${pick(['ingress', 'worker', 'sidecar', 'cron', 'gateway', 'mesh'], n + i)}.${pick(['replicas', 'memLimit', 'qps', 'burst', 'drain', 'probe'], n * 11 + i)}`,
    value: (i, r) => `${pick(['r', 'q', 'm', 'k'], i)}${b36(r, 6)}`,
    fact: (key, value, i) => `{"ts":"2026-11-13T09:5${i % 10}:00Z","level":"info","msg":"配置已应用","key":"${key}","value":"${value}"}`,
    stale: key => `{"ts":"2026-11-13T08:00:00Z","level":"info","msg":"配置已应用","key":"${key}","value":"initial"}`,
    noise: i => `{"ts":"2026-11-13T09:00:00Z","level":"info","msg":"配置已应用","key":"unrelated.knob${i}","value":"x${i}"}`,
    task: (style, keys) => (style === 'specific' ? `请从日志里找出 ${keys.join('、')} 最后一次应用的值。` : '看一下这些容器日志，说明为什么接口偶尔变慢。'),
  },
  {
    id: 'sql-en', base: 5400, lang: 'en', steps: [40, 52], size: [9000, 30_000], smallShare: 0.1,
    call: (i, r) => ({ tool: 'psql', args: { query: `SELECT * FROM ${pick(['events', 'audit', 'orders', 'metering'], i)} WHERE id > ${Math.floor(r() * 1e6)} ORDER BY id LIMIT 400` } }),
    fill: [
      (n, r) => `| ${String((n >> 3) % 1e6).padStart(7)} | ${pick(['alice', 'bob', 'carol', 'dave'], n)}${(n >> 6) % 90} | ${pick(['created', 'updated', 'closed'], n >> 2)} | 2026-11-${String(1 + (n % 28)).padStart(2, '0')} 10:${String((n >> 5) % 60).padStart(2, '0')} | ${((n >> 8) % 100000) / 100} |`,
      n => `| ${String((n >> 2) % 1e6).padStart(7)} | svc-${n % 30} | ${pick(['ok', 'retry', 'ok', 'ok'], n >> 4)} | ${(n >> 7) % 4000} ms | node-${(n >> 11) % 12} |`,
    ],
    key: (i, n) => `${pick(['billing_cycle', 'retention', 'sampling', 'shard_map', 'quota_tier', 'burst_cap'], n + i)}_${pick(['days', 'pct', 'rows', 'units'], n * 3 + i)}`,
    value: (i, r) => `${100 + Math.floor(r() * 8900)}.${i}${Math.floor(r() * 90) + 10}`,
    fact: (key, value, i) => `| ${key} | ${value} | set by migration m${i}_${hexs(mk(i), 4)} |`,
    stale: key => `| ${key} | 0.00 | set by migration m000 (reverted) |`,
    noise: i => `| unrelated_param_${i} | ${i}.5 | set by migration m9${i} |`,
    task: (style, keys) => (style === 'specific' ? `Report the current value stored for each of these parameters: ${keys.join(', ')}.` : 'Review the query results and explain what is causing the slow invoices.'),
  },
  {
    id: 'jest-en', base: 5500, lang: 'en', steps: [48, 60], size: [6000, 18_000], smallShare: 0.3,
    call: (i, r) => ({ tool: 'npm', args: { script: 'test', workspace: `packages/${pick(['ui', 'sdk', 'cli', 'server', 'shared'], i)}`, shard: `${(i % 4) + 1}/4`, seed: Math.floor(r() * 99) } }),
    fill: [
      (n, r) => `  ✓ ${pick(['renders', 'validates', 'serialises', 'debounces', 'retries'], n)} ${pick(['the form', 'input', 'a payload', 'on blur', 'twice'], n >> 3)} (${(n >> 6) % 300} ms)`,
      n => `PASS packages/${pick(['ui', 'sdk', 'cli'], n)}/src/__tests__/${pick(['form', 'queue', 'render', 'parse'], n >> 2)}${(n >> 6) % 90}.test.tsx`,
      n => `npm WARN deprecated ${pick(['request', 'har-validator', 'uuid', 'querystring'], n)}@${(n >> 4) % 9}.${(n >> 8) % 30}.0: this package has been deprecated`,
    ],
    key: (i, n) => `${pick(['cdn', 'flags', 'telemetry', 'locale', 'router', 'store'], n + i)}.${pick(['baseUrl', 'sampleRate', 'cacheTtl', 'fallback', 'maxItems', 'mode'], n * 13 + i)}`,
    value: (i, r) => `${pick(['edge', 'core', 'lite'], i)}-${hexs(r, 7)}`,
    fact: (key, value) => `  console.log\n    effective config ${key}: '${value}'`,
    stale: key => `  console.log\n    effective config ${key}: 'unset'`,
    noise: i => `  console.log\n    effective config unrelated.item${i}: 'n${i}'`,
    task: (style, keys) => (style === 'specific' ? `Look in the test output for the effective values of ${keys.join(', ')} and report them.` : 'The frontend CI is flaky. Review the test output and report what may explain it.'),
  },
  {
    id: 'gotest-zh', base: 5600, lang: 'zh', steps: [46, 60], size: [7000, 24_000], smallShare: 0.2,
    call: (i, r) => ({ tool: 'go_test', args: { pkg: `./internal/${pick(['store', 'queue', 'auth', 'sched'], i)}/...`, race: i % 2 === 0, count: 1 + Math.floor(r() * 3) } }),
    fill: [
      n => `=== RUN   Test${pick(['Put', 'Get', 'Lease', 'Renew', 'Expire'], n)}/${pick(['empty', 'single', 'many', 'conflict'], n >> 3)}_${(n >> 6) % 60}`,
      n => `--- PASS: Test${pick(['Put', 'Get', 'Lease'], n)}/case_${(n >> 4) % 90} (0.${String((n >> 8) % 100).padStart(2, '0')}s)`,
      (n, r) => `    store_test.go:${(n >> 3) % 400}: 已写入 ${(n >> 7) % 5000} 条记录，耗时 ${r() < 0.5 ? '正常' : '偏高'}`,
    ],
    key: (i, n) => `${pick(['lease', 'raft', 'wal', 'gc', 'snapshot', 'peer'], n + i)}-${pick(['ttl', 'interval', 'quorum', 'batch', 'limit', 'jitter'], n * 17 + i)}`,
    value: (i, r) => `${pick(['v', 'w', 'x'], i)}${(Math.floor(r() * 1e6) + 1000).toString(16)}`,
    fact: (key, value, i) => `    config_test.go:${200 + i}: 生效配置 ${key}=${value}`,
    stale: key => `    config_test.go:10: 生效配置 ${key}=default`,
    noise: i => `    config_test.go:${300 + i}: 生效配置 unrelated-${i}=u${i}`,
    task: (style, keys) => (style === 'specific' ? `帮我从测试输出里找出 ${keys.join('、')} 的最终取值。` : '这批 Go 测试时好时坏，请通读输出并说明可能的原因。'),
  },
  {
    id: 'cargo-en', base: 5700, lang: 'en', steps: [44, 58], size: [8000, 26_000], smallShare: 0.15,
    call: (i, r) => ({ tool: 'cargo', args: { cmd: pick(['build', 'test', 'clippy'], i), package: pick(['core', 'net', 'codec', 'cli'], i + 1), jobs: 1 + Math.floor(r() * 7) } }),
    fill: [
      n => `   Compiling ${pick(['serde', 'tokio', 'bytes', 'regex', 'hyper'], n)}${(n >> 3) % 40} v0.${(n >> 6) % 30}.${(n >> 9) % 20}`,
      n => `warning: unused variable: \`${pick(['buf', 'ctx', 'tmp', 'idx'], n)}${(n >> 4) % 20}\`\n  --> src/${pick(['lib', 'codec', 'frame'], n >> 2)}.rs:${(n >> 6) % 700}:${(n >> 12) % 60}`,
      n => `test ${pick(['parse', 'frame', 'decode', 'roundtrip'], n)}::case_${(n >> 5) % 120} ... ok`,
    ],
    key: (i, n) => `${pick(['MAX', 'MIN', 'DEFAULT', 'FRAME', 'RETRY', 'WINDOW'], n + i)}_${pick(['BYTES', 'MS', 'SLOTS', 'DEPTH', 'COUNT', 'LEVEL'], n * 19 + i)}`,
    value: (i, r) => `${2 ** (8 + i)}+${Math.floor(r() * 900) + 100}`,
    fact: (key, value, i) => `note: build override ${key} = "${value}" (build.rs:${20 + i})`,
    stale: key => `note: build override ${key} = "0" (build.rs:3, superseded)`,
    noise: i => `note: build override UNRELATED_${i} = "${i}" (build.rs:99)`,
    task: (style, keys) => (style === 'specific' ? `Find the final value of each build constant: ${keys.join(', ')}.` : 'The Rust workspace build keeps regressing. Read the compiler output and report suspicious things.'),
  },
  {
    id: 'metrics-zh', base: 5800, lang: 'zh', steps: [40, 54], size: [8000, 27_000], smallShare: 0.15,
    call: (i, r) => ({ tool: 'fetch_metrics', args: { source: pick(['prometheus', 'statsd', 'otel'], i), window: `${5 + Math.floor(r() * 50)}m`, host: `host-${Math.floor(r() * 40)}` } }),
    fill: [
      (n, r) => `2026-11-13T10:${String(n % 60).padStart(2, '0')}:00Z,host-${(n >> 6) % 40},cpu,${(((n >> 4) % 100) / 100).toFixed(2)},${r() < 0.9 ? '正常' : '告警'}`,
      n => `2026-11-13T10:${String(n % 60).padStart(2, '0')}:30Z,host-${(n >> 5) % 40},mem,${(n >> 3) % 64000},MB,${pick(['稳定', '上升', '下降'], n >> 9)}`,
    ],
    key: (i, n) => `${pick(['alert', 'scrape', 'retention', 'rollup', 'export', 'sample'], n + i)}.${pick(['threshold', 'interval', 'limit', 'ratio', 'burst', 'delay'], n * 23 + i)}`,
    value: (i, r) => `${i + 1}${b36(r, 4)}${pick(['s', 'm', 'h'], i)}`,
    fact: (key, value, i) => `# 配置 ${key}=${value}（规则 R${i}）`,
    stale: key => `# 配置 ${key}=0（旧规则）`,
    noise: i => `# 配置 unrelated.gauge${i}=${i}（规则 R9${i}）`,
    task: (style, keys) => (style === 'specific' ? `请在指标输出里找出 ${keys.join('、')} 当前生效的配置值。` : '看一下最近的指标数据，说明为什么告警频繁出现，并汇报。'),
  },
]

const mkRand = (seed: number): Rand => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function mk(i: number): Rand {
  return mkRand(i + 77)
}

export const HOLDOUT_FAMILIES = FAMILIES.map(f => f.id)
export const PER_FAMILY = 6

/** The holdout scenarios. Throws unless called with the look token: the normal runner never holds it. */
export function loadHoldout(token: symbol): Scenario[] {
  if (token !== LOOK_TOKEN) throw new Error('the holdout is read only by a logged `--holdout` run')
  return FAMILIES.flatMap(spec => Array.from({ length: PER_FAMILY }, (_, i) => generate(spec, i)))
}

/** Hash of the canonical text of every holdout scenario (sorted by id). Generating the scenarios is not running them. */
export function holdoutHash(): { hash: string; count: number; perScenario: Array<{ id: string; family: string; steps: number; facts: number; sha256: string }> } {
  const all = loadHoldout(LOOK_TOKEN).sort((a, b) => (a.id < b.id ? -1 : 1))
  const per = all.map(s => ({ id: s.id, family: s.family, steps: s.steps.length, facts: s.needed.length, sha256: sha256(canonical(s)) }))
  return { hash: sha256(per.map(p => `${p.id}:${p.sha256}`).join('\n')), count: all.length, perScenario: per }
}

export const BURNED_FILE = join(HOLDOUT_DIR, 'BURNED-HOLDOUTS.md')

/** Every 64-hex hash listed in BURNED-HOLDOUTS.md. A missing file burns nothing; an unreadable one is an error (fail closed). */
export function burnedHashes(file = BURNED_FILE): Set<string> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw error
  }
  return new Set(text.match(/\b[0-9a-f]{64}\b/g) ?? [])
}

/** Throws when `hash` is a burned holdout: it was looked at and may never confirm a setting again. */
export function refuseBurned(hash: string, file = BURNED_FILE): void {
  if (burnedHashes(file).has(hash)) throw new Error(`the holdout ${hash.slice(0, 12)}... is burned (test/fixtures/replay/BURNED-HOLDOUTS.md): it is development data now, never confirmation`)
}

export function registeredHash(): string | undefined {
  try {
    return readFileSync(HOLDOUT_HASH_FILE, 'utf8').trim().split(/\s+/)[0]
  } catch {
    return undefined
  }
}

/**
 * The round-1 holdout as DEVELOPMENT DATA for round 2 (rows labelled `burned-r1`). Allowed only because its hash is listed as burned:
 * this never logs a look, never touches `holdout_looks.json` and is not the look machinery. Throws when the set is not burned.
 */
export function loadBurnedAsDev(file = BURNED_FILE): Scenario[] {
  const { hash } = holdoutHash()
  if (!burnedHashes(file).has(hash)) throw new Error('the round-1 holdout is not listed as burned: it may not be used as development data')
  return FAMILIES.flatMap(spec => Array.from({ length: PER_FAMILY }, (_, i) => generate(spec, i)))
}
