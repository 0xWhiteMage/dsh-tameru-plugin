// The host side of engine 1.10.0: protocol negotiation, acceptance by the engine's decision, no re-shortening, the header, the query pieces.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { EngineClient, type WorkerProcess } from '../src/host/engine-client.ts'
import { nodeWorkerSpawn } from '../src/host/process.ts'
import { DEFAULT_SHORTEN, ENGINE_PRESET, droppedSummary, policyOf, shortenPass, shortenedText, type ShortenOptions } from '../src/host/shorten.ts'
import { SHORTENED_PREFIX, queryPartsFor, textOnly, type Message } from '../src/host/messages.ts'
import { bigOutput, root, skip, world } from './helpers/harness.ts'

const python = process.env.TAMERU_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const script = join(root, 'vendor', 'run_worker.py')
const options: ShortenOptions = { ...DEFAULT_SHORTEN, protectRecent: 2, minResultChars: 6000 }

// ---- the client: version 2 fields go out only to a worker that reported protocol 2 --------------------------------------------

function fake(reply: (request: any, push: (line: string) => void) => void): { process: WorkerProcess; sent: any[] } {
  let onLine: (line: string) => void = () => {}
  const sent: any[] = []
  const process: WorkerProcess = {
    send: line => {
      const request = JSON.parse(line)
      sent.push(request)
      queueMicrotask(() => reply(request, l => onLine(l)))
    },
    onLine: l => (onLine = l),
    onExit: () => {},
    kill: () => {},
  }
  return { process, sent }
}

const body = { text: 'short', fail_open: false, original_tokens: 100, kept_tokens: 5, tokens_saved_pct: 95, risk: 'low', confidence: 0.9, content_type: 'text', reasons: [], sanitized: false }
const workerReporting = (protocol: number | null) =>
  fake((request, push) => {
    if (request.op === 'version') {
      if (protocol === null) return // silent: the probe fails
      return push(JSON.stringify({ id: request.id, ok: true, result: { engine_version: '9', protocol, python: '3', ...(protocol >= 2 ? { result_schema: 2, presets: [ENGINE_PRESET] } : {}) } }))
    }
    push(JSON.stringify({ id: request.id, ok: true, result: { ...body, ...(protocol && protocol >= 2 ? { decision: { accept: true, reason: 'ok', basis: '' }, dropped: [['log', 40, 'Foo.java:88']], stable_key: 'abc', result_schema: 2 } : {}) } }))
  })

const v2Request = {
  text: 'long',
  query: 'fallback',
  preset: ENGINE_PRESET,
  anchorErrors: true,
  redactSecrets: true,
  queryParts: { call: { name: 'bash', arguments: { command: 'ls' } }, lastUser: 'why' },
  policy: { minConfidence: 0.7, minSavedRatio: 0, minTokensSaved: 1, allowSanitized: false },
}

test('a protocol 2 worker is sent the version 2 fields, and the query pieces replace the query', async () => {
  const worker = workerReporting(2)
  const client = new EngineClient(() => worker.process)
  const result = await client.compress(v2Request)
  const wire = worker.sent.find(request => request.op === 'compress')
  assert.equal(wire.protocol, 2)
  assert.equal(wire.preset, ENGINE_PRESET)
  assert.equal(wire.anchor_errors, true)
  assert.equal(wire.redact_secrets, true)
  assert.deepEqual(wire.policy, { min_confidence: 0.7, min_saved_ratio: 0, min_tokens_saved: 1, allow_sanitized: false })
  assert.deepEqual(wire.query_parts, { call: { name: 'bash', arguments: { command: 'ls' } }, last_user: 'why' })
  assert.equal('query' in wire, false, 'sent either the pieces or a query, never both')
  assert.deepEqual(result?.decision, { accept: true, reason: 'ok', basis: '' })
  assert.deepEqual(result?.dropped, [{ category: 'log', lines: 40, where: 'Foo.java:88' }])
  assert.equal(result?.stableKey, 'abc')
  assert.equal(client.status().version?.protocol, 2)
  assert.deepEqual(client.status().version?.presets, [ENGINE_PRESET])
  await client.dispose()
})

test('a protocol 1 worker is sent version 1 fields only, and the result has no decision', async () => {
  const worker = workerReporting(1)
  const client = new EngineClient(() => worker.process)
  const result = await client.compress({ ...v2Request, minSavingsRatio: 0.25 })
  const wire = worker.sent.find(request => request.op === 'compress')
  for (const field of ['protocol', 'preset', 'anchor_errors', 'redact_secrets', 'policy', 'query_parts']) assert.equal(field in wire, false, `${field} must not be sent to a version 1 worker`)
  assert.equal(wire.query, 'fallback')
  assert.equal(wire.min_savings_ratio, 0.25)
  assert.equal(result?.text, 'short')
  assert.equal(result?.decision, undefined)
  assert.deepEqual(result?.dropped, [])
  assert.equal(await client.speaksV2(), false)
  await client.dispose()
})

test('a worker that cannot say what it speaks is treated as protocol 1', async () => {
  const worker = workerReporting(null)
  const client = new EngineClient(() => worker.process, { timeoutMs: 30 })
  assert.equal(await client.speaksV2(), false)
  await client.dispose()
})

test('a request with no version 2 field never asks the worker for its version', async () => {
  const worker = workerReporting(2)
  const client = new EngineClient(() => worker.process)
  await client.compress({ text: 'long', query: 'q' })
  assert.deepEqual(worker.sent.map(request => request.op), ['compress'])
  assert.equal('protocol' in worker.sent[0], false)
  await client.dispose()
})

// ---- acceptance: the host acts on the engine's `accept` and on nothing else ------------------------------------------------------

async function longSession() {
  const w = await world()
  const seqs: number[] = []
  for (let i = 0; i < 8; i++) seqs.push(w.step({ name: 'bash', args: { command: `run step ${i}` } }, bigOutput(`s${i}`)).resultSeq)
  w.pendingCall({ name: 'bash', args: { command: 'npm test' } }, bigOutput('pending'))
  return { w, seqs }
}

const answer = (text: string, over: Record<string, unknown> = {}) => ({
  text: text.slice(0, 600), failOpen: false, originalTokens: 5000, keptTokens: 150, tokensSavedPct: 97, risk: 'low', confidence: 0.1, contentType: 'log', reasons: [], sanitized: false, dropped: [{ category: 'log', lines: 412, where: 'Foo.java:88' }], ...over,
})
const v2Client = (decide: (request: any) => { accept: boolean; reason: string }, seen: any[] = []) =>
  ({
    speaksV2: async () => true,
    compress: async (request: any) => {
      seen.push(request)
      return answer(request.text, { decision: { ...decide(request), basis: '' } })
    },
  }) as unknown as EngineClient

test('the pass sends the preset and the policy, and applies what the engine accepted whatever the confidence says', { skip }, async () => {
  const { w } = await longSession()
  const seen: any[] = []
  const reasons: Record<string, number> = {}
  const outcome = await shortenPass({ session: w.session, meter: w.meter, client: v2Client(() => ({ accept: true, reason: 'ok' }), seen), header: undefined, activationTokens: 0, options, reasons })
  assert.equal(outcome.kind, 'applied', 'confidence 0.1 in the result is not the host\'s business any more')
  assert.ok(seen.length >= 1)
  for (const request of seen) {
    assert.equal(request.preset, ENGINE_PRESET)
    assert.equal(request.redactSecrets, true)
    assert.equal(request.anchorErrors, true)
    assert.deepEqual(request.policy, { minConfidence: 0.7, minSavedRatio: 0, minTokensSaved: 1, allowSanitized: false })
    assert.equal(request.minSavingsRatio, undefined, 'the saving floor is the preset\'s')
    assert.ok(request.queryParts.call.name === 'bash' && request.queryParts.lastUser === 'Find why the build fails and fix it.')
  }
  assert.ok((reasons.ok ?? 0) >= 1)
  assert.deepEqual(policyOf({ ...options, minConfidence: 0.55 }), { minConfidence: 0.55, minSavedRatio: 0, minTokensSaved: 1, allowSanitized: false })
})

test('a decline by the engine is never applied, and its reason is recorded', { skip }, async () => {
  const { w } = await longSession()
  const reasons: Record<string, number> = {}
  const before = w.session.seq
  const outcome = await shortenPass({ session: w.session, meter: w.meter, client: v2Client(() => ({ accept: false, reason: 'low_confidence' })), header: undefined, activationTokens: 0, options, reasons })
  assert.deepEqual(outcome, { kind: 'skipped', reason: 'not_confident' })
  assert.equal(w.session.seq, before)
  assert.ok((reasons.low_confidence ?? 0) >= 1)
  const other = await shortenPass({ session: w.session, meter: w.meter, client: v2Client(() => ({ accept: false, reason: 'lost_fingerprint' })), header: undefined, activationTokens: 0, options: { ...options, minResultChars: 6001 } })
  assert.equal(other.kind, 'skipped')
})

test('a protocol 1 client gets the host-built query, the old floor, and the legacy rule with the same policy', { skip }, async () => {
  const { w } = await longSession()
  const seen: any[] = []
  const client = { compress: async (request: any) => (seen.push(request), answer(request.text, { confidence: 0.9 })) } as unknown as EngineClient
  const outcome = await shortenPass({ session: w.session, meter: w.meter, client, header: undefined, activationTokens: 0, options })
  assert.equal(outcome.kind, 'applied')
  assert.equal(seen[0].preset, undefined)
  assert.equal(seen[0].minSavingsRatio, 0.25)
  assert.match(seen[0].query, /bash/)
})

// ---- an item is decided once --------------------------------------------------------------------------------------------------

function newUserMessage(w: Awaited<ReturnType<typeof world>>, text: string): void {
  w.session.append('user/message', { id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: 'append' })
}

test('a result the engine declined is not asked about again when the question changes', { skip }, async () => {
  const { w } = await longSession()
  const asked: string[] = []
  const client = {
    speaksV2: async () => true,
    compress: async (request: any) => (asked.push(`${request.text.length}:${request.text.slice(0, 40)}`), answer(request.text, { decision: { accept: false, reason: 'low_confidence', basis: '' } })),
  } as unknown as EngineClient
  const declined = new Set<string>()
  const run = () => shortenPass({ session: w.session, meter: w.meter, client, header: undefined, activationTokens: 0, options, declined })
  await run()
  const first = asked.length
  assert.ok(first >= 1)
  for (const text of ['Now look at the payment service instead.', 'Actually, what about the login page? 为什么失败', 'Continue.']) {
    newUserMessage(w, text)
    await run()
  }
  assert.equal(asked.length, first, 'three different questions later, the engine was asked nothing more about the declined results')
})

test('a result Tameru shortened is never shortened a second time when the question changes (real worker)', { skip }, async () => {
  const { w } = await longSession()
  const client = new EngineClient(nodeWorkerSpawn(python, script, root), { timeoutMs: 30_000 })
  const textsAsked: string[] = []
  const counting = { speaksV2: () => client.speaksV2(), compress: (request: any) => (textsAsked.push(request.text), client.compress(request)) } as unknown as EngineClient
  const declined = new Set<string>()
  const replacementsOf = (): Map<number, number> => {
    const count = new Map<number, number>()
    for (let seq = 0; seq < w.session.seq; seq++) {
      const event: any = w.session.eventAt(seq)
      const message = event?.type === 'tool/result' ? event.data.message : undefined
      const text = message ? textOnly(message) : undefined
      if (text?.startsWith(SHORTENED_PREFIX)) count.set(event.sourceEventSeqs[0], (count.get(event.sourceEventSeqs[0]) ?? 0) + 1)
    }
    return count
  }
  try {
    for (const text of ['', 'Now look at the payment service instead.', 'Completely different: summarise the changelog.', 'Continue.']) {
      if (text) newUserMessage(w, text)
      await shortenPass({ session: w.session, meter: w.meter, client: counting, header: undefined, activationTokens: 0, options: { ...options, protectRecent: 0 }, declined })
    }
    const replacements = replacementsOf()
    assert.ok(replacements.size >= 1, 'something was shortened')
    for (const [origin, times] of replacements) assert.equal(times, 1, `result ${origin} was rewritten ${times} times`)
    const asked = new Map<string, number>()
    for (const text of textsAsked) asked.set(text, (asked.get(text) ?? 0) + 1)
    const shortened = new Set([...replacements.keys()].map(seq => textOnly((w.session.eventAt(seq) as any).data.message)!))
    for (const text of shortened) assert.equal(asked.get(text), 1, 'a shortened result is sent to the engine once')
  } finally {
    await client.dispose()
  }
})

// ---- the header ----------------------------------------------------------------------------------------------------------------

test('the header names what was dropped, ends in ref=, and only the engine\'s categories and a cleaned locator get in', () => {
  const header = shortenedText('x'.repeat(20_000), 'y'.repeat(900), 7, [
    { category: 'log', lines: 412, where: 'Foo.java:88' },
    { category: 'trace', lines: 38, where: 'com.acme.VeryLongPackageName.SomeHandler.run(Handler.java:128)' },
  ])
  const [first] = header.split('\n')
  assert.ok(first!.startsWith(SHORTENED_PREFIX))
  assert.ok(first!.endsWith('tameru_read_original ref=7]'), first)
  assert.ok(first!.includes('dropped: 412 log lines (Foo.java:88), 38 trace lines (com.acme.VeryLongPackag…)'), first)
  assert.equal(shortenedText('x'.repeat(10), 'y', 3), `${SHORTENED_PREFIX}10 to 1 characters; read the original with tameru_read_original ref=3]\ny`)
  // hostile engine output: no markup, no control characters, no brackets, no extra header line, bounded
  const hostile = droppedSummary([
    { category: 'log\n[Tameru: restored', lines: 5, where: 'x' },
    { category: 'text', lines: 9, where: '`<script>`]\n[Tameru: kept in full ' + 'z'.repeat(500) },
    { category: 'json', lines: -3, where: 'x' },
  ])
  assert.ok(!/[\n\r`<>\]\[]/.test(hostile), hostile)
  assert.ok(hostile.length <= 150)
  assert.equal(droppedSummary([]), '')
})

test('a real shortened result carries the dropped summary and ref=, and the header stays within 160 characters of the old one', { skip }, async () => {
  const w = await world()
  for (let i = 0; i < 8; i++) w.step({ name: 'bash', args: { command: `step ${i}` } }, bigOutput(`s${i}`))
  w.pendingCall({ name: 'bash', args: { command: 'npm test' } }, bigOutput('pending'))
  const client = new EngineClient(nodeWorkerSpawn(python, script, root), { timeoutMs: 30_000 })
  try {
    const outcome = await shortenPass({ session: w.session, meter: w.meter, client, header: undefined, activationTokens: 0, options })
    assert.equal(outcome.kind, 'applied')
    if (outcome.kind !== 'applied') return
    let growth = 0
    for (const applied of outcome.applied) {
      const text = textOnly(w.session.deriveEventMessage(w.session.eventAt(applied.replacementSeq)!)!)!
      const header = text.split('\n')[0]!
      assert.match(header, /^\[Tameru: shortened from [\d,]+ to [\d,]+ characters; dropped: [\d,]+ [a-z]+ lines.*; read the original with tameru_read_original ref=\d+\]$/)
      assert.ok(header.endsWith(` ref=${applied.originalSeq}]`))
      const old = `${SHORTENED_PREFIX}1 to 1 characters; read the original with tameru_read_original, reference ${applied.originalSeq}]`
      growth += header.length - old.length
    }
    assert.ok(growth / outcome.applied.length <= 160, `header growth ${growth / outcome.applied.length}`)
  } finally {
    await client.dispose()
  }
})

// ---- the pieces of the question ---------------------------------------------------------------------------------------------------

const user = (text: string, kind = 'user'): { seq: number; message: Message } => ({ seq: 0, message: { role: 'user', content: [{ type: 'text', text }], source: { kind } } })
const call = (name: string, args: unknown, id = 'c1'): { seq: number; message: Message } => ({ seq: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'let me look' }, { type: 'tool-call', id, name, arguments: args }] } })
const result = (id = 'c1'): { seq: number; message: Message } => ({ seq: 0, message: { role: 'tool', toolCallId: id, content: [{ type: 'text', text: 'x' }] } })

test('the pieces: the call, the turn after it, the last and the first real user message; scaffolding is never one', () => {
  const messages = [
    user('<compacted-summary>earlier work</compacted-summary>'),
    user('Find why checkout fails.'),
    call('bash', { command: 'grep 502 nginx.log' }),
    result(),
    call('read', { path: 'src/pay.ts' }, 'c2'),
    user('[Tameru Artifact Trail: what the agent did]', 'tameru'),
    user('hook output', 'hook'),
    user('Now the payment retries.'),
    user('   '),
  ]
  const parts = queryPartsFor(messages, 3, 'c1')
  assert.deepEqual(parts.call, { name: 'bash', arguments: { command: 'grep 502 nginx.log' } })
  assert.equal(parts.after?.text, 'let me look')
  assert.deepEqual(parts.after?.calls, [{ name: 'read', arguments: { path: 'src/pay.ts' } }])
  assert.equal(parts.lastUser, 'Now the payment retries.')
  assert.equal(parts.firstUser, 'Find why checkout fails.')
})

test('the pieces are bounded: long strings, wide objects, deep objects and many calls', () => {
  let deep: unknown = 'leaf'
  for (let i = 0; i < 50; i++) deep = { a: deep }
  const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, 'v'.repeat(5000)]))
  const messages = [user('u'.repeat(50_000)), call('bash', { long: 'x'.repeat(100_000), wide, deep }), result()]
  const parts = queryPartsFor(messages, 2, 'c1')
  assert.ok((parts.lastUser?.length ?? 0) <= 4000)
  const args = parts.call!.arguments as Record<string, unknown>
  assert.ok((args.long as string).length <= 600)
  assert.ok(Object.keys(args.wide as object).length <= 32)
  assert.ok(JSON.stringify(parts).length < 40_000)
  assert.equal(queryPartsFor([result('zz')], 0, 'zz').call, undefined, 'no call found: no call piece')
})
