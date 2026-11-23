import type { QueryCall, QueryParts } from '../shared/protocol.ts'

/** The few shapes of the Harness's session messages that Tameru reads. Everything else is left alone. */

export interface ContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  arguments?: unknown
  [key: string]: unknown
}

export interface Message {
  id?: string
  role: string
  content: ContentBlock[]
  isError?: boolean
  toolCallId?: string
  source?: { kind: string; callId?: string; name?: string; [key: string]: unknown }
  [key: string]: unknown
}

export interface SessionEvent {
  seq: number
  type: string
  data: { message?: Message; [key: string]: unknown }
}

/** The prefix of every result Tameru shortened. It is how a result already shortened by us is recognised. */
export const SHORTENED_PREFIX = '[Tameru: shortened from '
/** The headers of a result the user asked to see in full again: for a few replies, or until they let go. */
export const RESTORED_PREFIX = '[Tameru: restored in full '
export const KEPT_PREFIX = '[Tameru: kept in full '

/** The tool the model reads originals back with. Its own results are never shortened. */
export const READ_TOOL = 'tameru_read_original'

/** The first words of a note this plugin writes into the chat (the Artifact Trail): a user-role message, but not the user's. */
export const TRAIL_NOTE_PREFIX = '[Tameru Artifact Trail'

/** The marker the Harness's own pruner leaves in the middle of a result it trimmed. */
export const STOCK_PRUNE_MARKER = '[... tool result middle pruned ...]'

const SPILL_NOTICE = ' Full formatted result stored at: '

// Characters that reorder text or draw nothing while the model still reads every one: every default-ignorable code point (bidi controls,
// zero-width spaces, soft hyphen, fillers, tag characters, variation selectors, ...). Three kinds are let through where real text needs
// them: one emoji or text presentation selector right after an emoji (after a digit, # or * only as part of a keycap), a joiner between
// two emoji, and a (non-)joiner between two letters or marks of a script other than Latin, Greek or Cyrillic. Every other selector counts,
// ideographic ones included: 240 of them after any ideograph would carry a byte apiece, so a rare glyph variant is lost instead.
const VS = '[\\ufe0e\\ufe0f]'
const WORD = '(?:(?![\\p{Script=Latin}\\p{Script=Greek}\\p{Script=Cyrillic}\\p{Script=Inherited}\\p{Script=Common}])[\\p{L}\\p{M}])'
const EMOJI = '[\\p{Extended_Pictographic}\\p{Emoji_Modifier}]'
const HIDDEN = [
  '(?![\\u200c\\u200d\\ufe0e\\ufe0f])\\p{Default_Ignorable_Code_Point}',
  `(?<!\\p{Emoji})${VS}|(?<=[#*0-9])${VS}(?!\\u20e3)`,
  `(?<!${WORD})\\u200c|\\u200c(?!${WORD})`,
  `\\u200d(?!(?<=${EMOJI}${VS}?\\u200d)${EMOJI}|(?<=${WORD}\\u200d)${WORD})`,
].join('|')
// the opening bracket of a shown character: escaped itself, so what showHidden writes can never be confused with text that was there
const SHOWN_OPEN = '\u27e6'

/** True when what a person sees of `text` would differ from what the model reads. */
export function hasHidden(text: string): boolean {
  return new RegExp(HIDDEN, 'u').test(text)
}

/** Text without those characters. */
export function withoutHidden(text: string): string {
  return text.replace(new RegExp(HIDDEN, 'gu'), '')
}

/**
 * Text with each of those characters shown as `⟦U+XXXX⟧`, so it can be seen and two different texts never look alike. A literal `⟦` is
 * shown the same way, except in text this function already wrote (`shown`), so showing it again changes nothing.
 */
export function showHidden(text: string, shown = false): string {
  return text.replace(new RegExp(shown ? HIDDEN : `${HIDDEN}|${SHOWN_OPEN}`, 'gu'), char => `${SHOWN_OPEN}U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}\u27e7`)
}

/** All text of a message, or `undefined` when it holds anything other than text blocks (an image or file is never rewritten). */
export function textOnly(message: Message): string | undefined {
  if (!Array.isArray(message.content) || message.content.length === 0) return undefined
  let text = ''
  for (const block of message.content) {
    if (block.type !== 'text' || typeof block.text !== 'string') return undefined
    text += block.text
  }
  return text
}

/** A result the Harness already cut down to a preview with a stored-file notice. It carries its own way back, so it is left alone. */
export function hasSpillNotice(text: string): boolean {
  return text.endsWith(')') && text.includes(SPILL_NOTICE)
}

export function alreadyShortened(text: string): boolean {
  return text.startsWith(SHORTENED_PREFIX) || text.includes(STOCK_PRUNE_MARKER)
}

/** True for any result Tameru has written: shortened, restored or kept. */
export function touchedByTameru(text: string): boolean {
  return text.startsWith(SHORTENED_PREFIX) || text.startsWith(RESTORED_PREFIX) || text.startsWith(KEPT_PREFIX)
}

/** The tool call (name and arguments) that produced a result, found among the assistant messages before it. */
export function findToolCall(messages: Array<{ seq: number; message: Message }>, resultIndex: number, callId: string): { name: string; args: string } | undefined {
  for (let i = resultIndex - 1; i >= 0; i--) {
    const entry = messages[i]
    if (!entry || entry.message.role !== 'assistant') continue
    for (const block of entry.message.content ?? []) {
      if (block.type === 'tool-call' && block.id === callId) {
        const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? '')
        return { name: String(block.name ?? ''), args }
      }
    }
  }
  return undefined
}

function lastUserText(messages: Array<{ message: Message }>, before: number): string {
  for (let i = before - 1; i >= 0; i--) {
    const entry = messages[i]
    if (entry?.message.role === 'user') return textOnly(entry.message) ?? ''
  }
  return ''
}

/**
 * The question for a worker that only speaks protocol 1 (an engine before 1.10.0): the call that produced the result (tool and
 * arguments) and the user's latest message before it, capped so a long message cannot dominate. A protocol 2 worker is sent the
 * pieces (`queryPartsFor`) and builds the query with the engine's own `build_query`; this one is the fallback only.
 */
export function buildQuery(messages: Array<{ seq: number; message: Message }>, resultIndex: number, callId: string, maxChars = 2000): string {
  const call = findToolCall(messages, resultIndex, callId)
  const parts = [call ? `${call.name} ${call.args}` : '', lastUserText(messages, resultIndex)].filter(part => part.trim().length > 0)
  return parts.join('\n').slice(0, maxChars)
}

const PART_CHARS = 4000
const LEAF_CHARS = 600
const MAX_LEAVES = 32

/** Tool-call arguments cut down to what a query can use: every string at most `LEAF_CHARS`, bounded depth and width. */
function boundArguments(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > LEAF_CHARS ? value.slice(0, LEAF_CHARS) : value
  if (depth >= 6) return undefined
  if (Array.isArray(value)) return value.slice(0, MAX_LEAVES).map(item => boundArguments(item, depth + 1)).filter(item => item !== undefined)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value).slice(0, MAX_LEAVES)) {
      const bounded = boundArguments(item, depth + 1)
      if (bounded !== undefined) out[key] = bounded
    }
    return out
  }
  return undefined
}

function boundedCall(block: ContentBlock): QueryCall {
  let args: unknown = block.arguments
  if (typeof args === 'string' && args.length > LEAF_CHARS) {
    try {
      args = JSON.parse(args)
    } catch {
      // not JSON: the cut string is one leaf
    }
  }
  const bounded = boundArguments(args)
  return { name: String(block.name ?? '').slice(0, 200), ...(bounded === undefined ? {} : { arguments: bounded }) }
}

/**
 * A user message that counts as the user's own words: from the user (or with no source recorded), not a compaction summary and not
 * a note this plugin or another one wrote. Scaffolding must never be the question.
 */
export function realUserText(message: Message): string | undefined {
  if (message.role !== 'user') return undefined
  const kind = message.source?.kind
  if (kind !== undefined && kind !== 'user') return undefined
  const text = textOnly(message)
  if (text === undefined || text.trim() === '') return undefined
  const head = text.trimStart()
  if (head.startsWith('<compacted-summary>') || head.startsWith(TRAIL_NOTE_PREFIX)) return undefined
  return text.slice(0, PART_CHARS)
}

/**
 * The pieces of the question for the result at `resultIndex`, for the worker's shared `build_query`: the call that produced it,
 * the assistant turn after it, the last real user message and the first one. Everything is bounded here; the worker bounds it again.
 */
export function queryPartsFor(messages: Array<{ seq: number; message: Message }>, resultIndex: number, callId: string): QueryParts {
  const parts: QueryParts = {}
  for (let i = resultIndex - 1; i >= 0 && parts.call === undefined; i--) {
    const message = messages[i]?.message
    if (message?.role !== 'assistant') continue
    const block = (message.content ?? []).find(b => b.type === 'tool-call' && b.id === callId)
    if (block) parts.call = boundedCall(block)
  }
  for (let i = resultIndex + 1; i < messages.length; i++) {
    const message = messages[i]?.message
    if (message?.role !== 'assistant') continue
    const content = message.content ?? []
    parts.after = {
      text: content.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n').slice(0, PART_CHARS),
      calls: content.filter(b => b.type === 'tool-call').slice(0, 8).map(boundedCall),
    }
    break
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messages[i] ? realUserText(messages[i]!.message) : undefined
    if (text !== undefined) {
      parts.lastUser = text
      break
    }
  }
  for (const entry of messages) {
    const text = realUserText(entry.message)
    if (text !== undefined) {
      parts.firstUser = text
      break
    }
  }
  return parts
}

/** Rough characters-per-token used only to size things before the Harness's own meter prices them. */
export const CHARS_PER_TOKEN = 3.5
