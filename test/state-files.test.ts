import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { filePins } from '../src/host/pins.ts'
import { readSaved, writeSaved } from '../src/host/saved-settings.ts'

const posix = process.platform !== 'win32'
const mode = (path: string): number => statSync(path).mode & 0o777

test('pins and settings are written readable by their owner only, in a folder only the owner can open', { skip: !posix && 'POSIX modes only' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'tameru-state-'))
  try {
    const folder = join(root, 'tameru')
    mkdirSync(folder, { mode: 0o755 })
    writeFileSync(join(folder, 'pins.json'), JSON.stringify({ version: 1, chats: {} }), { mode: 0o644 })
    assert.deepEqual(filePins(folder).add('chat', 'keep the schema'), { ok: true, pins: ['keep the schema'] })
    assert.equal(writeSaved(folder, { share: 0.5 }), undefined)
    assert.equal(mode(folder), 0o700)
    assert.equal(mode(join(folder, 'pins.json')), 0o600)
    assert.equal(mode(join(folder, 'settings.json')), 0o600)
    assert.deepEqual(readSaved(folder), { share: 0.5 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a leftover temporary file, even a link planted elsewhere, is replaced and never written through', { skip: !posix && 'symlinks need privileges on Windows' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'tameru-state-'))
  try {
    const folder = join(root, 'tameru')
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'untouched')
    mkdirSync(folder)
    symlinkSync(outside, join(folder, `pins.json.${process.pid}.tmp`))
    writeFileSync(join(folder, `settings.json.${process.pid}.tmp`), 'stale')
    assert.deepEqual(filePins(folder).add('chat', 'one'), { ok: true, pins: ['one'] })
    assert.equal(writeSaved(folder, { shorten: false }), undefined)
    assert.equal(readFileSync(outside, 'utf8'), 'untouched')
    assert.deepEqual(filePins(folder).list('chat'), ['one'])
    assert.deepEqual(readSaved(folder), { shorten: false })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an older version\'s readable files are closed on the first read, before any save', { skip: !posix && 'POSIX modes only' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'tameru-state-'))
  try {
    const folder = join(root, 'tameru')
    mkdirSync(folder, { mode: 0o755 })
    writeFileSync(join(folder, 'pins.json'), JSON.stringify({ version: 1, chats: { chat: { pins: ['old'], updated: 1 } } }), { mode: 0o644 })
    writeFileSync(join(folder, 'settings.json'), JSON.stringify({ version: 2, settings: { share: 0.5 } }), { mode: 0o644 })
    assert.deepEqual(filePins(folder).list('chat'), ['old'])
    assert.deepEqual(readSaved(folder), { share: 0.5 })
    assert.equal(mode(folder), 0o700)
    assert.equal(mode(join(folder, 'pins.json')), 0o600)
    assert.equal(mode(join(folder, 'settings.json')), 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a linked state file or folder is never read or written through', { skip: !posix && 'symlinks need privileges on Windows' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'tameru-state-'))
  try {
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'pins.json'), JSON.stringify({ version: 1, chats: { chat: { pins: ['planted'], updated: 1 } } }))
    const linkedFolder = join(root, 'linked')
    symlinkSync(elsewhere, linkedFolder)
    assert.deepEqual(filePins(linkedFolder).list('chat'), [], 'a linked folder reads as empty')
    assert.equal(filePins(linkedFolder).add('chat', 'x').ok, false, 'and is not written')
    assert.match(writeSaved(linkedFolder, { shorten: false }) ?? '', /not a folder/)
    const folder = join(root, 'tameru')
    mkdirSync(folder)
    symlinkSync(join(elsewhere, 'pins.json'), join(folder, 'pins.json'))
    assert.deepEqual(filePins(folder).list('chat'), [], 'a linked file reads as empty')
    assert.match(readFileSync(join(elsewhere, 'pins.json'), 'utf8'), /planted/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a FIFO in place of a state file is not opened, so the host never stalls on it', { skip: !posix && 'POSIX only' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'tameru-state-'))
  try {
    const folder = join(root, 'tameru')
    mkdirSync(folder)
    execFileSync('mkfifo', [join(folder, 'pins.json'), join(folder, 'settings.json')])
    assert.deepEqual(filePins(folder).list('chat'), [])
    assert.deepEqual(readSaved(folder), {})
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
