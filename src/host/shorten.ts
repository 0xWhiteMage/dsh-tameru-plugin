import type { EngineClient } from './engine-client.ts'
import {
  KEPT_PREFIX,
  READ_TOOL,
  RESTORED_PREFIX,
  SHORTENED_PREFIX,
  alreadyShortened,
  touchedByTameru,
  buildQuery,
  hasSpillNotice,
  textOnly,
  type Message,
  type SessionEvent,
} from './messages.ts'
import { RESTORE_REPLIES } from './originals.ts'

/** The parts of the Harness's Session this pass uses. `eventAt` is deprecated for new code but is what the stock pruner uses too. */
export interface SessionLike {
  id?: string
  surface: { nodes: readonly number[]; replaceGeneration: number }
  seq: number
  eventAt(seq: number): SessionEvent | undefined
  deriveEventMessage(event: SessionEvent): Message | null
  append(type: string, data: unknown, options?: unknown): { seq: number }
}

export interface MeterLike {
  measure(session: SessionLike, header?: unknown): { totalTokens: number; nodes: Array<{ seq: number; tokens: number; heuristicTokens: number }> }
  estimateMessage(message: Message): number
}

export interface ShortenOptions {
  /** Newest tool results always left alone (on top of the ones the model has not read yet). */
  protectRecent: number
  /** A result shorter than this is never touched. */
  minResultChars: number
  /** A change must free at least this share of the tokens it makes the provider rewrite (the Hermes plugin's measured default). */
  share: number
  /** Most results shortened in one pass. */
  maxPerPass: number
  /** The engine must report at least this much confidence in an extract, or the result is left as it is. */
  minConfidence: number
}

/**
 * `minConfidence` 0.7: on the engine's own task cases (see docs/MEASURED-VS-STOCK.md) extracts the engine was less than 70% sure of lost
 * a required fact in a large share of cases, while those it was surer of rarely did. It trades savings for not silently losing facts.
 */
/** The most time one pass spends asking the engine. */
export const PASS_BUDGET_MS = 6000
/** A result longer than this is left alone: the engine's request limit is 16 MB and a text this size is not worth a step's wait. */
export const MAX_ENGINE_CHARS = 2_000_000

export const DEFAULT_SHORTEN: ShortenOptions = { protectRecent: 4, minResultChars: 6000, share: 0.35, maxPerPass: 24, minConfidence: 0.7 }

export interface Entry {
  seq: number
  event: SessionEvent
  message: Message
}

export interface Candidate extends Entry {
  index: number
  /** The seq of the original result: this node's own seq, unless it is a restored result being shortened again. */
  origin: number
  text: string
  callId: string
  toolName: string
}

/** Every message on the surface, in order. */
export function readSurface(session: SessionLike): Entry[] {
  const entries: Entry[] = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (!event) continue
    const message = session.deriveEventMessage(event)
    if (message) entries.push({ seq, event, message })
  }
  return entries
}

/** True while a compaction is running or a crashed one left its lock behind: the same test the Harness's backend makes. */
export function compactionOpen(session: SessionLike): boolean {
  let unmatchedStart: number | undefined
  let latestEndSeed: number | undefined
  let known = false
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq)
    if (!event) continue
    if (latestEndSeed === undefined && event.type === 'session/end-seed') latestEndSeed = event.seq
    if (!known) {
      if (event.type === 'compaction/start') {
        unmatchedStart = event.seq
        known = true
      } else if (event.type === 'compaction/end') known = true
    }
    if (known && latestEndSeed !== undefined) break
  }
  if (unmatchedStart === undefined) return false
  return !(latestEndSeed !== undefined && latestEndSeed > unmatchedStart)
}

/**
 * The tool results that may be shortened: text only, not an error, long enough, not already cut by the Harness or by us, and
 * old enough. Everything after the last assistant message has not been read by the model yet and is never touched, and the
 * newest `protectRecent` results are kept as they are.
 */
export function findCandidates(session: SessionLike, entries: Entry[], options: ShortenOptions): Candidate[] {
  let lastAssistant = -1
  entries.forEach((entry, index) => {
    if (entry.message.role === 'assistant') lastAssistant = index
  })
  // Results after the last assistant message are unread and never eligible; among the rest, the newest `protectRecent` are kept too.
  const read = entries.map((entry, index) => ({ entry, index })).filter(({ entry, index }) => entry.event.type === 'tool/result' && index < lastAssistant)
  const eligible = read.slice(0, Math.max(0, read.length - options.protectRecent))
  const found: Candidate[] = []
  for (const { entry, index } of eligible) {
    const { message } = entry
    if (message.isError === true || message.source?.name === READ_TOOL) continue
    let text = textOnly(message)
    if (text === undefined) continue
    let origin = entry.seq
    // A header counts only on a replacement the Harness recorded as made from a tool result; a tool's own output that merely begins
    // with our words is ordinary text.
    const sources = (entry.event as unknown as { sourceEventSeqs?: number[] }).sourceEventSeqs
    const citedText = sources?.[0] === undefined ? undefined : session.eventAt(sources[0])?.data.message
    const ours = sources?.[0] !== undefined && session.eventAt(sources[0])?.type === 'tool/result' && citedText !== undefined && !touchedByTameru(textOnly(citedText) ?? '')
    if (ours && text.startsWith(KEPT_PREFIX)) continue
    if (ours && text.startsWith(RESTORED_PREFIX)) {
      // a restored result stays in full for a few replies, then is an ordinary candidate again, from its original text
      // replies counted after the restore itself (event order), not after the result's place in the history
      const replies = entries.filter(later => later.message.role === 'assistant' && later.seq > entry.seq).length
      const original = sources?.[0] === undefined ? undefined : session.eventAt(sources[0])
      const originalText = original?.type === 'tool/result' && original.data.message ? textOnly(original.data.message) : undefined
      if (replies < RESTORE_REPLIES || originalText === undefined) continue
      text = originalText
      origin = sources![0]!
    }
    if (text.length < options.minResultChars || text.length > MAX_ENGINE_CHARS) continue
    if (alreadyShortened(text) || hasSpillNotice(text)) continue
    const callId = message.toolCallId ?? message.source?.callId
    if (typeof callId !== 'string' || callId === '') continue
    found.push({ ...entry, index, origin, text, callId, toolName: message.source?.name ?? '' })
  }
  return found
}

export interface Planned {
  candidate: Candidate
  replacement: Message
  newText: string
  beforeTokens: number
  afterTokens: number
}

/** The text the model sees in place of a result: one factual header line, then the engine's extract. */
export function shortenedText(original: string, extract: string, ref: number): string {
  return `${SHORTENED_PREFIX}${original.length.toLocaleString('en-US')} to ${extract.length.toLocaleString('en-US')} characters; read the original with ${READ_TOOL}, reference ${ref}]\n${extract}`
}

/**
 * From the planned changes, the largest set that still pays for the cache rewrite it causes. A change at position p makes the provider
 * rewrite everything from p to the end of the prompt, so dropping the earliest items shrinks the rewrite; the set is the longest
 * suffix of the plan whose freed tokens reach `share` of the tokens from its first item to the end.
 */
export function chooseBatch(planned: Planned[], nodeTokens: Map<number, number>, order: readonly number[], share: number): Planned[] {
  if (planned.length === 0) return []
  const sorted = [...planned].sort((a, b) => a.candidate.seq - b.candidate.seq)
  const positionOf = new Map(order.map((seq, position) => [seq, position]))
  const tokensFrom = (position: number): number => order.slice(position).reduce((sum, seq) => sum + (nodeTokens.get(seq) ?? 0), 0)
  for (let start = 0; start < sorted.length; start++) {
    const subset = sorted.slice(start)
    const first = positionOf.get(subset[0]!.candidate.seq)
    if (first === undefined) continue
    const freed = subset.reduce((sum, item) => sum + (item.beforeTokens - item.afterTokens), 0)
    if (freed > 0 && freed >= share * tokensFrom(first)) return subset
  }
  return []
}

export interface PassContext {
  session: SessionLike
  meter: MeterLike
  client: EngineClient
  header: unknown
  /** Tokens at which this pass starts acting. */
  activationTokens: number
  options: ShortenOptions
  signal?: AbortSignal
  /**
   * Results the engine already declined (too little saved, not confident, would not shrink), kept for the life of the chat so the same
   * output is not sent to the engine again at every later step. Never filled when the engine itself failed to answer.
   */
  declined?: Set<string>
}

/** Identifies one result and the question it was asked against. A changed question (after a compaction) is a new key. */
export function declineKey(seq: number, textLength: number, query: string): string {
  return `${seq}:${textLength}:${query.length}:${query.slice(0, 80)}`
}

export interface Applied {
  originalSeq: number
  replacementSeq: number
  toolName: string
  beforeTokens: number
  afterTokens: number
}

export type PassOutcome =
  | { kind: 'skipped'; reason: 'below_activation' | 'compaction_open' | 'no_candidates' | 'engine_unavailable' | 'not_confident' | 'not_worth_it' | 'surface_changed' | 'aborted' | 'over_budget' }
  | { kind: 'applied'; applied: Applied[]; freedTokens: number; candidates: number }

export const LATE: unique symbol = Symbol('late')

/** `work`'s value, or `LATE` once `ms` have passed or `signal` aborts, whichever is first. A rejection counts as no answer. */
export function within<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | undefined | typeof LATE> {
  if (signal?.aborted || ms <= 0) {
    work.catch(() => {})
    return Promise.resolve(LATE)
  }
  return new Promise(resolve => {
    const finish = (value: T | undefined | typeof LATE): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = (): void => finish(LATE)
    const timer = setTimeout(onAbort, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
    work.then(finish, () => finish(undefined))
  })
}

/**
 * One pass at a step boundary. It reads, asks the engine, decides, and only then writes. The writes are synchronous and are
 * re-checked first, so a session that changed while the engine worked is left alone.
 */
export async function shortenPass(pass: PassContext): Promise<PassOutcome> {
  const { session, meter, client, options } = pass
  if (pass.signal?.aborted) return { kind: 'skipped', reason: 'aborted' }
  const measurement = meter.measure(session, pass.header)
  if (measurement.totalTokens < pass.activationTokens) return { kind: 'skipped', reason: 'below_activation' }
  if (compactionOpen(session)) return { kind: 'skipped', reason: 'compaction_open' }
  const entries = readSurface(session)
  // every candidate, largest first: maxPerPass counts the calls made, so results the engine already declined do not take the slots
  const candidates = findCandidates(session, entries, options).sort((a, b) => b.text.length - a.text.length)
  if (candidates.length === 0) return { kind: 'skipped', reason: 'no_candidates' }
  const generation = session.surface.replaceGeneration
  const lookup = entries.map(({ seq, message }) => ({ seq, message }))
  const tokensOf = new Map(measurement.nodes.map(node => [node.seq, node.heuristicTokens]))

  const planned: Planned[] = []
  let answered = 0
  let unsure = 0
  // One at a time, within a time budget: a step boundary must not wait long, and what is not reached now is reached at a later step.
  const deadline = Date.now() + PASS_BUDGET_MS
  // two failures to answer stop a result being tried again, so one hard result cannot stall every step; an answer clears them
  const strike = (key: string): void => {
    const failedOnce = `${key}#failed`
    if (pass.declined?.has(failedOnce)) pass.declined.add(key)
    else pass.declined?.add(failedOnce)
  }
  const answeredFor = (key: string): void => void pass.declined?.delete(`${key}#failed`)
  let calls = 0
  let late = false
  for (const candidate of candidates) {
    if (late || calls >= options.maxPerPass || Date.now() > deadline || pass.signal?.aborted) break
    await (async () => {
      const query = buildQuery(lookup, candidate.index, candidate.callId)
      const key = declineKey(candidate.seq, candidate.text.length, query)
      if (pass.declined?.has(key)) {
        answered++
        return
      }
      calls++
      // the step waits for this pass: a slow engine or an abort ends it at the budget, and a reply that comes later is dropped
      const work = client.compress({ text: candidate.text, query, minSavingsRatio: 0.25 })
      const reply = await within(work, deadline - Date.now(), pass.signal)
      // a turn the user stopped says nothing about this result, whatever the engine said
      if (pass.signal?.aborted) {
        late = true
        return
      }
      if (reply === LATE || Date.now() > deadline) {
        // too late for this step, so it is not used; the engine's own answer or failure, when it comes, is what counts for this
        // result, not the time it waited in the queue
        late = true
        work.then(answer => (answer ? answeredFor(key) : strike(key)), () => strike(key))
        return
      }
      const result = reply
      if (!result) {
        strike(key)
        return
      }
      answered++
      answeredFor(key)
      if (result.failOpen || result.sanitized || result.text.length >= candidate.text.length) {
        pass.declined?.add(key)
        return
      }
      if (result.confidence === null || !Number.isFinite(result.confidence) || result.confidence > 1 || result.confidence < options.minConfidence) {
        unsure++
        pass.declined?.add(key)
        return
      }
      const newText = shortenedText(candidate.text, result.text, candidate.origin)
      const replacement: Message = { ...candidate.message, content: [{ type: 'text', text: newText }] }
      const beforeTokens = tokensOf.get(candidate.seq) ?? meter.estimateMessage(candidate.message)
      const afterTokens = meter.estimateMessage(replacement)
      if (afterTokens >= beforeTokens) {
        pass.declined?.add(key)
        return
      }
      planned.push({ candidate, replacement, newText, beforeTokens, afterTokens })
    })()
  }
  if (pass.signal?.aborted) return { kind: 'skipped', reason: 'aborted' }
  if (answered === 0) return { kind: 'skipped', reason: late ? 'over_budget' : 'engine_unavailable' }
  if (planned.length === 0) return { kind: 'skipped', reason: unsure > 0 ? 'not_confident' : 'no_candidates' }
  const batch = chooseBatch(planned, tokensOf, session.surface.nodes, options.share)
  if (batch.length === 0) return { kind: 'skipped', reason: 'not_worth_it' }

  // The engine took time. Write only if nothing was replaced or compacted meanwhile, and only within the step's budget.
  if (pass.signal?.aborted) return { kind: 'skipped', reason: 'aborted' }
  if (Date.now() > deadline) return { kind: 'skipped', reason: 'over_budget' }
  if (session.surface.replaceGeneration !== generation || compactionOpen(session)) return { kind: 'skipped', reason: 'surface_changed' }
  const onSurface = new Set(session.surface.nodes)
  const applied: Applied[] = []
  for (const item of [...batch].sort((a, b) => a.candidate.seq - b.candidate.seq)) {
    const { seq, event } = item.candidate
    if (!onSurface.has(seq)) continue
    try {
      // The price event must sit immediately before its replacement: the Harness's meter subtracts it from the replaced node.
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: meter.estimateMessage(item.candidate.message),
      })
      const { origin } = item.candidate
      const written = session.append('tool/result', { ...event.data, message: item.replacement }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: origin === seq ? [seq] : [origin, seq] })
      applied.push({ originalSeq: seq, replacementSeq: written.seq, toolName: item.candidate.toolName, beforeTokens: item.beforeTokens, afterTokens: item.afterTokens })
    } catch {
      break // what was written is a complete pair; stop before anything half-written
    }
  }
  if (applied.length === 0) return { kind: 'skipped', reason: 'surface_changed' }
  return { kind: 'applied', applied, freedTokens: applied.reduce((sum, a) => sum + (a.beforeTokens - a.afterTokens), 0), candidates: calls }
}
