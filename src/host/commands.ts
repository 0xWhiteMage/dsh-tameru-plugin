import { hold, listItems, readOriginal, turnOpen, unkeep, type Item, type WriteResult } from './originals.ts'
import { compactionOpen, type MeterLike, type SessionLike } from './shorten.ts'
import type { ChatStats } from './step.ts'
import type { PinStore } from './pins.ts'
import { MAX_PINS } from './pins.ts'

export type PendingOp = { op: 'keep' | 'restore' | 'unkeep'; ref: number }

export interface CommandEnv {
  session: SessionLike
  meter: MeterLike | undefined
  stats: ChatStats
  pins?: PinStore | undefined
  /** The text of `/tameru` with no verb: the status report. */
  status: () => string
}

export interface CommandReply {
  kind: 'success' | 'error'
  text: string
}

const HELP = [
  '/tameru                 what Tameru is doing in this chat',
  '/tameru changes         the results it shortened, with their references',
  '/tameru view REF [N]    read a shortened result in full (from character N)',
  '/tameru keep REF        show the model a result in full until you unkeep it',
  '/tameru restore REF     show the model a result in full for its next few replies',
  '/tameru unkeep REF      go back to the shortened version',
  '/tameru pin TEXT        keep a line of yours in front of the model, word for word, through every compaction',
  '/tameru pins            list your pins',
  '/tameru unpin N         remove pin number N',
  '/tameru purge           forget the pins of every chat',
  '/tameru help            this list',
].join('\n')

const money = (n: number): string => n.toLocaleString('en-US')

function describe(item: Item): string {
  const state = item.state === 'shortened' ? '' : item.state === 'kept' ? ' [kept in full]' : ' [restored]'
  const gone = item.onSurface ? '' : ' (summarised away by a compaction)'
  return `${String(item.ref).padStart(5)}  ${(item.toolName || 'tool').padEnd(12)} ${money(item.originalChars)} chars${item.state === 'shortened' ? ` → ${money(item.shownChars)}` : ''}${state}${gone}`
}

/** Run one write now, or say why not. Never throws. */
export function applyOp(session: SessionLike, meter: MeterLike, op: PendingOp): WriteResult {
  return op.op === 'unkeep' ? unkeep(session, meter, op.ref) : hold(session, meter, op.ref, op.op)
}

/** Apply every queued op that the chat is ready for; returns the ones that could not be applied and why. */
export function drainPending(session: SessionLike, meter: MeterLike, stats: ChatStats): Array<{ op: PendingOp; reason: string }> {
  const failed: Array<{ op: PendingOp; reason: string }> = []
  if (stats.pending.length === 0 || compactionOpen(session)) return failed
  for (const op of stats.pending.splice(0)) {
    const result = applyOp(session, meter, op)
    if (!result.ok) failed.push({ op, reason: result.reason })
  }
  return failed
}

function parseRef(word: string | undefined): number | undefined {
  if (word === undefined || !/^\d{1,9}$/.test(word)) return undefined
  return Number(word)
}

/**
 * Keep, restore or unkeep one result, for the command and for the panel alike: now when the agent is idle, queued for the next step
 * boundary when it is working. Validates first, and never throws.
 */
export function requestHold(env: Pick<CommandEnv, 'session' | 'meter' | 'stats'>, op: PendingOp): CommandReply {
  const known = listItems(env.session).find(item => item.ref === op.ref)
  if (!known) return { kind: 'error', text: `No result shortened by Tameru has reference ${op.ref} in this chat.` }
  const done = op.op === 'keep' ? 'is now kept in full until you unkeep it' : op.op === 'restore' ? 'is back in full for the next few replies' : 'is shortened again'
  if (!env.meter) return { kind: 'error', text: 'The Harness has no token meter, so Tameru cannot change this chat.' }
  if (turnOpen(env.session) || compactionOpen(env.session)) {
    env.stats.pending.push(op)
    return { kind: 'success', text: `Queued: reference ${op.ref} will be changed before the agent's next step, because it is working now.` }
  }
  const result = applyOp(env.session, env.meter, op)
  return result.ok ? { kind: 'success', text: `Reference ${op.ref} ${done}.` } : { kind: 'error', text: result.reason }
}

/** `/tameru ...`: everything the user can ask for. A write waits for the next step boundary when the agent is mid-turn. */
export function runCommand(rawInput: string | undefined, env: CommandEnv): CommandReply {
  const words = (rawInput ?? '').trim().split(/\s+/).filter(Boolean)
  const verb = (words[0] ?? '').toLowerCase()
  if (verb === '' || verb === 'status') return { kind: 'success', text: env.status() }
  if (verb === 'help') return { kind: 'success', text: HELP }
  if (verb === 'changes') {
    const items = listItems(env.session)
    if (items.length === 0) return { kind: 'success', text: 'Tameru has not shortened anything in this chat.' }
    const shown = items.slice(-25)
    return { kind: 'success', text: [`Results Tameru shortened (${items.length}${items.length > shown.length ? `, newest ${shown.length} shown` : ''}); reference, tool, size:`, ...shown.map(describe)].join('\n') }
  }
  if (verb === 'pin' || verb === 'pins' || verb === 'unpin' || verb === 'purge') return runPinCommand(verb, (rawInput ?? '').trim().slice(verb.length).trim(), env)
  const ref = parseRef(words[1])
  if (verb === 'view') {
    if (ref === undefined) return { kind: 'error', text: 'Usage: /tameru view REF [OFFSET]. See /tameru changes for references.' }
    const read = readOriginal(env.session, ref, parseRef(words[2]) ?? 0, 3000)
    if (!read.ok) return { kind: 'error', text: read.reason }
    return { kind: 'success', text: `${read.text}\n\n[characters ${read.offset}-${read.end} of ${read.total}${read.end < read.total ? `; /tameru view ${ref} ${read.end} for more` : ''}]` }
  }
  if (verb === 'keep' || verb === 'restore' || verb === 'unkeep') {
    if (ref === undefined) return { kind: 'error', text: `Usage: /tameru ${verb} REF. See /tameru changes for references.` }
    return requestHold(env, { op: verb, ref })
  }
  return { kind: 'error', text: `Unknown option "${verb}".\n${HELP}` }
}

function runPinCommand(verb: 'pin' | 'pins' | 'unpin' | 'purge', rest: string, env: CommandEnv): CommandReply {
  const { pins } = env
  const chat = env.session.id
  if (!pins || !chat) return { kind: 'error', text: 'Pins are not available in this chat.' }
  if (verb === 'purge') {
    pins.purge()
    return { kind: 'success', text: 'Tameru forgot the pins of every chat.' }
  }
  const list = (items: string[]): string => (items.length === 0 ? 'No pins in this chat. /tameru pin TEXT adds one.' : items.map((pin, index) => `${index + 1}. ${pin}`).join('\n'))
  if (verb === 'pins') return { kind: 'success', text: list(pins.list(chat)) }
  if (verb === 'pin') {
    if (rest === '') return { kind: 'error', text: 'Usage: /tameru pin TEXT' }
    const result = pins.add(chat, rest)
    return result.ok ? { kind: 'success', text: `Pinned (${result.pins.length} of ${MAX_PINS}). The model sees it from its next request, and no compaction removes it.
${list(result.pins)}` } : { kind: 'error', text: result.reason }
  }
  const position = /^\d{1,3}$/.test(rest) ? Number(rest) : NaN
  const result = pins.remove(chat, position)
  return result.ok ? { kind: 'success', text: `Removed.
${list(result.pins)}` } : { kind: 'error', text: result.reason }
}
