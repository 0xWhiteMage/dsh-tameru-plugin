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

/** The marker the Harness's own pruner leaves in the middle of a result it trimmed. */
export const STOCK_PRUNE_MARKER = '[... tool result middle pruned ...]'

const SPILL_NOTICE = ' Full formatted result stored at: '

// Characters that reorder text or draw nothing while the model still reads every one: bidi controls, zero-width spaces, soft hyphen,
// combining grapheme joiner, Hangul and Khmer fillers, shorthand format controls and Unicode tag characters. Variation selectors and
// zero-width (non-)joiners count too unless they sit where real text needs them: one emoji or text presentation selector right after an
// emoji, a joiner between two emoji, or a (non-)joiner between two letters or marks of a script other than Latin, Greek or Cyrillic (a
// combining mark of no script of its own does not count). Every other selector counts, ideographic ones included: 240 of them after any
// ideograph would carry a byte apiece, so a rare glyph variant is lost instead.
const VS = '[\\ufe0e\\ufe0f]'
const WORD = '(?:(?![\\p{Script=Latin}\\p{Script=Greek}\\p{Script=Cyrillic}\\p{Script=Inherited}\\p{Script=Common}])[\\p{L}\\p{M}])'
const EMOJI = '[\\p{Extended_Pictographic}\\p{Emoji_Modifier}]'
const HIDDEN = [
  '[\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u200b\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\u3164\\ufeff\\uffa0\\u{1bca0}-\\u{1bca3}\\u{e0000}-\\u{e007f}]',
  `(?<!\\p{Emoji})${VS}`,
  '[\\ufe00-\\ufe0d\\u{e0100}-\\u{e01ef}]',
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

/** Text with each of those characters shown as `⟦U+XXXX⟧`, so it can be seen and two different texts never look alike. */
export function showHidden(text: string): string {
  return text.replace(new RegExp(`${HIDDEN}|${SHOWN_OPEN}`, 'gu'), char => `${SHOWN_OPEN}U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}\u27e7`)
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
 * The question the engine extracts against, built from what the task is about: the call that produced the result (tool and
 * arguments) and the user's latest message before it. Capped so a long message cannot dominate.
 */
export function buildQuery(messages: Array<{ seq: number; message: Message }>, resultIndex: number, callId: string, maxChars = 2000): string {
  const call = findToolCall(messages, resultIndex, callId)
  const parts = [call ? `${call.name} ${call.args}` : '', lastUserText(messages, resultIndex)].filter(part => part.trim().length > 0)
  return parts.join('\n').slice(0, maxChars)
}

/** Rough characters-per-token used only to size things before the Harness's own meter prices them. */
export const CHARS_PER_TOKEN = 3.5
