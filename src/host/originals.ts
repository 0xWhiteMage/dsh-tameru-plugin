import { KEPT_PREFIX, RESTORED_PREFIX, SHORTENED_PREFIX, STOCK_PRUNE_MARKER, textOnly, touchedByTameru } from './messages.ts'
import type { MeterLike, SessionLike } from './shorten.ts'
import { safeLine } from './trail.ts'

/**
 * Everything about a result Tameru shortened is derived from the session log, so it survives a restart and a fork and needs no
 * separate storage. A shortened, restored or kept result is a `tool/result` replacement that cites the original's seq first
 * (`sourceEventSeqs[0]`) and whose text starts with one of Tameru's three header prefixes. The Harness only lets such a
 * replacement change the content, which is why the state lives in the visible text.
 */
export type HoldState = 'shortened' | 'restored' | 'kept'

export interface Item {
  /** The seq of the original tool result: the reference the model and the user use. */
  ref: number
  /** The seq of the node that currently stands for it. */
  currentSeq: number
  state: HoldState
  toolName: string
  /** What was run, from the tool call's own arguments: the start of its command or path. Empty when there is none. */
  label: string
  originalChars: number
  shownChars: number
  /** False once a compaction summarised the node away. */
  onSurface: boolean
  /** The node this one replaced, when there was one besides the original. */
  previousSeq?: number
  /** True when the Harness's own pruner has since cut the middle out of the node that stands for the result. */
  cutByHarness: boolean
}

const LABEL_KEYS = ['command', 'cmd', 'path', 'file_path', 'filePath', 'file', 'filename', 'url', 'query', 'pattern']
const LABEL_CHARS = 80
const LABEL_LOOKBACK = 400

/**
 * A short label for the tool call that produced the result at `ref`: the first line of its command, or its path, from the arguments
 * the model wrote. Cleaned like everything else shown to the user (no control characters, no markup, bounded). It is only ever shown, never
 * sent to the model.
 */
export function callLabel(session: SessionLike, ref: number, callId: unknown): string {
  if (typeof callId !== 'string' || callId === '') return ''
  for (let seq = ref - 1; seq >= Math.max(0, ref - LABEL_LOOKBACK); seq--) {
    const message = session.eventAt(seq)?.data.message
    if (message?.role !== 'assistant') continue
    for (const block of message.content ?? []) {
      if (block.type !== 'tool-call' || block.id !== callId) continue
      let args: Record<string, unknown> = {}
      try {
        const raw = block.arguments
        args = typeof raw === 'string' ? JSON.parse(raw) : typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
      } catch {
        return ''
      }
      const key = LABEL_KEYS.find(name => typeof args[name] === 'string' && (args[name] as string).trim() !== '')
      return key ? safeLine((args[key] as string).trim().split('\n')[0] ?? '', LABEL_CHARS) : ''
    }
  }
  return ''
}

const sourcesOf = (session: SessionLike, seq: number): number[] | undefined => (session.eventAt(seq) as unknown as { sourceEventSeqs?: number[] } | undefined)?.sourceEventSeqs

/** The first result in a chain of replacements: the original output. A stock cut cites the node it cut, so the chain is followed back. */
function rootOf(session: SessionLike, seq: number): number {
  let at = seq
  for (let hops = 0; hops < 8; hops++) {
    const first = sourcesOf(session, at)?.[0]
    if (first === undefined || session.eventAt(first)?.type !== 'tool/result') return at
    at = first
  }
  return seq // longer than any real chain: not resolved, so the item is left out
}

/** A node the Harness's own pruner cut: it cites exactly one result, which has no cut of its own, and its text carries the marker. */
function isStockCut(session: SessionLike, seq: number): boolean {
  const sources = sourcesOf(session, seq)
  const text = (() => { const message = session.eventAt(seq)?.data.message; return message ? textOnly(message) : undefined })()
  if (text === undefined || !text.includes(STOCK_PRUNE_MARKER) || sources?.length !== 1) return false
  const cited = session.eventAt(sources[0]!)?.data.message
  const citedText = cited ? textOnly(cited) : undefined
  return citedText !== undefined && !citedText.includes(STOCK_PRUNE_MARKER)
}

/** The Tameru-written node behind a node the Harness may have cut since: the one that cites both the original and its predecessor. */
function tameruNodeOf(session: SessionLike, seq: number): number {
  let at = seq
  for (let hops = 0; hops < 8; hops++) {
    const first = sourcesOf(session, at)?.[0]
    if (first === undefined || !isStockCut(session, at)) break
    at = first
  }
  return at
}

/** How many model replies a restored result stays in full before Tameru may shorten it again. */
export const RESTORE_REPLIES = 3

export function stateOf(text: string): HoldState | undefined {
  if (text.startsWith(KEPT_PREFIX)) return 'kept'
  if (text.startsWith(RESTORED_PREFIX)) return 'restored'
  if (text.startsWith(SHORTENED_PREFIX)) return 'shortened'
  return undefined
}

export function keptHeader(ref: number): string {
  return `${KEPT_PREFIX}by the user; reference ${ref}]\n`
}

export function restoredHeader(ref: number): string {
  return `${RESTORED_PREFIX}at the user's request; reference ${ref}]\n`
}

/** Every result Tameru has shortened, restored or kept in this chat, latest state per original, oldest first. */
export function listItems(session: SessionLike): Item[] {
  const latest = new Map<number, Item>()
  const surface = new Set(session.surface.nodes)
  for (let seq = 0; seq < session.seq; seq++) {
    const event = session.eventAt(seq)
    if (!event || event.type !== 'tool/result') continue
    const sources = (event as unknown as { sourceEventSeqs?: number[] }).sourceEventSeqs
    if (!sources?.length) continue
    const message = event.data.message
    const text = message ? textOnly(message) : undefined
    const state = text === undefined ? undefined : stateOf(text)
    if (!message || text === undefined || !state) continue
    const ref = rootOf(session, seq)
    if (ref === seq) continue
    const original = session.eventAt(ref)
    const originalText = original?.type === 'tool/result' && original.data.message ? textOnly(original.data.message) : undefined
    // an original never starts with our headers; text that does is not one of ours
    if (originalText === undefined || touchedByTameru(originalText)) continue
    latest.set(ref, {
      ref,
      currentSeq: seq,
      state,
      toolName: message.source?.name ?? '',
      label: callLabel(session, ref, original?.data.message?.toolCallId ?? original?.data.message?.source?.callId),
      originalChars: originalText.length,
      shownChars: text.length,
      onSurface: surface.has(seq),
      cutByHarness: isStockCut(session, seq),
      ...(sourcesOf(session, tameruNodeOf(session, seq))?.[1] !== undefined ? { previousSeq: sourcesOf(session, tameruNodeOf(session, seq))![1]! } : {}),
    })
  }
  return [...latest.values()].sort((a, b) => a.ref - b.ref)
}

export const MAX_READ_CHARS = 20_000
export const DEFAULT_READ_CHARS = 8_000

export type ReadResult = { ok: true; text: string; offset: number; end: number; total: number } | { ok: false; reason: string }

/** A window of the original text of a result Tameru shortened. Only results Tameru touched can be read this way. */
export function readOriginal(session: SessionLike, ref: number, offset = 0, limit = DEFAULT_READ_CHARS): ReadResult {
  if (!Number.isInteger(ref) || ref < 0) return { ok: false, reason: 'the reference must be a whole number' }
  const item = listItems(session).find(candidate => candidate.ref === ref)
  if (!item) return { ok: false, reason: `no result shortened by Tameru has reference ${ref} in this chat` }
  const text = textOnly(session.eventAt(ref)!.data.message!)!
  const start = Math.max(0, Math.min(Number.isInteger(offset) ? offset : 0, text.length))
  const size = Math.max(1, Math.min(Number.isInteger(limit) ? limit : DEFAULT_READ_CHARS, MAX_READ_CHARS))
  const end = Math.min(text.length, start + size)
  return { ok: true, text: text.slice(start, end), offset: start, end, total: text.length }
}

export type WriteResult = { ok: true; replacementSeq: number } | { ok: false; reason: string }

/** Replace the node standing for `item` with new text: the same price-event-then-replacement pair the pass writes. */
function replaceNode(session: SessionLike, meter: MeterLike, item: Item, text: string): WriteResult {
  const current = session.eventAt(item.currentSeq)
  if (!current?.data.message) return { ok: false, reason: 'the result is no longer in the chat' }
  const message = { ...current.data.message, content: [{ type: 'text', text }] }
  try {
    session.append('compaction/prune', { shadowedRange: { start: item.currentSeq, end: item.currentSeq }, shadowedSeqs: [item.currentSeq], shadowedTokenCount: meter.estimateMessage(current.data.message) })
    const written = session.append('tool/result', { ...current.data, message }, { surfaceOp: { op: 'replace', startSeq: item.currentSeq, endSeq: item.currentSeq }, sourceEventSeqs: [item.ref, item.currentSeq] })
    return { ok: true, replacementSeq: written.seq }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Show the model the full original: for a few replies (`restore`) or until the user lets go (`keep`). */
export function hold(session: SessionLike, meter: MeterLike, ref: number, mode: 'keep' | 'restore'): WriteResult {
  const item = listItems(session).find(candidate => candidate.ref === ref)
  if (!item) return { ok: false, reason: `no result shortened by Tameru has reference ${ref} in this chat` }
  if (!item.onSurface) return { ok: false, reason: `reference ${ref} was summarised away by a compaction and is no longer in the model's view` }
  if (item.state === 'kept') return { ok: false, reason: `reference ${ref} is already kept in full` }
  if (item.state === 'restored' && mode === 'restore') return { ok: false, reason: `reference ${ref} is already restored` }
  const original = textOnly(session.eventAt(ref)!.data.message!)!
  return replaceNode(session, meter, item, (mode === 'keep' ? keptHeader(ref) : restoredHeader(ref)) + original)
}

/** Put a kept or restored result back to the shortened version it replaced. */
export function unkeep(session: SessionLike, meter: MeterLike, ref: number): WriteResult {
  const item = listItems(session).find(candidate => candidate.ref === ref)
  if (!item) return { ok: false, reason: `no result shortened by Tameru has reference ${ref} in this chat` }
  if (item.state === 'shortened') return { ok: false, reason: `reference ${ref} is already shortened` }
  if (!item.onSurface) return { ok: false, reason: `reference ${ref} was summarised away by a compaction and is no longer in the model's view` }
  const previous = item.previousSeq === undefined ? undefined : session.eventAt(item.previousSeq)
  const text = previous?.data.message ? textOnly(previous.data.message) : undefined
  if (text === undefined || stateOf(text) !== 'shortened') return { ok: false, reason: `the shortened version of reference ${ref} is not available` }
  return replaceNode(session, meter, item, text)
}

/** Whether a turn is open (the agent is working): changes to the chat then wait for the next step boundary. */
export function turnOpen(session: SessionLike): boolean {
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const type = session.eventAt(seq)?.type
    if (type === 'turn/start') return true
    if (type === 'turn/end') return false
  }
  return false
}
