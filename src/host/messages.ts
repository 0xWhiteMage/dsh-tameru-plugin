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
