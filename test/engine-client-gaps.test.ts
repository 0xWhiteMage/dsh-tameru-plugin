import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { EngineClient, type WorkerProcess } from '../src/host/engine-client.ts'
import { harnessWorkerSpawn, LineSplitter } from '../src/host/process.ts'
import { fromWireResult, fromWireVersion, toWire } from '../src/shared/protocol.ts'

test('wire requests contain only the permitted fields with false and zero preserved', () => {
  assert.deepEqual(toWire(4, { text: '' }), { id: 4, op: 'compress', text: '', query: '' })
  assert.deepEqual(toWire(5, { text: '日本語😀', query: 'why', mode: 'precision', budgetRatio: 1, pinRecent: 0, minSavingsRatio: 0, deriveQuery: false, secret: 'not sent' } as any), {
    id: 5, op: 'compress', text: '日本語😀', query: 'why', mode: 'precision', budget_ratio: 1, pin_recent: 0, min_savings_ratio: 0, derive_query: false,
  })
})

test('wire result readers reject missing required fields and default optional metadata', () => {
  for (const value of [{}, { text: '' }, { text: 1, fail_open: true }, { text: '', fail_open: 1 }]) assert.equal(fromWireResult(value), undefined)
  assert.deepEqual(fromWireResult({ text: '', fail_open: true, original_tokens: NaN, kept_tokens: Infinity, tokens_saved_pct: '3', reasons: ['kept', null, 4], sanitized: 1 }), {
    text: '', failOpen: true, originalTokens: 0, keptTokens: 0, tokensSavedPct: 0, risk: null, confidence: null, contentType: 'text', reasons: ['kept'], sanitized: false,
  })
  assert.equal(fromWireVersion({ engine_version: '1.9.0' }), undefined)
  assert.equal(fromWireVersion({ engine_version: 1, protocol: 1 }), undefined)
  assert.deepEqual(fromWireVersion({ engine_version: '1.9.0', protocol: 1 }), { engineVersion: '1.9.0', protocol: 1, python: '', vendoredFrom: null })
})

test('line splitting preserves UTF-8 across every byte boundary and ignores empty CRLF lines', () => {
  const splitter = new LineSplitter()
  const lines: string[] = []
  for (const byte of new TextEncoder().encode('\n\r\n日本語😀\r\nsecond\nunfinished')) splitter.push(Uint8Array.of(byte), line => lines.push(line))
  assert.deepEqual(lines, ['日本語😀', 'second'])
  splitter.push('\n', line => lines.push(line))
  assert.deepEqual(lines, ['日本語😀', 'second', 'unfinished'])
})

for (const web of [false, true]) {
  test(`managed subprocess ${web ? 'Web' : 'Node'} stream uses isolation flags, frames requests and handles exit`, async () => {
    const node = new PassThrough()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const stdout = web ? new ReadableStream<Uint8Array>({ start(value) { controller = value } }) : node
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })
    const writes: string[] = []
    let terminations = 0
    const abort = new AbortController()
    const worker = await harnessWorkerSpawn({ spawn(request) {
      assert.deepEqual(request, { argv: ['/python', '-I', '-B', '-P', '/vendor/run_worker.py'], cwd: '/work', stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' }, graceMs: 2000, signal: abort.signal })
      return { stdin: { write(chunk) { writes.push(chunk) } }, stdout, done, terminate() { terminations++; return Promise.reject(new Error('already dead')) } }
    } }, '/python', '/vendor/run_worker.py', '/work', abort.signal)()
    const lines: string[] = []
    worker.onLine(line => lines.push(line))
    let exits = 0
    worker.onExit(() => exits++)
    worker.send('{"op":"ping"}')
    assert.deepEqual(writes, ['{"op":"ping"}\n'])
    const bytes = new TextEncoder().encode('日本語😀\r\n')
    for (const chunk of [bytes.slice(0, 2), bytes.slice(2)]) {
      if (web) controller!.enqueue(chunk)
      else node.write(chunk)
    }
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(lines, ['日本語😀'])
    if (web) controller!.close()
    else node.end()
    finish()
    await done
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(exits, 1)
    worker.onExit(() => exits++)
    assert.equal(exits, 2, 'a listener registered after exit is notified')
    worker.kill()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(terminations, 1)
  })
}

test('disposing during asynchronous startup reaps the worker and does not send queued requests', async () => {
  let started!: () => void
  const starting = new Promise<void>(resolve => { started = resolve })
  let supply!: (worker: WorkerProcess) => void
  const spawn = new Promise<WorkerProcess>(resolve => { supply = resolve })
  let killed = 0
  const client = new EngineClient(() => { started(); return spawn })
  const first = client.compress({ text: 'one' })
  const second = client.compress({ text: 'two' })
  await starting
  await client.dispose()
  supply({ send() { assert.fail('disposed worker must not receive requests') }, onLine() {}, onExit() {}, kill() { killed++ } })
  assert.deepEqual(await Promise.all([first, second]), [undefined, undefined])
  assert.equal(killed, 1)
  client.reset()
  assert.equal(await client.probe(), undefined)
  assert.equal(client.status().state, 'disabled')
})
