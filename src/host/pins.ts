import { join } from 'node:path'
import { hasHidden, withoutHidden } from './messages.ts'
import { readPrivate, writePrivate } from './state-file.ts'

/** Lines the user pins stay in the system prompt, which no summary replaces, so they survive every compaction word for word. */
export const MAX_PINS = 5
export const MAX_PIN_CHARS = 300
export const MAX_PIN_TOTAL_CHARS = 1500
const MAX_CHATS = 400

export type PinResult = { ok: true; pins: string[] } | { ok: false; reason: string }

export interface PinStore {
  list(chat: string): string[]
  add(chat: string, text: string): PinResult
  remove(chat: string, position: number): PinResult
  /** Forget every chat's pins (the `purge` command). Returns an error message, or `undefined` on success. */
  purge(): string | undefined
}

const SECRET_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // API keys of the sk- family
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API keys
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWTs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{8,}/i,
]

export const HIDDEN_REFUSAL = 'That line holds invisible characters (such as bidi controls or Unicode tags) that the model would read but you would not see, so it was not pinned.'

/** Why a line may not be pinned, or `undefined` when it may. Heuristic: it catches common credential shapes, not every secret. */
export function refusal(text: string): string | undefined {
  if (text.trim().length === 0) return 'There is nothing to pin.'
  if (hasHidden(text)) return HIDDEN_REFUSAL
  if (text.length > MAX_PIN_CHARS) return `A pin can be at most ${MAX_PIN_CHARS} characters (this one is ${text.length}).`
  if (SECRET_SHAPES.some(shape => shape.test(text))) return 'That looks like a credential, and pins are sent to the model on every request, so it was not pinned.'
  return undefined
}

/** One line, no control characters: what is stored and shown. */
export function clean(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g'), ' ').replace(/\s+/g, ' ').trim()
}

function addTo(pins: string[], raw: string): PinResult {
  // checked before cleaning: trimming and whitespace folding would otherwise turn some hidden characters into spaces or drop them
  const text = clean(raw)
  const refused = hasHidden(raw) ? HIDDEN_REFUSAL : refusal(text)
  if (refused) return { ok: false, reason: refused }
  if (pins.length >= MAX_PINS) return { ok: false, reason: `You already have ${MAX_PINS} pins; /tameru unpin N removes one.` }
  if (pins.includes(text)) return { ok: false, reason: 'That line is already pinned.' }
  if (pins.reduce((sum, pin) => sum + pin.length, text.length) > MAX_PIN_TOTAL_CHARS) return { ok: false, reason: `Pins together can be at most ${MAX_PIN_TOTAL_CHARS} characters.` }
  return { ok: true, pins: [...pins, text] }
}

function removeFrom(pins: string[], position: number): PinResult {
  if (!Number.isInteger(position) || position < 1 || position > pins.length) return { ok: false, reason: pins.length === 0 ? 'There are no pins.' : `Choose a number from 1 to ${pins.length}.` }
  return { ok: true, pins: pins.filter((_, index) => index !== position - 1) }
}

export function memoryPins(): PinStore {
  const chats = new Map<string, string[]>()
  return {
    list: chat => [...(chats.get(chat) ?? [])],
    add(chat, text) {
      const result = addTo(chats.get(chat) ?? [], text)
      if (result.ok) chats.set(chat, result.pins)
      return result
    },
    remove(chat, position) {
      const result = removeFrom(chats.get(chat) ?? [], position)
      if (result.ok) chats.set(chat, result.pins)
      return result
    },
    purge: () => {
      chats.clear()
      return undefined
    },
  }
}

interface FileShape {
  version: 1
  chats: Record<string, { pins: string[]; updated: number }>
}

/**
 * Pins in one small JSON file of our own (`<DSH_HOME>/tameru/pins.json`), written atomically. A damaged or unreadable file reads as
 * empty and never throws; one that could not be read is never saved over. The newest 400 chats are kept. Removing the plugin leaves
 * this folder; `/tameru purge` empties it.
 */
export function filePins(directory: string, now: () => number = Date.now): PinStore {
  const path = join(directory, 'pins.json')
  // `undefined` when the file is there but could not be read: a change then stops rather than start from nothing
  const load = (): FileShape | undefined => {
    let text: string | undefined
    try {
      text = readPrivate(path)
    } catch {
      return undefined
    }
    try {
      const parsed = JSON.parse(text ?? '') as FileShape
      // chat ids come from outside: a null-prototype map keeps an id like `__proto__` an ordinary key
      if (parsed?.version === 1 && typeof parsed.chats === 'object' && parsed.chats !== null && !Array.isArray(parsed.chats)) return { version: 1, chats: Object.assign(Object.create(null), Object.fromEntries(Object.entries(parsed.chats).filter(([, chat]) => typeof chat === 'object' && chat !== null && typeof chat.updated === 'number'))) }
    } catch {
      // missing or damaged: start empty
    }
    return { version: 1, chats: Object.create(null) }
  }
  const read = (): FileShape => load() ?? { version: 1, chats: {} }
  const write = (data: FileShape): string | undefined => {
    try {
      const entries = Object.entries(data.chats).sort((a, b) => b[1].updated - a[1].updated).slice(0, MAX_CHATS)
      writePrivate(path, JSON.stringify({ version: 1, chats: Object.fromEntries(entries) }))
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  const valid = (pins: unknown): string[] => (Array.isArray(pins) ? pins.filter((pin): pin is string => typeof pin === 'string').map(pin => clean(withoutHidden(pin))).filter(pin => refusal(pin) === undefined).slice(0, MAX_PINS) : [])
  const change = (chat: string, apply: (pins: string[]) => PinResult): PinResult => {
    const data = load()
    if (!data) return { ok: false, reason: 'Could not save the pins: the saved ones could not be read, so they were left as they are.' }
    const result = apply(valid(data.chats[chat]?.pins))
    if (!result.ok) return result
    if (result.pins.length === 0) delete data.chats[chat]
    else data.chats[chat] = { pins: result.pins, updated: now() }
    const failure = write(data)
    return failure ? { ok: false, reason: `Could not save the pins: ${failure}` } : result
  }
  return {
    list: chat => valid(read().chats[chat]?.pins),
    add: (chat, text) => change(chat, pins => addTo(pins, text)),
    remove: (chat, position) => change(chat, pins => removeFrom(pins, position)),
    purge: () => write({ version: 1, chats: Object.create(null) }),
  }
}

/** The section of the system prompt: the user's own lines, verbatim, as standing instructions. */
export function pinsSection(pins: string[]): string {
  if (pins.length === 0) return ''
  return ['## Pinned by the user (Tameru): standing instructions, kept word for word', ...pins.map((pin, index) => `${index + 1}. ${pin}`)].join('\n')
}
