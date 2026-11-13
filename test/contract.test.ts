// Contract tests against the REAL Harness packages (Cordis and the subprocess provider), extracted by scripts/extract_harness.py
// into dev/harness. They are skipped when that folder is absent (for example in CI without a Harness install).
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { apply, inject, name } from '../src/host/index.ts'
import { EngineClient } from '../src/host/engine-client.ts'
import { harnessWorkerSpawn } from '../src/host/process.ts'
import { findPython } from '../src/host/python.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const modules = join(root, 'dev', 'harness', 'node_modules')
const available = existsSync(join(modules, '@deepseek-ai', 'cordis', 'lib', 'index.js'))
const skip = available ? false : 'run `python scripts/extract_harness.py` to extract the Harness packages'
const script = join(root, 'vendor', 'run_worker.py')
const python = findPython()?.path ?? process.env.TAMERU_TEST_PYTHON ?? 'python'

const load = (pkg: string): Promise<any> => import(pathToFileURL(join(modules, pkg, 'lib', 'index.js')).href)

async function harness(): Promise<{ ctx: any; handles: any[] }> {
  const { Context } = await load('@deepseek-ai/cordis')
  const { LocalSubprocessRuntime } = await load('@deepseek-ai/dsh-subprocess-local')
  const ctx = new Context()
  ctx.plugin((await load('@deepseek-ai/dsh-system-prompt')).default)
  ctx.plugin((await load('@deepseek-ai/dsh-tools')).default)
  ctx.plugin(LocalSubprocessRuntime)
  await new Promise(resolve => setTimeout(resolve, 100))
  const handles: any[] = []
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn = (request: unknown) => {
    const handle = spawn(request)
    handles.push(handle)
    return handle
  }
  return { ctx, handles }
}

const settled = (promise: Promise<unknown>, ms = 5000): Promise<boolean> =>
  Promise.race([promise.then(() => true, () => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), ms))])

test('the real subprocess service runs the worker, and dispose reaps it', { skip }, async () => {
  const { ctx, handles } = await harness()
  const client = new EngineClient(harnessWorkerSpawn(ctx.subprocess, python, script, root), { timeoutMs: 30_000 })
  try {
    const version = await client.probe()
    assert.equal(version?.engineVersion, '1.9.0')
    const text = [...Array.from({ length: 300 }, (_, i) => `INFO line ${i}`), 'ERROR failed at Foo.java:42', ...Array.from({ length: 200 }, (_, i) => `INFO tail ${i}`)].join('\n')
    const result = await client.compress({ text, query: 'why did it fail' })
    assert.ok(result && !result.failOpen && result.text.includes('Foo.java:42'))
    assert.equal(handles.length, 1)
  } finally {
    await client.dispose()
  }
  assert.equal(await settled(handles[0].done), true, 'the worker process ended after dispose')
  await ctx.fiber.dispose()
})

test('mounted as a Cordis plugin, the plugin registers one command, and unloading it reaps the worker', { skip }, async () => {
  const { ctx, handles } = await harness()
  const registered: any[] = []
  ctx.provide('commands')
  ctx.set('commands', { register: (definition: any) => registered.push(definition) })
  const fiber = ctx.plugin({ name, inject, apply }, { pythonPath: python })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(registered.map(c => c.name), ['tameru'])
  const reply = await registered[0].handler({})
  assert.equal(reply.kind, 'success')
  assert.match(reply.text, /Engine 1\.9\.0/)
  assert.equal(handles.length, 1)
  fiber.dispose()
  assert.equal(await settled(handles[0].done), true, 'unloading the plugin ended the worker')
  await ctx.fiber.dispose()
})
