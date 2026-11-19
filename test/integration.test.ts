// The whole plugin on the real Cordis event bus: mounted beside the Harness's real session, token meter and managed-subprocess services,
// with an `agent/pre-step` waterfall fired the way the agent loop fires it. Only the model-facing services are stubbed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, inject, name } from '../src/host/index.ts'
import { findPython } from '../src/host/python.ts'
import { alreadyShortened, textOnly } from '../src/host/messages.ts'
import { bigOutput, load, recordCompaction, skip, world } from './helpers/harness.ts'

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
  ctx.plugin({ name, inject, apply }, { pythonPath: python, policy: 'every-step' })
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
    assert.match(reply.text, /Engine 1\.10\.0 .*protocol 2/)
    assert.match(reply.text, /decisions in this chat: ok \d+/)
    // the model's way back is in the Harness's own tool registry, and the user's verbs work through the registered command
    assert.ok(ctx.tools.definitions().some((definition: { name: string }) => definition.name === 'tameru_read_original'))
    const changes = await registered[0].handler({ agent, rawInput: 'changes' })
    assert.match(changes.text, /Results Tameru shortened/)
    const ref = Number(/^\s*(\d+)/.exec(changes.text.split('\n')[1] ?? '')?.[1])
    assert.ok(Number.isInteger(ref))
    assert.match((await registered[0].handler({ agent, rawInput: `view ${ref}` })).text, /\[characters 0-3000 of \d+/)
  } finally {
    await ctx.fiber.dispose()
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
    await ctx.fiber.dispose()
  }
})

test('below the activation point the waterfall changes nothing, and a second pass has nothing left to do', { skip }, async () => {
  const big = await mounted({ contextWindow: 1_000_000 })
  try {
    const seq = big.w.session.seq
    await big.fire()
    assert.equal(big.w.session.seq, seq)
  } finally {
    await big.ctx.fiber.dispose()
  }
  const { w, ctx, fire } = await mounted()
  try {
    await fire()
    const seq = w.session.seq
    await fire()
    assert.equal(w.session.seq, seq, 'already shortened results are not shortened again')
  } finally {
    await ctx.fiber.dispose()
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
  await ctx.fiber.dispose()
})

test('after a compaction the pre-step decision carries the Artifact Trail once, and only when the step is admitted', { skip }, async () => {
  const { w, ctx, agent } = await mounted({ contextWindow: 1_000_000 })
  try {
    const prompt = { role: 'user', content: [{ type: 'text', text: 'go on' }] }
    const run = (kind: 'enter' | 'reject' | 'empty') =>
      ctx.waterfall(ctx, 'agent/pre-step', { agent, signal: new AbortController().signal, messages: [], step: 1 }, async () => (kind === 'reject' ? { kind } : { kind: 'enter', messages: kind === 'empty' ? [] : [prompt] }))
    assert.deepEqual(await run('enter'), { kind: 'enter', messages: [prompt] }, 'no compaction yet: nothing is added')
    recordCompaction(w, 1, 8)
    const rejected: any = await run('reject')
    assert.deepEqual(rejected, { kind: 'reject' }, 'a rejected step is left exactly as it is')
    assert.deepEqual(await run('empty'), { kind: 'enter', messages: [] }, 'an empty step means "nothing to run": the trail must not turn it into a model request')
    const admitted: any = await run('enter')
    assert.equal(admitted.messages.length, 2)
    assert.match(admitted.messages[1].content[0].text, /^\[Tameru Artifact Trail/)
    assert.equal(admitted.messages[1].source.kind, 'tameru')
    // the loop admits it into the chat; from then on nothing is owed
    w.session.append('user/message', admitted.messages[1], { surfaceOp: 'append' })
    assert.deepEqual(await run('enter'), { kind: 'enter', messages: [prompt] })
  } finally {
    await ctx.fiber.dispose()
  }
})

test('in a chat whose compaction another plugin manages, no trail is added', { skip }, async () => {
  const taken: any = { config: { auto: true } }
  taken.compactIfNeeded = () => null
  const { w, ctx, agent } = await mounted({ backend: taken, contextWindow: 1_000_000 })
  try {
    recordCompaction(w, 1, 8)
    const prompt = { role: 'user', content: [{ type: 'text', text: 'go on' }] }
    const decision = await ctx.waterfall(ctx, 'agent/pre-step', { agent, signal: new AbortController().signal, messages: [], step: 1 }, async () => ({ kind: 'enter', messages: [prompt] }))
    assert.deepEqual(decision, { kind: 'enter', messages: [prompt] })
  } finally {
    await ctx.fiber.dispose()
  }
})
