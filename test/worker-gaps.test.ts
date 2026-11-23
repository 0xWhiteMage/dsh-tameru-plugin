import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { WORKER_FLAGS } from '../src/host/process.ts'
import { root } from './helpers/harness.ts'

const python = process.env.TAMERU_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const script = join(root, 'vendor', 'run_worker.py')

function run(input: string | Buffer) {
  const child = spawnSync(python, [...WORKER_FLAGS, script], { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })
  assert.ifError(child.error)
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stderr, '')
  return child.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

test('worker validates every numeric and boolean option and recovers for the next request', () => {
  const cases: Array<[string, unknown]> = [
    ['query', null], ['budget_ratio', true], ['budget_ratio', 0], ['budget_ratio', '0.3'],
    ['min_savings_ratio', -0.1], ['min_savings_ratio', 1.1], ['min_savings_ratio', false],
    ['pin_recent', -1], ['pin_recent', 51], ['pin_recent', true],
    ['derive_query', 1], ['citations', 'false'],
  ]
  const replies = run([...cases.map(([field, value], id) => JSON.stringify({ id, op: 'compress', text: '', [field]: value })), '{"id":"alive","op":"ping"}'].join('\n'))
  assert.deepEqual(replies.slice(0, -1), cases.map(([field], id) => ({ id, ok: false, error: `bad_${field}` })))
  assert.deepEqual(replies.at(-1), { id: 'alive', ok: true, result: {} })
})

test('worker normalizes invalid ids, rejects nonobjects, and preserves string ids', () => {
  const inputs = [null, [], 5, 'ping', ...[true, {}, [], null, 'request-😀', 0].map(id => ({ id, op: 'ping' }))]
  const replies = run(inputs.map(value => JSON.stringify(value)).join('\n'))
  assert.deepEqual(replies.slice(0, 4), Array.from({ length: 4 }, () => ({ id: null, ok: false, error: 'bad_request' })))
  assert.deepEqual(replies.slice(4).map(reply => reply.id), [null, null, null, null, 'request-😀', 0])
  assert.ok(replies.slice(4).every(reply => reply.ok === true))
})

test('invalid UTF-8 and blank lines each get one error before a valid unterminated final request', () => {
  assert.deepEqual(run(Buffer.concat([Buffer.from([0xff, 0x0a]), Buffer.from('\n{"id":7,"op":"ping"}')])), [
    { id: null, ok: false, error: 'bad_json' },
    { id: null, ok: false, error: 'bad_json' },
    { id: 7, ok: true, result: {} },
  ])
})

test('empty output has a complete result contract and query-only surrogates are flagged', () => {
  const replies = run([
    { id: 1, op: 'compress', text: '', budget_ratio: 0.01, min_savings_ratio: 0, pin_recent: 0, derive_query: false, citations: false },
    { id: 2, op: 'compress', text: '', budget_ratio: 1, min_savings_ratio: 0.99, pin_recent: 50, query: '\ud800' },
  ].map(value => JSON.stringify(value)).join('\n'))
  assert.equal(replies.length, 2)
  for (const [index, reply] of replies.entries()) {
    assert.equal(reply.ok, true)
    assert.deepEqual(Object.keys(reply.result).sort(), ['text', 'fail_open', 'original_tokens', 'kept_tokens', 'tokens_saved_pct', 'risk', 'confidence', 'content_type', 'reasons', 'sanitized'].sort())
    assert.equal(reply.result.text, '')
    assert.equal(reply.result.fail_open, false)
    assert.equal(reply.result.original_tokens, 0)
    assert.equal(reply.result.kept_tokens, 0)
    assert.equal(reply.result.sanitized, index === 1)
    assert.ok(Array.isArray(reply.result.reasons))
  }
})

test('engine exceptions produce only a bounded error code and the worker remains usable', () => {
  const code = `
import sys
sys.path.insert(0, sys.argv[1])
import run_worker
import importlib
engine = importlib.import_module('tameru.compress_context')
def broken(*args, **kwargs):
    raise RuntimeError('PRIVATE INPUT MUST NOT LEAK')
engine.compress_context = broken
run_worker.main()
`
  const child = spawnSync(python, [...WORKER_FLAGS, '-c', code, join(root, 'vendor')], {
    input: '{"id":1,"op":"compress","text":"private"}\n{"id":2,"op":"ping"}\n', encoding: 'utf8', timeout: 30_000,
  })
  assert.ifError(child.error)
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stderr, '')
  assert.deepEqual(child.stdout.trim().split('\n').map(line => JSON.parse(line)), [
    { id: 1, ok: false, error: 'engine_error:RuntimeError' }, { id: 2, ok: true, result: {} },
  ])
})
