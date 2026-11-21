// `policy: 'plan'`'s `stub` must be byte-identical to the Harness's own tool-result pruner. These compare src/host/stub.ts
// against the real `dsh-compaction-tool-result-pruner` (extracted into dev/harness), on fixtures and on a live session.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PRUNE_MARKER, STOCK_PRUNE_DEFAULTS, codePointLength, measureContent, pruneContent, stockKeptChars } from '../src/host/stub.ts'
import { bigOutput, skip, world } from './helpers/harness.ts'
import { textOnly } from '../src/host/messages.ts'

const prunerOf = (w: Awaited<ReturnType<typeof world>>): any => (w.ctx as any).toolResultPruner ?? (w.ctx as any).get('toolResultPruner')

test('the stub constants are the stock pruner\'s own', () => {
  assert.equal(PRUNE_MARKER, '\n\n[... tool result middle pruned ...]\n\n')
  assert.deepEqual(STOCK_PRUNE_DEFAULTS, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
})

test('pruneContent is byte-identical to the real pruner\'s, on every fixture shape', { skip }, async () => {
  const w = await world()
  const stock = prunerOf(w)
  assert.ok(stock, 'the world loads the real tool-result pruner')
  const fixtures: Array<{ name: string; blocks: Array<Record<string, unknown>> }> = [
    { name: 'plain long text', blocks: [{ type: 'text', text: bigOutput('a', 20_000) }] },
    { name: 'just over the threshold', blocks: [{ type: 'text', text: 'x'.repeat(8193) }] },
    { name: 'exactly at the threshold', blocks: [{ type: 'text', text: 'x'.repeat(8192) }] },
    { name: 'under the threshold', blocks: [{ type: 'text', text: 'x'.repeat(100) }] },
    { name: 'several text blocks', blocks: [{ type: 'text', text: 'y'.repeat(5000) }, { type: 'text', text: 'z'.repeat(6000) }] },
    // the removed span starts inside the second block: head fills the first, tail lives in the second
    { name: 'head crosses a block', blocks: [{ type: 'text', text: 'a'.repeat(3000) }, { type: 'text', text: 'b'.repeat(8000) }] },
    // astral characters at the slice boundaries: code points must be kept whole
    { name: 'surrogate pairs at the cut', blocks: [{ type: 'text', text: `${'p'.repeat(4090)}💡🔥🚀✂️📌${'q'.repeat(6000)}` }] },
    { name: 'non-text blocks kept', blocks: [{ type: 'image', data: 'AAAA' }, { type: 'text', text: bigOutput('img', 15_000) }, { type: 'file', name: 'x.png' }] },
    // a block that ends exactly where the removed span ends
    { name: 'block ends at removed end', blocks: [{ type: 'text', text: 'a'.repeat(7168) }, { type: 'text', text: 'b'.repeat(2000) }] },
    // a middle block entirely inside the removed span
    { name: 'a whole block removed', blocks: [{ type: 'text', text: 'a'.repeat(3000) }, { type: 'text', text: 'b'.repeat(3000) }, { type: 'text', text: 'c'.repeat(3000) }] },
    // empty and whitespace text blocks around a long one
    { name: 'empty blocks', blocks: [{ type: 'text', text: '' }, { type: 'text', text: bigOutput('e', 9000) }, { type: 'text', text: ' ' }] },
  ]
  for (const { name, blocks } of fixtures) {
    const expected = stock.pruneContent(blocks)
    const actual = pruneContent(blocks, STOCK_PRUNE_DEFAULTS)
    assert.deepEqual(actual, expected === null ? null : JSON.parse(JSON.stringify(expected)), name)
    assert.equal(measureContent(blocks), stock.measureContent(blocks), `${name}: measure`)
    if (expected !== null) assert.ok(measureContent(actual!) <= STOCK_PRUNE_DEFAULTS.thresholdChars, `${name}: within threshold`)
  }
  // a session cut by the real pruner equals the same session cut by the stub, event for event
  const w2 = await world()
  w2.step({ name: 'bash', args: { command: 'run 1' } }, bigOutput('one', 30_000))
  w2.step({ name: 'bash', args: { command: 'run 2' } }, 'short output')
  w2.step({ name: 'bash', args: { command: 'run 3' } }, bigOutput('three', 12_000))
  const before = new Map<number, any>()
  for (const seq of w2.session.surface.nodes) {
    const event = w2.session.eventAt(seq)!
    if (event.type === 'tool/result') before.set(seq, w2.session.deriveEventMessage(event))
  }
  const stockPruned = prunerOf(w2).pruneSession(w2.session)
  assert.equal(stockPruned.pruned.length, 2, 'stock cut the two over-threshold results')
  for (const { originalSeq, replacementSeq } of stockPruned.pruned) {
    const original = before.get(originalSeq)!
    const expectedContent = pruneContent(original.content, STOCK_PRUNE_DEFAULTS)
    const replacement = w2.session.deriveEventMessage(w2.session.eventAt(replacementSeq)!)!
    assert.deepEqual(replacement.content, expectedContent, `seq ${originalSeq}: content is the stub`)
    // the message is the original with only its content replaced
    const { content, ...rest } = replacement as Record<string, unknown>
    const { content: originalContent, ...originalRest } = original as Record<string, unknown>
    assert.deepEqual(rest, originalRest, `seq ${originalSeq}: every other field is the original's`)
    assert.ok((textOnly(replacement) ?? '').includes('[... tool result middle pruned ...]'), `seq ${originalSeq}: the marker is there`)
  }
  await w2.ctx.fiber.dispose()
  await w.ctx.fiber.dispose()
})

test('stockKeptChars is what the real pruner leaves of a cut result', { skip }, async () => {
  const w = await world()
  const stock = prunerOf(w)
  const pruned = stock.pruneContent([{ type: 'text', text: bigOutput('kept', 50_000) }])
  assert.equal(measureContent(pruned), stockKeptChars(STOCK_PRUNE_DEFAULTS))
  assert.equal(stockKeptChars(), STOCK_PRUNE_DEFAULTS.headChars + codePointLength('\n\n[... tool result middle pruned ...]\n\n') + STOCK_PRUNE_DEFAULTS.tailChars)
  await w.ctx.fiber.dispose()
})
