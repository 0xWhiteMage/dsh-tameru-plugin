// Engine 1.10.0 through the worker: protocols 2 and 3, the preset, the engine's own decision, the shared query, redaction, and hostile input.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { WORKER_FLAGS } from '../src/host/process.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(root, 'vendor', 'run_worker.py')
const python = process.env.TAMERU_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')

const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'
const loneSurrogate = String.fromCharCode(0xd800)
const log = [
  ...Array.from({ length: 300 }, (_, i) => `INFO routine line ${i} nothing to see here`),
  'ERROR build failed: assertion at Foo.java:42 expected 3 but was 4',
  ...Array.from({ length: 200 }, (_, i) => `INFO tail ${i}`),
].join('\n')
const policy = { min_confidence: 0.7, min_saved_ratio: 0, min_tokens_saved: 1, allow_sanitized: false }
const v2 = { op: 'compress', protocol: 2, preset: 'dsh-tool-result@1', redact_secrets: true, anchor_errors: true, policy }

/** Raw lines in (strings are sent as they are), parsed reply lines out, with the time the whole run took. */
function run(lines: string[]): Promise<{ replies: any[]; code: number | null; ms: number }> {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), 'tameru-v2-'))
    const started = Date.now()
    const child = spawn(python, [...WORKER_FLAGS, script], { cwd: home, env: { ...process.env, USERPROFILE: home, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    child.stdout.on('data', chunk => out.push(chunk))
    child.on('error', reject)
    child.on('close', code => {
      rmSync(home, { recursive: true, force: true })
      resolve({ replies: Buffer.concat(out).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)), code, ms: Date.now() - started })
    })
    child.stdin.end(lines.map(line => `${line}\n`).join(''))
  })
}
const j = (request: unknown): string => JSON.stringify(request)

/** Run a few lines of Python against the worker module (the way a hostile caller of its functions would), return stdout. */
function py(code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', '-B', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(join(root, 'vendor'))}); import run_worker\n${code}`], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1' } })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (err += chunk))
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(err))))
  })
}

test('the version reply names the engine, the protocol, the result schema and the preset ids', async () => {
  const { replies } = await run([j({ id: 1, op: 'version' })])
  const result = replies[0].result
  assert.equal(result.engine, '1.10.0')
  assert.equal(result.protocol, 3)
  assert.equal(result.result_schema, 4)
  assert.deepEqual(result.presets, ['dsh-tool-result@1', 'tool-result@1'])
  assert.equal(result.engine_version, '1.10.0', 'the version 1 key is still there')
})

test('a protocol 2 request is answered with the engine\'s decision and its closed reason', async () => {
  const parts = { call: { name: 'bash', arguments: { command: 'npm test' } }, last_user: 'why did the build fail' }
  const { replies } = await run([
    j({ id: 1, ...v2, text: log, query_parts: parts }),
    j({ id: 2, ...v2, text: log, query: 'x', policy: { ...policy, min_confidence: 0.99 } }),
    j({ id: 3, ...v2, text: `${log}${loneSurrogate}`, query: 'why did the build fail' }),
    j({ id: 4, ...v2, text: 'tiny', query: 'q' }),
  ])
  const first = replies[0].result
  assert.deepEqual(first.decision, { accept: true, reason: 'ok', basis: '' })
  assert.equal(first.preset, 'dsh-tool-result@1')
  assert.equal(first.result_schema, 4)
  assert.ok(first.text.includes('Foo.java:42'))
  assert.ok(Array.isArray(first.dropped) && first.dropped.length >= 1 && first.dropped.length <= 3)
  assert.match(first.stable_key, /^[0-9a-f]{16}$/)
  assert.equal(replies[1].result.decision.reason, 'low_confidence', 'the floor is the policy\'s, the engine applies it')
  assert.equal(replies[2].result.sanitized, true)
  assert.equal(replies[2].result.decision.reason, 'sanitized')
  assert.equal(replies[3].result.decision.accept, false)
  assert.ok(['fail_open', 'no_gain', 'not_enough_tokens'].includes(replies[3].result.decision.reason))
})

test('version 1 requests keep working and may not carry version 2 fields', async () => {
  const { replies } = await run([
    j({ id: 1, op: 'compress', protocol: 1, text: log, query: 'why did the build fail', min_savings_ratio: 0.25 }),
    j({ id: 2, op: 'compress', protocol: 1, text: log, query: 'q', preset: 'dsh-tool-result@1' }),
    j({ id: 3, op: 'compress', text: log, query: 'why did the build fail' }),
    j({ id: 4, op: 'compress', protocol: 3, text: log, query: 'q' }),
    j({ id: 5, op: 'compress', protocol: 4, text: log, query: 'q' }),
  ])
  assert.equal(replies[0].ok, true)
  assert.equal(replies[0].result.decision, undefined, 'no policy was sent, so no decision')
  assert.equal(replies[1].error, 'field_needs_protocol_2')
  assert.equal(replies[2].ok, true)
  assert.equal(replies[3].ok, true, 'protocol 3 is a live version')
  assert.equal(replies[4].error, 'bad_protocol')
})

test('redact_secrets: a planted credential never reaches the extract or the dropped summary; a fail-open returns the original', async () => {
  const text = log.replace('assertion at Foo.java:42', `assertion at Foo.java:42 token=${secret}`)
  const parts = { call: { name: 'bash', arguments: { command: 'npm test' } }, last_user: 'why did the build fail' }
  const { replies } = await run([
    j({ id: 1, ...v2, text, query_parts: parts }),
    j({ id: 2, ...v2, text: `INFO a\nERROR b ${secret}`, query: 'b' }),
    j({ id: 3, ...v2, redact_secrets: false, text, query_parts: parts }),
    j({ id: 4, ...v2, text: `x\n${secret}`, query: 'zzz' }),
  ])
  const redacted = replies[0].result
  assert.equal(redacted.decision.accept, true)
  assert.ok(!JSON.stringify(redacted).includes(secret), 'the secret is nowhere in the reply')
  assert.ok(redacted.text.includes('[tameru:redacted]'))
  assert.ok(redacted.text.includes('Foo.java:42'), 'the error line is still there')
  // the dropped locators are read from the original lines: a credential in one is redacted too
  assert.ok(!JSON.stringify(replies[1].result.dropped).includes(secret))
  assert.ok(replies[2].result.text.includes(secret), 'without the option the engine leaves it as it is')
  // documented limit: a fail-open hands back the original, unredacted (the host already holds it, and never acts on a decline)
  assert.equal(replies[3].result.fail_open, true)
  assert.ok(replies[3].result.text.includes(secret))
  assert.equal(replies[3].result.decision.accept, false)
})

test('the query is built by the engine from the pieces: tool identifiers survive a 2000-character Chinese message', async () => {
  const chinese = '请帮我看看为什么测试一直失败而且没有任何有用的错误信息。'.repeat(80).slice(0, 2000)
  const out = await py(`
import json
parts = {"call": {"name": "run_tests", "arguments": {"command": "pytest tests/test_auth.py -x", "cwd": "src/billing_service"}},
         "after": {"text": "I will look at test_auth.py", "calls": [{"name": "read_file", "arguments": {"path": "src/billing_service/auth_flow.py"}}]},
         "last_user": ${JSON.stringify(chinese)}, "first_user": ${JSON.stringify(`${chinese}。第二`)}}
query = run_worker.query_from_parts(parts)
print(json.dumps({"query": query, "n": len(query)}))
print(json.dumps(run_worker.query_from_parts({"last_user": "test_auth.py为什么失败"})))
`)
  const [first, second] = out.trim().split('\n').map(line => JSON.parse(line))
  assert.ok(first.n <= 2000)
  const query: string = first.query
  assert.ok(query.startsWith('run_tests'), 'the tool name comes first')
  for (const identifier of ['pytest tests/test_auth.py -x', 'src/billing_service', 'auth_flow.py']) assert.ok(query.includes(identifier), identifier)
  assert.ok(query.includes('请帮我看看'), 'the user message is there, after the call')
  assert.equal(second, 'test_auth.py 为什么失败', 'a Han run next to an identifier is split from it')
})

test('hostile input ends in an error reply or a decline within the budget, never a crash, and no reply repeats the request', async () => {
  const canary = 'CANARY7f3a'
  const nested = '['.repeat(200_000) + ']'.repeat(200_000)
  let deep: unknown = 'leaf'
  for (let i = 0; i < 3000; i++) deep = { a: deep }
  const manyPins = Array.from({ length: 40 }, (_, i) => ({ literal: `${canary}${i}` }))
  const requests: string[] = [
    // pin_patterns: backtracking-prone, oversized, too many, wrong shape, regexes at all (the worker takes literals only)
    j({ id: 1, ...v2, text: log, query: 'q', pin_patterns: [`(a+)+${canary}`] }),
    j({ id: 2, ...v2, text: log, query: 'q', pin_patterns: ['a*a*a*a*a*b'] }),
    j({ id: 3, ...v2, text: log, query: 'q', pin_patterns: [{ literal: canary.repeat(400) }] }),
    j({ id: 4, ...v2, text: log, query: 'q', pin_patterns: manyPins }),
    j({ id: 5, ...v2, text: log, query: 'q', pin_patterns: canary }),
    j({ id: 6, ...v2, text: log, query: 'q', pin_patterns: [{ literal: canary, extra: 1 }] }),
    j({ id: 7, ...v2, text: log, query: 'q', pin_patterns: ['(?P<n>x)(?P=n)'] }),
    // unknown and mistyped fields
    j({ id: 8, ...v2, text: log, query: 'q', [canary]: 1 }),
    j({ id: 9, ...v2, text: log, query: 'q', ccr: true }),
    j({ id: 10, ...v2, text: log, query: 'q', preset: canary }),
    j({ id: 11, ...v2, text: log, query: 'q', content_hint: canary }),
    j({ id: 12, ...v2, text: log, query: 5 }),
    j({ id: 13, ...v2, text: [canary] }),
    j({ id: 14, ...v2, text: log, query: 'q', redact_secrets: canary }),
    // the plugin's own fields
    j({ id: 15, ...v2, text: log, query: 'q', policy: { min_confidence: 10 ** 400 } }),
    j({ id: 16, ...v2, text: log, query: 'q', policy: { [canary]: 1 } }),
    j({ id: 17, ...v2, text: log, query: 'q', policy: 'x' }),
    j({ id: 18, ...v2, text: log, query: 'q', query_parts: { call: { name: 'x' } } }),
    j({ id: 19, ...v2, text: log, query_parts: { [canary]: 1 } }),
    j({ id: 20, ...v2, text: log, query_parts: { last_user: canary.repeat(20_000) } }),
    j({ id: 21, ...v2, text: log, query_parts: { call: { name: canary, arguments: 5 } } }),
    j({ id: 22, ...v2, text: log, query_parts: { after: { text: 'x', calls: Array.from({ length: 50 }, () => ({ name: canary })) } } }),
    j({ id: 23, ...v2, text: log, query_parts: { call: { name: 'x', arguments: deep } } }),
    // out-of-range numbers and deep or broken JSON
    `{"id":24,"op":"compress","text":"x","budget_ratio":1e999}`,
    `{"id":25,"op":"compress","text":"x","query":"${canary}","pin_recent":${'9'.repeat(5000)}}`,
    `{"id":26,"op":"compress","text":"x","extra":${nested}}`,
    `{"id":27,"op":"${canary}"}`,
    `[${nested}]`,
    '{"id":28,"op":"compress","text":"x"',
    j({ id: 29, op: 'ping' }),
  ]
  const { replies, code, ms } = await run(requests)
  assert.equal(code, 0, 'the worker stayed up to the end of its input')
  assert.ok(ms < 4000 * 2, `the whole run took ${ms} ms`)
  assert.equal(replies.at(-1).id, 29)
  assert.equal(replies.at(-1).ok, true, 'the last ping was answered')
  for (const reply of replies) {
    if (reply.ok === true) continue
    assert.equal(typeof reply.error, 'string')
    assert.ok(!reply.error.includes(canary), `an error reply repeated the request: ${reply.error}`)
    assert.match(reply.error, /^[a-z0-9_]+(:[A-Za-z]+)?$/, 'a fixed code, optionally with an exception type name')
  }
  const errorOf = (id: number): unknown => replies.find(r => r.id === id)?.error
  for (const id of [1, 2, 3, 4, 5, 6, 7]) assert.equal(errorOf(id), 'bad_pin_patterns', `pin request ${id}`)
  assert.equal(errorOf(8), 'unknown_field')
  assert.equal(errorOf(9), 'unknown_field')
  assert.equal(errorOf(10), 'bad_preset')
  assert.equal(errorOf(15), 'bad_policy')
  assert.equal(errorOf(18), 'query_and_parts')
  assert.equal(errorOf(19), 'bad_query_parts')
  assert.equal(errorOf(20), 'bad_query_parts')
  assert.equal(errorOf(22), 'bad_query_parts')
})

test('literal pins are accepted and honoured', async () => {
  const { replies } = await run([j({ id: 1, ...v2, text: log, query: 'why did the build fail', pin_patterns: [{ literal: 'INFO routine line 7 nothing' }] })])
  assert.equal(replies[0].ok, true)
})

test('an exception inside the engine becomes an error reply with the exception type only', async () => {
  const out = await py(`
import json
import sys
import tameru.compress_context  # the package re-exports a function under this name, so patch the module itself
module = sys.modules['tameru.compress_context']
def boom(*args, **kwargs):
    raise ValueError("CANARY the request text must not be repeated")
module.compress_context = boom
_ident, reply, stop = run_worker.handle({"id": 7, "op": "compress", "text": "some text CANARY", "query": "q"})
print(json.dumps(reply))
`)
  assert.deepEqual(JSON.parse(out), { id: 7, ok: false, error: 'engine_error:ValueError' })
})

test('anchor_errors on a million characters stays inside the per-request deadline', async () => {
  const code = Array.from({ length: 14_000 }, (_, i) => `def func_${i}(x):\n    return x * ${i}  # value number ${i} for the pipeline stage`)
  code.splice(7000, 0, 'ERROR build failed: assertion at Foo.java:42 expected 3 but was 4')
  const text = code.join('\n')
  assert.ok(text.length > 1_000_000)
  const request = { ...v2, text, query_parts: { call: { name: 'bash', arguments: { command: 'make' } }, last_user: 'why does the build fail' } }
  const { replies, ms } = await run([j({ id: 1, ...request }), j({ id: 2, ...request, anchor_errors: false })])
  assert.equal(replies[0].ok, true)
  // In production each request's deadline is 4000 ms + text.length/50 (~27 s here), so even two
  // sequential calls at this ceiling keep a wide margin. The current engine's quote/comment-aware
  // supersession lexer is more expensive on 14K-unique-symbol input than the previously vendored
  // revision (~14.8 s for the pair locally); keep the lower ceiling as a blowup guard, not as the
  // production deadline.
  assert.ok(ms < 18_000, `both calls together took ${ms} ms; each production request has a ~27 s allowance`)
})
