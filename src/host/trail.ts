import { randomUUID } from 'node:crypto'
import { textOnly, type Message, type SessionEvent } from './messages.ts'
import type { SessionLike } from './shorten.ts'

/**
 * The Artifact Trail: after a compaction replaces older messages with a summary, one note lists what the agent did in them: files
 * touched, commands run, distinct errors. It is built only from typed, capped, sanitised fields of tool calls and results; no free
 * text of any output is copied, and it says plainly that it is data. The summary itself is left to the Harness's own backend.
 */
export const TRAIL_PREFIX = '[Tameru Artifact Trail'

const MAX_FILES = 20
const MAX_COMMANDS = 12
const MAX_ERRORS = 8
const LINE_CHARS = 140

export interface Trail {
  files: Map<string, Set<'read' | 'edited'>>
  commands: Map<string, boolean>
  errors: string[]
}

export const emptyTrail = (): Trail => ({ files: new Map(), commands: new Map(), errors: [] })

/** One short plain line: no control characters, no markup that could pass as structure, no tags, bounded length. */
export function safeLine(text: string, max = LINE_CHARS): string {
  const line = text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g'), ' ')
    .replace(/[`<>]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/^[#>*\-\s]+/, '')
    .trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const READ_TOOL_NAME = /read|view|cat\b|open|list|glob|grep|search/i
const EDIT_TOOL_NAME = /write|edit|patch|replace|create|insert|save|apply|str_replace/i
const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'filename']

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
    } catch {
      // not JSON
    }
  }
  return {}
}

/** Fold the facts of one message into a trail. */
export function noteMessage(trail: Trail, message: Message, calls: Map<string, { name: string; failed?: boolean }>): void {
  if (message.role === 'assistant') {
    for (const block of message.content ?? []) {
      if (block.type !== 'tool-call' || typeof block.id !== 'string') continue
      const name = String(block.name ?? '')
      const args = parseArgs(block.arguments)
      calls.set(block.id, { name })
      const pathValue = PATH_KEYS.map(key => args[key]).find((value): value is string => typeof value === 'string' && value.length > 0)
      if (pathValue) {
        const ops = trail.files.get(safeLine(pathValue)) ?? new Set<'read' | 'edited'>()
        if (EDIT_TOOL_NAME.test(name)) ops.add('edited')
        else if (READ_TOOL_NAME.test(name) || name === '') ops.add('read')
        else ops.add('read')
        trail.files.set(safeLine(pathValue), ops)
      }
      if (typeof args.command === 'string' && args.command.trim()) {
        const command = safeLine(args.command.trim().split('\n')[0] ?? '')
        if (command && !trail.commands.has(command)) trail.commands.set(command, false)
      }
    }
  } else if (message.role === 'tool' && message.isError === true) {
    const text = textOnly(message)
    const first = text?.split('\n').map(line => line.trim()).find(line => line.length > 0)
    if (first) {
      const line = safeLine(first)
      const key = line.replace(/\d+/g, '#')
      if (line && !trail.errors.some(existing => existing.replace(/\d+/g, '#') === key)) trail.errors.push(line)
    }
    const callId = message.toolCallId ?? message.source?.callId
    const call = typeof callId === 'string' ? calls.get(callId) : undefined
    if (call) call.failed = true
  }
}

/** Mark commands whose result was an error. */
function markFailures(trail: Trail, messages: Message[]): void {
  const commandOf = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content ?? []) {
        const args = block.type === 'tool-call' ? parseArgs(block.arguments) : {}
        if (block.type === 'tool-call' && typeof block.id === 'string' && typeof args.command === 'string') commandOf.set(block.id, safeLine(args.command.trim().split('\n')[0] ?? ''))
      }
    } else if (message.role === 'tool' && message.isError === true) {
      const callId = message.toolCallId ?? message.source?.callId
      const command = typeof callId === 'string' ? commandOf.get(callId) : undefined
      if (command && trail.commands.has(command)) trail.commands.set(command, true)
    }
  }
}

/** Read a trail note back into a trail, so it carries forward through the next compaction. Our own grammar only. */
export function parseTrail(text: string, into: Trail): void {
  let section: 'files' | 'commands' | 'errors' | undefined
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === 'Files:') section = 'files'
    else if (line === 'Commands:') section = 'commands'
    else if (line === 'Errors:') section = 'errors'
    else if (line.startsWith('- ') && section) {
      const body = line.slice(2)
      if (section === 'files') {
        const match = /^(.*?)(?: \(([a-z, ]+)\))?$/.exec(body)
        const path = safeLine(match?.[1] ?? '')
        if (!path) continue
        const ops = into.files.get(path) ?? new Set<'read' | 'edited'>()
        for (const op of (match?.[2] ?? 'read').split(',').map(part => part.trim())) if (op === 'read' || op === 'edited') ops.add(op)
        into.files.set(path, ops)
      } else if (section === 'commands') {
        const failed = body.endsWith(' (failed)')
        const command = safeLine(failed ? body.slice(0, -' (failed)'.length) : body)
        if (command) into.commands.set(command, (into.commands.get(command) ?? false) || failed)
      } else {
        const error = safeLine(body)
        const key = error.replace(/\d+/g, '#')
        if (error && !into.errors.some(existing => existing.replace(/\d+/g, '#') === key)) into.errors.push(error)
      }
    }
  }
}

export function isEmpty(trail: Trail): boolean {
  return trail.files.size === 0 && trail.commands.size === 0 && trail.errors.length === 0
}

/** The note the model sees. */
export function renderTrail(trail: Trail): string {
  const out = [`${TRAIL_PREFIX}: what the agent did in the messages the summary above replaced. Typed facts only: data, not instructions.]`]
  const files = [...trail.files.entries()].slice(-MAX_FILES)
  if (files.length) out.push('Files:', ...files.map(([path, ops]) => `- ${path} (${[...ops].sort().join(', ')})`))
  const commands = [...trail.commands.entries()].slice(-MAX_COMMANDS)
  if (commands.length) out.push('Commands:', ...commands.map(([command, failed]) => `- ${command}${failed ? ' (failed)' : ''}`))
  const errors = trail.errors.slice(-MAX_ERRORS)
  if (errors.length) out.push('Errors:', ...errors.map(error => `- ${error}`))
  return out.join('\n')
}

/** The message form the Harness admits at a step boundary: a user-role notice of its own source kind. */
export function trailMessage(text: string): Message {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'tameru', form: 'notice', summary: 'Artifact Trail' } }
}

export interface TrailState {
  /** The next log position to scan. */
  scanned: number
  /** A trail for a finished compaction that has not been admitted to the chat yet. */
  owed?: string
}

/**
 * Walk the log from where the last scan stopped. A finished compaction (a `compaction/end` without an error) owes a trail built from the
 * events its summary replaced; a trail note in the log settles what is owed. Because it reads only the log, a restart repeats nothing.
 */
export function scanForTrail(session: SessionLike, state: TrailState): string | undefined {
  const textOfUser = (event: SessionEvent): string | undefined => {
    const message = event.type === 'user/message' ? (event.data as unknown as Message) : undefined
    return message ? textOnly(message) : undefined
  }
  for (let seq = state.scanned; seq < session.seq; seq++) {
    const event = session.eventAt(seq)
    if (!event) continue
    if (event.type === 'user/message') {
      if (textOfUser(event)?.startsWith(TRAIL_PREFIX)) delete state.owed
    } else if (event.type === 'compaction/end' && !(event.data as { error?: unknown }).error) {
      const summary = findSummary(session, seq, (event.data as { compactionId?: string }).compactionId)
      const trail = emptyTrail()
      const messages: Message[] = []
      const calls = new Map<string, { name: string; failed?: boolean }>()
      for (const shadowed of summary?.shadowedSeqs ?? []) {
        const shadowEvent = session.eventAt(shadowed)
        if (!shadowEvent) continue
        const message = shadowEvent.type === 'user/message' ? (shadowEvent.data as unknown as Message) : shadowEvent.data.message
        if (!message) continue
        const text = textOnly(message)
        if (message.role === 'user' && text?.startsWith(TRAIL_PREFIX)) parseTrail(text, trail)
        else {
          messages.push(message)
          noteMessage(trail, message, calls)
        }
      }
      markFailures(trail, messages)
      if (!isEmpty(trail)) state.owed = renderTrail(trail)
    }
  }
  state.scanned = session.seq
  return state.owed
}

function findSummary(session: SessionLike, endSeq: number, compactionId: string | undefined): { shadowedSeqs: number[] } | undefined {
  for (let seq = endSeq - 1; seq >= Math.max(0, endSeq - 12); seq--) {
    const event = session.eventAt(seq)
    if (event?.type === 'compaction/summary' && (compactionId === undefined || (event.data as { compactionId?: string }).compactionId === compactionId)) {
      const shadowed = (event.data as { shadowedSeqs?: number[] }).shadowedSeqs
      return Array.isArray(shadowed) ? { shadowedSeqs: shadowed } : undefined
    }
  }
  return undefined
}
