import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { findPython } from '../src/host/python.ts'
import { statusText } from '../src/host/status.ts'
import { apply, inject, name, packageDir } from '../src/host/index.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('the manifest declares what the Harness reads, and nothing it does not need', () => {
  assert.equal(pkg.name, 'dsh-tameru')
  assert.ok(pkg.keywords.includes('dsh-plugin'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.manifestVersion, 1)
  assert.deepEqual(pkg.dsh.client, { platform: 'web' }, 'the browser half is declared')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.engines.dsh, readFileSync(join(root, 'DSH_PIN'), 'utf8').trim(), 'engines.dsh and DSH_PIN name the same tested version')
  assert.equal(pkg.license, 'Apache-2.0')
  assert.equal(pkg.dependencies, undefined, 'the host half has no runtime dependencies')
  for (const file of pkg.files) assert.ok(!file.startsWith('src'), 'source is not shipped')
  assert.ok(pkg.files.includes('!**/__pycache__/**') && pkg.files.includes('!**/*.pyc'), 'compiled Python never ships')
})

test('the patch inserts one row and disables, overrides or configures nothing else', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8').split('\n').filter(line => !line.trim().startsWith('#') && line.trim())
  assert.deepEqual(patch, ['- insert:', '    - id: tameru', '      name: dsh-tameru'])
})

test('the plugin name and entry id are prefixed and unique to us', () => {
  assert.equal(name, 'dsh-tameru')
  assert.deepEqual(inject, ['commands', 'subprocess', 'tools', 'systemPrompt', 'connection'])
})

test('locale files exist for en and zh with a title and description', () => {
  for (const lang of ['en', 'zh']) {
    const meta = JSON.parse(readFileSync(join(root, 'locale', `${lang}.json`), 'utf8')).meta
    assert.ok(meta.title && meta.description)
  }
})

test('packageDir finds this package from source and from a built file', () => {
  assert.equal(packageDir(join(root, 'src', 'host')), root)
  assert.equal(packageDir(join(root, 'lib')), root)
})

test('python is found from the setting, then the Harness runtime, and never as a bare name on Windows', () => {
  const exists = (set: string[]) => (path: string) => set.includes(path)
  const bundled = join('/dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
  const env = { DSH_HOME: '/dsh' }
  assert.deepEqual(findPython({ configured: '/x/python', env, platform: 'win32', exists: exists(['/x/python']) }), { path: '/x/python', source: 'setting' })
  assert.equal(findPython({ configured: '/missing', env, platform: 'win32', exists: exists([bundled]) }), undefined, 'a wrong setting is not silently replaced')
  assert.deepEqual(findPython({ env, platform: 'win32', exists: exists([bundled]) }), { path: bundled, source: 'harness-runtime' })
  assert.equal(findPython({ env, platform: 'win32', exists: exists([]) }), undefined)
  assert.deepEqual(findPython({ env, platform: 'linux', exists: exists([]) }), { path: 'python3', source: 'system' })
})

test('DSH_HOME is honoured and ~/.dsh is the default', () => {
  const exists = () => true
  const a = findPython({ env: { DSH_HOME: '/custom' }, platform: 'linux', exists })
  assert.ok(a?.path.startsWith('/custom') || a?.path.startsWith('\\custom'))
  const b = findPython({ env: {}, platform: 'linux', exists, home: () => '/home/u' })
  assert.ok(b?.path.includes('.dsh'))
})

test('the status text is honest in every state', () => {
  const base = { pluginVersion: '0.1.0', enabled: true, python: { path: '/p', source: 'setting' as const }, worker: undefined }
  assert.match(statusText({ ...base, enabled: false }), /behaves as stock/)
  assert.match(statusText({ ...base, python: undefined }), /no Python was found/)
  assert.match(statusText(base), /not started yet/)
  const version = { engineVersion: '1.9.0', vendoredFrom: 'a'.repeat(40), protocol: 1, python: '3.12.14' }
  assert.match(statusText({ ...base, worker: { state: 'running', version } }), /Engine 1\.9\.0 .*aaaaaaa.*Python 3\.12\.14/)
  assert.match(statusText({ ...base, worker: { state: 'disabled', lastError: 'timeout', version } }), /stopped after repeated failures \(timeout\).*stock/)
  assert.match(statusText({ ...base, worker: { state: 'running', lastError: 'bad_reply' } }), /original text is left as it is/)
})

function fakeCtx() {
  const registered: any[] = []
  const disposers: Array<() => void> = []
  return {
    registered,
    disposers,
    ctx: {
      commands: { register: (definition: any) => registered.push(definition) },
      subprocess: { spawn: () => assert.fail('the skeleton must not start a worker until /tameru asks') },
      effect: (setup: () => () => void) => disposers.push(setup()),
    },
  }
}

test('disabled means the plugin adds nothing at all', () => {
  const { ctx, registered, disposers } = fakeCtx()
  apply(ctx as any, { enabled: false })
  assert.equal(registered.length, 0)
  assert.equal(disposers.length, 0)
})

test('enabled adds one /tameru command, and nothing else is touched', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx as any, { pythonPath: join(root, 'does-not-exist') })
  assert.deepEqual(registered.map(c => c.name), ['tameru'])
  const reply = await registered[0].handler({})
  assert.equal(reply.kind, 'success')
  assert.match(reply.text, /no Python was found/)
})

test('the repository ships no source of other packages and keeps built output out of git', () => {
  assert.ok(readFileSync(join(root, '.gitignore'), 'utf8').includes('lib/'))
  assert.ok(existsSync(join(root, 'vendor', 'tameru', 'compress_context.py')))
  const top = readdirSync(root)
  for (const forbidden of ['.env', 'secrets.json', '.credentials.yaml']) assert.ok(!top.includes(forbidden))
})
