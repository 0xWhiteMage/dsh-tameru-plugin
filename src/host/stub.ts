/**
 * The Harness's own tool-result pruner's cut, replicated exactly so a `plan` stub is byte-identical to what
 * `@deepseek-ai/dsh-compaction-tool-result-pruner` would write. Source: dev/harness
 * node_modules/@deepseek-ai/dsh-compaction-tool-result-pruner/lib/index.js (`PRUNE_MARKER`, `DEFAULTS`,
 * `measureContent`, `pruneContent`). Equivalence is verified against the real package in test/stub.test.ts.
 */

/** Fixed marker substituted for every removed middle span (the stock pruner's, verbatim). */
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

export interface StockPruneConfig {
  thresholdChars: number
  headChars: number
  tailChars: number
}

/** The stock pruner's defaults (`dsh-compaction-tool-result-pruner`): above 8,192 characters keep 4,096, a marker and 1,024. */
export const STOCK_PRUNE_DEFAULTS: StockPruneConfig = { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }

interface Block {
  type: string
  text?: string
  [key: string]: unknown
}

/** Count Unicode code points without splitting surrogate pairs (the stock pruner's `codePointLength`). */
export const codePointLength = (text: string): number => Array.from(text).length

/** Total Unicode code points across text blocks; non-text blocks cost zero (the stock pruner's `measureContent`). */
export function measureContent(blocks: readonly Block[]): number {
  let chars = 0
  for (const block of blocks) if (block.type === 'text') chars += codePointLength(block.text ?? '')
  return chars
}

/** Unicode code points stock leaves of a cut result: head + marker + tail. */
export function stockKeptChars(config: StockPruneConfig = STOCK_PRUNE_DEFAULTS): number {
  return config.headChars + codePointLength(PRUNE_MARKER) + config.tailChars
}

/**
 * `pruneContent`, ported line for line: `null` within budget, else head + marker + tail spliced per text block by code point,
 * non-text blocks kept in order.
 */
export function pruneContent(blocks: readonly Block[], config: StockPruneConfig = STOCK_PRUNE_DEFAULTS): Block[] | null {
  const totalChars = measureContent(blocks)
  if (totalChars <= config.thresholdChars) return null
  const removedStart = config.headChars
  const removedEnd = totalChars - config.tailChars
  const pruned: Block[] = []
  let consumed = 0
  let markerInserted = false
  for (const block of blocks) {
    if (block.type !== 'text') {
      pruned.push(block)
      continue
    }
    const points = Array.from(block.text ?? '')
    const blockStart = consumed
    const blockEnd = blockStart + points.length
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
    const marker = blockStart < removedEnd && blockEnd > removedStart && !markerInserted ? PRUNE_MARKER : ''
    if (marker.length > 0) markerInserted = true
    const text = points.slice(0, headEnd).join('') + marker + points.slice(tailStart).join('')
    if (text.length > 0) pruned.push({ ...block, text })
    consumed = blockEnd
  }
  if (!markerInserted) throw new Error('tool-result prune: failed to locate the removed text span')
  const charsAfter = measureContent(pruned)
  if (charsAfter > config.thresholdChars || charsAfter >= totalChars) throw new Error('tool-result prune: replacement must be smaller and within threshold')
  return pruned
}
