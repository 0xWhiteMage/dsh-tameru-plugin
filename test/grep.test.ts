// tameru_read_original gains `grep`: matching lines of the original with line numbers, bounded, and safe against hostile patterns.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { EngineClient } from '../src/host/engine-client.ts'
import { nodeWorkerSpawn } from '../src/host/process.ts'
import { DEFAULT_SHORTEN, shortenPass, type ShortenOptions } from '../src/host/shorten.ts'
import { grepOriginal, riskyPattern } from '../src/host/grep.ts'
import { listItems } from '../src/host/originals.ts'
import { readOriginalTool } from '../src/host/tool.ts'
import { textOnly } from '../src/host/messages.ts'
import { bigOutput, root, skip, world } from './helpers/harness.ts'

const python = process.env.TAMERU_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const options: ShortenOptions = { ...DEFAULT_SHORTEN, protectRecent: 2, minResultChars: 6000 }

async function shortenedChat() {
  const w = await world('Find why checkout fails.')
  for (let i = 0; i < 8; i++) w.step({ name: 'bash', args: { command: `step ${i}` } }, bigOutput(`s${i}`))
  w.pendingCall({ name: 'bash', args: { command: 'npm test' } }, bigOutput('pending'))
  const client = new EngineClient(nodeWorkerSpawn(python, join(root, 'vendor', 'run_worker.py'), root), { timeoutMs: 30_000 })
  const outcome = await shortenPass({ session: w.session, meter: w.meter, client, header: undefined, activationTokens: 0, options })
  assert.equal(outcome.kind, 'applied')
  await client.dispose()
  return { w, ref: listItems(w.session)[0]!.ref }
}

const original = (w: any, ref: number): string => textOnly(w.session.eventAt(ref).data.message)!

test('grep returns the matching lines of the original with their line numbers', { skip }, async () => {
  const { w, ref } = await shortenedChat()
  const lines = original(w, ref).split('\n')
  const errorLine = lines.findIndex(line => line.startsWith('ERROR'))
  const tool = readOriginalTool()
  const found = await tool.execute({ reference: ref, grep: 'assertion failed at module_' }, { agent: { session: w.session } })
  assert.ok(found.startsWith(`${errorLine + 1}: ERROR `), found)
  assert.match(found, /\[1 matching line of \d+\]$/)
  // case, literal text and the cap
  assert.match(await tool.execute({ reference: ref, grep: 'ASSERTION FAILED' }, { agent: { session: w.session } }), /\[0 matching lines of/)
  assert.match(await tool.execute({ reference: ref, grep: 'ASSERTION FAILED', ignore_case: true }, { agent: { session: w.session } }), /\[1 matching line of/)
  const literal = await tool.execute({ reference: ref, grep: 'module_s0.ts:', literal: true }, { agent: { session: w.session } })
  assert.match(literal, /^\d+: ERROR s0: /)
  const capped = await tool.execute({ reference: ref, grep: 'INFO', max_matches: 5 }, { agent: { session: w.session } })
  assert.equal(capped.split('\n\n')[0]!.split('\n').length, 5)
  assert.match(capped, /the first 5 are shown/)
  const regex = grepOriginal(w.session, ref, 'step (1|2)\\d* completed', {})
  assert.ok(regex.ok && regex.matches > 1 && regex.shown <= 50)
  // without grep the tool still reads windows
  assert.match(await tool.execute({ reference: ref, offset: 0, limit: 100 }, { agent: { session: w.session } }), /\[characters 0-100 of /)
})

test('grep reads only what Tameru shortened and refuses bad or dangerous patterns', { skip }, async () => {
  const { w, ref } = await shortenedChat()
  const tool = readOriginalTool()
  const exec = { agent: { session: w.session } }
  await assert.rejects(tool.execute({ reference: 0, grep: 'x' }, exec), /no result shortened by Tameru/)
  await assert.rejects(tool.execute({ reference: ref, grep: '' }, exec), /the pattern must be/)
  await assert.rejects(tool.execute({ reference: ref, grep: 'x'.repeat(121) }, exec), /the pattern must be/)
  await assert.rejects(tool.execute({ reference: ref, grep: '(' }, exec), /not a valid regular expression/)
  for (const risky of ['(a+)+$', '(.*a){20}', '(?:a|aa)+b', '(x)\\1', '(?=a)a', 'a*b*c*d*e*f']) {
    await assert.rejects(tool.execute({ reference: ref, grep: risky }, exec), /can run very long/, risky)
    assert.equal(riskyPattern(risky), true)
  }
  for (const fine of ['ERROR', 'step \\d+ completed', '^INFO .* nothing', 'a|b', '(foo|bar)', '[a-z]+\\.ts:\\d+']) assert.equal(riskyPattern(fine), false, fine)
  // a literal is never a risk, whatever it looks like
  const literal = await tool.execute({ reference: ref, grep: '(a+)+$', literal: true }, exec)
  assert.match(literal, /\[0 matching lines/)
})

test('the tool description tells the agent to re-read when the dropped list may hold what it needs, and names ref= and grep', () => {
  const tool = readOriginalTool()
  assert.match(tool.description, /dropped/)
  assert.match(tool.description, /read the original again/)
  assert.match(tool.description, /ref=/)
  assert.match(tool.description, /grep/)
  const properties = (tool.parameters as { properties: Record<string, unknown>; required: string[] }).properties
  for (const name of ['reference', 'grep', 'literal', 'ignore_case', 'max_matches', 'offset', 'limit']) assert.ok(name in properties, name)
})
