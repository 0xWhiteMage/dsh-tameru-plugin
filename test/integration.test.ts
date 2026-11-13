// The whole plugin on the real Cordis event bus: mounted beside the Harness's real session, token meter and managed-subprocess services,
// with an `agent/pre-step` waterfall fired the way the agent loop fires it. Only the model-facing services are stubbed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, inject, name } from '../src/host/index.ts'
import { findPython } from '../src/host/python.ts'
import { alreadyShortened, textOnly } from '../src/host/messages.ts'
import { bigOutput, load, skip, world } from './helpers/harness.ts'

const python = findPython()?.path ?? process.env.TAMERU_TEST_PYTHON ?? 'python'

/** Fire the event the way the agent loop does: a carrier first, the payload, and a terminal that admits the step. */
const waterfall = (ctx: any, agent: unknown): Promise<unknown> =>
  ctx.waterfall(ctx, 'agent/pre-step', { agent, signal: new AbortController().signal, messages: [], step: 1 }, async () => ({ kind: 'enter', messages: [] }))

async function mounted(options: { backend?: any; contextWindow?: number } = {}) {
  const w = await world()
  const { LocalSubprocessRuntime } = await load('@deepseek-ai/dsh-subprocess-local')
  const { ctx } = w
  ctx.plugin(LocalSubprocessRuntime)
  const registered: any[] = []
  ctx.provide('commands')
  ctx.set('commands', { register: (definition: any) => registered.push(definition) })
  ctx.provide('llm')
  ctx.set('llm', { imageRequestPricing: () => undefined, resolveModelInfo: async () => ({ context: { contextWindow: options.contextWindow ?? 128_000 }, defaultMaxTokens: 8000 }) })
  ctx.provide('compaction')
  ctx.set('compaction', options.backend ?? { config: { auto: true } })
  ctx.plugin({ name, inject, apply }, { pythonPath: python })
  await new Promise(resolve => setTimeout(resolve, 150))
  for (let i = 0; i < 8; i++) w.step({ name: 'bash', args: { command: `step ${i}` } }, bigOutput(`s${i}`))
  w.pendingCall({ name: 'bash', args: { command: 'npm test' } }, bigOutput('pending'))
  w.header(8000)
  const agent = { id: 'a1', session: w.session }
  const fire = async (): Promise<unknown> => {
    return waterfall(ctx, agent)
  }
  return { w, ctx, registered, agent, fire }
}

const shortened = (w: any): number => w.session.deriveMessages().filter((m: any) => m.role === 'tool' && alreadyShortened(textOnly(m) ?? '')).length

test('a pre-step waterfall shortens old large results through the real services and the step still proceeds', { skip }, async () => {
  const { w, ctx, registered, agent, fire } = await mounted()
  try {
    const before = w.meter.measure(w.session).surfaceTokens
    await fire()
    assert.ok(shortened(w) >= 1, 'results were shortened by the listener')
    assert.ok(w.meter.measure(w.session).surfaceTokens < before)
    // the unread pending result is untouched
    const messages = w.session.deriveMessages()
    assert.ok(!alreadyShortened(textOnly(messages.at(-1)) ?? ''))
    // /tameru now reports it
    const reply = await registered[0].handler({ agent })
    assert.match(reply.text, /In this chat: shortened \d+ tool results?/)
    assert.match(reply.text, /Engine 1\.9\.0/)
  } finally {
    await ctx.stop?.()
  }
})

test('a chat whose compaction another plugin manages is not touched by the waterfall', { skip }, async () => {
  const taken: any = { config: { auto: true } }
  taken.compactIfNeeded = () => null
  const { w, ctx, fire } = await mounted({ backend: taken })
  try {
    const seq = w.session.seq
    await fire()
    assert.equal(w.session.seq, seq)
    assert.equal(shortened(w), 0)
  } finally {
    await ctx.stop?.()
  }
})

test('below the activation point the waterfall changes nothing, and a second pass has nothing left to do', { skip }, async () => {
  const big = await mounted({ contextWindow: 1_000_000 })
  try {
    const seq = big.w.session.seq
    await big.fire()
    assert.equal(big.w.session.seq, seq)
  } finally {
    await big.ctx.stop?.()
  }
  const { w, ctx, fire } = await mounted()
  try {
    await fire()
    const seq = w.session.seq
    await fire()
    assert.equal(w.session.seq, seq, 'already shortened results are not shortened again')
  } finally {
    await ctx.stop?.()
  }
})

test('unloading the plugin stops listening: the waterfall no longer changes the session', { skip }, async () => {
  const w = await world()
  const { LocalSubprocessRuntime } = await load('@deepseek-ai/dsh-subprocess-local')
  const { ctx } = w
  ctx.plugin(LocalSubprocessRuntime)
  ctx.provide('commands')
  ctx.set('commands', { register: () => {} })
  ctx.provide('llm')
  ctx.set('llm', { imageRequestPricing: () => undefined, resolveModelInfo: async () => ({ context: { contextWindow: 128_000 }, defaultMaxTokens: 8000 }) })
  const fiber = ctx.plugin({ name, inject, apply }, { pythonPath: python })
  await new Promise(resolve => setTimeout(resolve, 150))
  for (let i = 0; i < 8; i++) w.step({ name: 'bash', args: {} }, bigOutput(`s${i}`))
  w.pendingCall({ name: 'bash', args: {} }, bigOutput('pending'))
  w.header(8000)
  fiber.dispose()
  const seq = w.session.seq
  await waterfall(ctx, { id: 'a', session: w.session })
  assert.equal(w.session.seq, seq)
  await ctx.stop?.()
})
