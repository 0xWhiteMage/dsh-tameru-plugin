import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { EngineClient } from '../src/host/engine-client.ts'
import { harnessWorkerSpawn } from '../src/host/process.ts'
import { findPython } from '../src/host/python.ts'
import { load, root, skip } from './helpers/harness.ts'

const python = findPython()?.path ?? process.env.TAMERU_TEST_PYTHON ?? 'python'

test('real managed worker recovers from a rejected request, then a process crash restarts it', { skip }, async () => {
  const { Context } = await load('@deepseek-ai/cordis')
  const { LocalSubprocessRuntime } = await load('@deepseek-ai/dsh-subprocess-local')
  const ctx = new Context()
  ctx.plugin(LocalSubprocessRuntime)
  await new Promise(resolve => setTimeout(resolve, 100))
  const handles: any[] = []
  const service = { spawn(request: any) {
    assert.deepEqual(request.argv.slice(1, 4), ['-I', '-B', '-P'])
    assert.equal(request.stdio.stderr, 'ignore')
    const handle = ctx.subprocess.spawn(request)
    handles.push(handle)
    return handle
  } }
  const client = new EngineClient(harnessWorkerSpawn(service, python, join(root, 'vendor', 'run_worker.py'), root), { timeoutMs: 5000 })
  try {
    assert.equal((await client.probe())?.protocol, 1)
    assert.equal(await client.compress({ text: '', mode: 'invalid' as any }), undefined)
    assert.equal(client.status().lastError, 'bad_mode')
    const empty = await client.compress({ text: '' })
    assert.equal(empty?.text, '')
    assert.equal(empty?.failOpen, false)
    assert.equal(handles.length, 1, 'validation errors do not replace a healthy worker')
    await handles[0].terminate()
    await handles[0].done
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(client.status().lastError, 'worker_exited')
    const unicode = await client.compress({ text: '短い出力😀' })
    assert.equal(unicode?.text, '短い出力😀')
    assert.equal(unicode?.sanitized, false)
    assert.equal(handles.length, 2)
  } finally {
    await client.dispose()
    await ctx.fiber.dispose()
  }
})
