import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { EngineClient } from '../src/host/engine-client.ts'
import { WORKER_FLAGS, nodeWorkerSpawn } from '../src/host/process.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(root, 'vendor', 'run_worker.py')
const python = process.env.TAMERU_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')

const log = [
  ...Array.from({ length: 300 }, (_, i) => `INFO routine line ${i} nothing to see here`),
  'ERROR build failed: assertion at Foo.java:42 expected 3 but was 4',
  ...Array.from({ length: 200 }, (_, i) => `INFO tail ${i}`),
].join('\n')

/** Run the real worker with a throwaway home directory; returns the replies and what was written under that home. */
function run(lines: string[], extraEnv: Record<string, string> = {}): Promise<{ replies: any[]; home: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), 'tameru-home-'))
    const child = spawn(python, [...WORKER_FLAGS, script], {
      cwd: home,
      env: { ...process.env, USERPROFILE: home, HOME: home, HOMEPATH: home, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    child.stdout.on('data', chunk => out.push(chunk))
    child.on('error', reject)
    child.on('close', code => {
      const replies = Buffer.concat(out).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      resolve({ replies, home, code })
    })
    child.stdin.end(lines.map(line => `${line}\n`).join(''))
  })
}

const files = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name))

test('the worker shortens a log, keeps the error, and says what the engine is', async () => {
  const { replies, home, code } = await run([
    JSON.stringify({ id: 1, op: 'version' }),
    JSON.stringify({ id: 2, op: 'compress', text: log, query: 'why did the build fail' }),
  ])
  try {
    assert.equal(code, 0)
    assert.equal(replies[0].result.engine_version, '1.9.0')
    assert.match(replies[0].result.vendored_from, /^[0-9a-f]{40}$/)
    assert.equal(replies[0].result.protocol, 1)
    const result = replies[1].result
    assert.equal(result.fail_open, false)
    assert.ok(result.text.includes('assertion at Foo.java:42 expected 3 but was 4'))
    assert.ok(result.text.length < log.length / 4)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('every option that could write to disk, reach a network or run a model is refused', async () => {
  const forbidden = ['ccr', 'ccr_dir', 'log_dir', 'summary_endpoint', 'summary_models', 'semantic_tier', 'strategy', 'limits', 'gap_marker', 'cache_prefix']
  const { replies, home } = await run(forbidden.map((field, i) => JSON.stringify({ id: i + 1, op: 'compress', text: log, query: 'q', [field]: field === 'ccr' ? true : 'x' })))
  try {
    assert.equal(replies.length, forbidden.length)
    for (const [i, reply] of replies.entries()) {
      assert.equal(reply.ok, false, forbidden[i])
      assert.equal(reply.error, `unknown_field:${forbidden[i]}`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the worker writes nothing under the home directory', async () => {
  const { home } = await run([JSON.stringify({ id: 1, op: 'compress', text: log, query: 'why did the build fail' })])
  try {
    assert.deepEqual(files(home), [])
    assert.equal(existsSync(join(home, '.tameru')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('bad input gets an error reply and never takes the worker down', async () => {
  const { replies, home, code } = await run([
    '{not json',
    JSON.stringify({ id: 1, op: 'nope' }),
    JSON.stringify({ id: 2, op: 'compress', text: 5 }),
    JSON.stringify({ id: 3, op: 'compress', text: 'x', query: 'q', mode: 'turbo' }),
    JSON.stringify({ id: 4, op: 'compress', text: 'x', query: 'q', budget_ratio: 7 }),
    JSON.stringify([1, 2, 3]),
    JSON.stringify({ id: 5, op: 'ping' }),
  ])
  try {
    assert.equal(code, 0)
    assert.deepEqual(replies.map(r => r.error ?? 'ok'), ['bad_json', 'unknown_op', 'bad_text', 'bad_mode', 'bad_budget_ratio', 'bad_request', 'ok'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('non-ASCII text, emoji and lone surrogates survive the pipe and are reported', async () => {
  const text = `${'日本語のログ行です。'.repeat(80)}\nERROR 失敗しました 😀\n${'ثانويّ '.repeat(80)}`
  const { replies, home } = await run([
    JSON.stringify({ id: 1, op: 'compress', text, query: '失敗' }),
    String.raw`{"id":2,"op":"compress","text":"broken \ud800 surrogate","query":"q"}`,
  ])
  try {
    assert.equal(replies[0].ok, true)
    assert.equal(replies[0].result.sanitized, false)
    assert.ok(!replies[0].result.text.includes('�'))
    assert.equal(replies[1].ok, true)
    assert.equal(replies[1].result.sanitized, true)
    assert.ok(replies[1].result.text.includes('�'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a request over the size limit is refused and the next one is still served', async () => {
  const huge = JSON.stringify({ id: 1, op: 'compress', text: 'a'.repeat(17 * 1024 * 1024), query: 'q' })
  const { replies, home } = await run([huge, JSON.stringify({ id: 2, op: 'ping' })])
  try {
    assert.equal(replies[0].error, 'too_large')
    assert.equal(replies[1].ok, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the worker exits when its input ends, and on shutdown', async () => {
  const eof = await run([])
  rmSync(eof.home, { recursive: true, force: true })
  assert.equal(eof.code, 0)
  const stop = await run([JSON.stringify({ id: 1, op: 'shutdown' }), JSON.stringify({ id: 2, op: 'ping' })])
  rmSync(stop.home, { recursive: true, force: true })
  assert.equal(stop.replies.length, 1)
  assert.equal(stop.code, 0)
})

test('a planted module in the working directory is not imported', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tameru-planted-'))
  try {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(home, 'json.py'), 'raise SystemExit("PLANTED")\n')
    writeFileSync(join(home, 'tameru.py'), 'raise SystemExit("PLANTED")\n')
    const child = spawn(python, [...WORKER_FLAGS, script], { cwd: home, env: { ...process.env, PYTHONPATH: home }, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    child.stdout.on('data', c => out.push(c))
    child.stdin.end(`${JSON.stringify({ id: 1, op: 'version' })}\n`)
    await new Promise(resolve => child.on('close', resolve))
    assert.equal(JSON.parse(Buffer.concat(out).toString('utf8')).ok, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the client works end to end over a real worker and stops it on dispose', async () => {
  const client = new EngineClient(nodeWorkerSpawn(python, script, root), { timeoutMs: 30_000 })
  try {
    const version = await client.probe()
    assert.equal(version?.engineVersion, '1.9.0')
    const result = await client.compress({ text: log, query: 'why did the build fail' })
    assert.ok(result && !result.failOpen)
    assert.ok(result.text.includes('Foo.java:42'))
    assert.equal(client.status().state, 'running')
  } finally {
    await client.dispose()
  }
  assert.equal(client.status().state, 'disabled')
  assert.equal(await client.compress({ text: 'x', query: 'q' }), undefined)
})
