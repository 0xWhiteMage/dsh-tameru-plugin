import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runCommand } from '../src/host/commands.ts'
import { MAX_PINS, MAX_PIN_CHARS, clean, filePins, memoryPins, pinsSection, refusal } from '../src/host/pins.ts'
import { statusText } from '../src/host/status.ts'
import { chatStatsOf } from '../src/host/step.ts'
import { apply, inject, name } from '../src/host/index.ts'
import { findPython } from '../src/host/python.ts'
import { load, skip, world } from './helpers/harness.ts'

const dir = (): string => mkdtempSync(join(tmpdir(), 'tameru-pins-'))

test('a pin is one clean line of at most 300 characters, never a duplicate, at most five', () => {
  const pins = memoryPins()
  assert.deepEqual(pins.add('c', '  never touch\tthe production\nconfig  '), { ok: true, pins: ['never touch the production config'] })
  assert.equal(pins.add('c', 'never touch the production config').ok, false, 'duplicate')
  assert.equal(pins.add('c', '   ').ok, false, 'empty')
  assert.equal(pins.add('c', 'x'.repeat(MAX_PIN_CHARS + 1)).ok, false, 'too long')
  for (let i = 0; i < MAX_PINS - 1; i++) assert.ok(pins.add('c', `rule ${i}`).ok)
  assert.equal(pins.add('c', 'one more').ok, false, 'a sixth pin')
  assert.equal(pins.list('other').length, 0, 'chats are separate')
  assert.equal(clean('a b c\u0007d'), 'a b c d', 'line separators and control characters become spaces')
})

test('lines that look like credentials are refused, ordinary text is not', () => {
  for (const secret of ['use sk-abcdefghijklmnop1234 for it', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'AKIAABCDEFGHIJKLMNOP', 'password = hunter2hunter2', 'token: abcdefgh12345678', 'xoxb-1234567890-abcdef', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmn']) assert.ok(refusal(secret), secret)
  for (const fine of ['never touch the production config', 'use the staging database, db-eu-staging', 'answer in Japanese', 'the token limit is 8000 per request']) assert.equal(refusal(fine), undefined, fine)
})

test('pins in a file persist across instances, survive damage, and leave nothing else behind', () => {
  const folder = dir()
  try {
    const first = filePins(join(folder, 'tameru'))
    assert.ok(first.add('chat-1', 'rule one').ok && first.add('chat-1', 'rule two').ok && first.add('chat-2', 'other').ok)
    const second = filePins(join(folder, 'tameru'))
    assert.deepEqual(second.list('chat-1'), ['rule one', 'rule two'])
    assert.deepEqual(readdirSync(join(folder, 'tameru')), ['pins.json'], 'no temporary file is left')
    assert.ok(second.remove('chat-1', 1).ok)
    assert.deepEqual(filePins(join(folder, 'tameru')).list('chat-1'), ['rule two'])
    assert.equal(second.remove('chat-1', 9).ok, false)
    writeFileSync(join(folder, 'tameru', 'pins.json'), '{ this is not json', 'utf8')
    assert.deepEqual(filePins(join(folder, 'tameru')).list('chat-1'), [], 'a damaged file reads as empty')
    assert.ok(filePins(join(folder, 'tameru')).add('chat-1', 'fresh start').ok, 'and can be written again')
    filePins(join(folder, 'tameru')).purge()
    assert.deepEqual(JSON.parse(readFileSync(join(folder, 'tameru', 'pins.json'), 'utf8')).chats, {})
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('a folder that cannot be written gives an error message, not an exception', () => {
  const folder = dir()
  try {
    writeFileSync(join(folder, 'blocker'), 'a file where a folder is needed')
    const result = filePins(join(folder, 'blocker', 'inside')).add('c', 'rule')
    assert.ok(!result.ok && /Could not save the pins/.test(result.reason))
    assert.ok(!existsSync(join(folder, 'blocker', 'inside')))
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('the prompt section is the user\'s lines, numbered, and empty when there are none', () => {
  assert.equal(pinsSection([]), '')
  const text = pinsSection(['never touch the production config', 'use {{db}} for staging'])
  assert.match(text, /^## Pinned by the user \(Tameru\)/)
  assert.ok(text.includes('1. never touch the production config') && text.includes('2. use {{db}} for staging'), '{{...}} is kept literally')
})

test('the pin commands: add, list, remove, purge, and what a bad request says', () => {
  const pins = memoryPins()
  const w = { id: 'chat-9' } as never
  const env = { session: w, meter: undefined, stats: chatStatsOf(new WeakMap(), w), pins, status: () => 'STATUS' }
  assert.match(runCommand('pin Never touch the production config', env).text, /Pinned \(1 of 5\)[\s\S]*1\. Never touch the production config/)
  assert.equal(runCommand('pin', env).kind, 'error')
  assert.equal(runCommand('pin sk-abcdefghijklmnop1234', env).kind, 'error')
  assert.match(runCommand('pins', env).text, /^1\. Never touch/)
  assert.equal(runCommand('unpin 7', env).kind, 'error')
  assert.equal(runCommand('unpin x', env).kind, 'error')
  assert.match(runCommand('unpin 1', env).text, /^Removed\./)
  assert.match(runCommand('pins', env).text, /No pins in this chat/)
  runCommand('pin keep me', env)
  assert.match(runCommand('purge', env).text, /forgot the pins/)
  assert.deepEqual(pins.list('chat-9'), [])
  assert.equal(runCommand('pin x', { ...env, pins: undefined }).kind, 'error')
})

test('the status text counts pins, with or without Python', () => {
  const base = { pluginVersion: '0.1.0', enabled: true, python: { path: 'p', source: 'setting' as const }, worker: undefined, pins: 2 }
  assert.match(statusText(base), /2 pinned lines in this chat/)
  assert.match(statusText({ ...base, python: undefined, pins: 1 }), /pins and the Artifact Trail still work[\s\S]*1 pinned line in this chat/)
})

test('through the real prompt assembler a pin reaches the system prompt verbatim, per chat, and curly braces cannot break assembly', { skip }, async () => {
  const w = await world()
  const folder = dir()
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = folder
  try {
    const { LocalSubprocessRuntime } = await load('@deepseek-ai/dsh-subprocess-local')
    w.ctx.plugin(LocalSubprocessRuntime)
    w.ctx.plugin(await load('@deepseek-ai/dsh-tool-executor-native'))
    const registered: Array<{ name: string; handler: (call: unknown) => Promise<{ kind: string; text: string }> }> = []
    w.ctx.provide('commands')
    w.ctx.set('commands', { register: (definition: never) => registered.push(definition) })
    w.ctx.plugin({ name, inject, apply }, { pythonPath: findPython()?.path ?? 'python' })
    await new Promise(resolve => setTimeout(resolve, 150))
    const session = w.session as unknown as { id: string }
    const agent = { id: 'a1', session: w.session, ctx: w.ctx }
    const handler = registered[0]!.handler
    assert.equal((await handler({ agent, rawInput: 'pin Use {{staging_db}} and never touch production' })).kind, 'success')
    const assemble = async (target: unknown) => w.ctx.systemPrompt.assemble({ agent: target, scope: target, modelSelection: { provider: 'p', model: 'm' }, toolSet: undefined })
    const assembly = await assemble(agent)
    const section = (assembly.sections as Array<{ name: string; text: string }>).find(s => s.name === 'tameru:pins')
    assert.ok(section, 'the section is part of the prompt')
    assert.ok(section.text.includes('1. Use {{staging_db}} and never touch production'), 'verbatim, braces included')
    const other = { id: 'a2', session: { id: 'someone-else' }, ctx: w.ctx }
    const none = (await assemble(other)).sections.find((s: { name: string }) => s.name === 'tameru:pins')
    assert.equal(none?.text ?? '', '', 'another chat has no pin')
    assert.ok(session.id)
    assert.deepEqual(JSON.parse(readFileSync(join(folder, 'tameru', 'pins.json'), 'utf8')).chats[session.id].pins, ['Use {{staging_db}} and never touch production'])
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    await w.ctx.fiber.dispose()
    rmSync(folder, { recursive: true, force: true })
  }
})
