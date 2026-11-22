import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LATE, within } from '../src/host/shorten.ts'

const never = (): Promise<string> => new Promise(() => {})

test('a worker reply in time is passed through, a rejection counts as no answer', async () => {
  assert.equal(await within(Promise.resolve('ok'), 1000), 'ok')
  assert.equal(await within(Promise.reject(new Error('down')), 1000), undefined)
})

test('a worker that does not reply within the budget ends the wait at the budget', async () => {
  const started = Date.now()
  assert.equal(await within(never(), 50), LATE)
  assert.ok(Date.now() - started < 1000)
  assert.equal(await within(never(), 0), LATE, 'no budget left: no wait at all')
})

test('an abort ends the wait at once, and a reply after it is dropped', async () => {
  const controller = new AbortController()
  let reply!: (value: string) => void
  const pending = within(new Promise<string>(resolve => { reply = resolve }), 10_000, controller.signal)
  controller.abort()
  reply('late')
  assert.equal(await pending, LATE)
  assert.equal(await within(Promise.resolve('ok'), 1000, controller.signal), LATE, 'already aborted')
})
