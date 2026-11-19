import type { EngineClient } from './engine-client.ts'
import type { AcceptPolicy, CompressRequest, Dropped } from '../shared/protocol.ts'
import { legacyDecision } from './legacy-decision.ts'
import { safeLine } from './trail.ts'
import {
  KEPT_PREFIX,
  READ_TOOL,
  RESTORED_PREFIX,
  SHORTENED_PREFIX,
  alreadyShortened,
  touchedByTameru,
  buildQuery,
  queryPartsFor,
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

/** The engine's named option set for this plugin's call (`tameru/presets.json`): extract strategy, no originals stored, 25% minimum saving. */
export const ENGINE_PRESET = 'dsh-tool-result@1'
/** Options the plugin adds on top of the preset. Redaction is on because no original is kept outside the chat itself. */
export const REDACT_SECRETS = true
/** What a protocol 1 worker is told: the preset's own 25% minimum saving. */
const LEGACY_MIN_SAVINGS = 0.25
export const ANCHOR_ERRORS = true

/**
 * What this plugin accepts, as data for the engine's `decide()` (the engine's `DSH_POLICY` with the user's strength setting as the
 * confidence floor). The decision is made in the worker; the host acts on `accept` only and records the reason.
 */
export function policyOf(options: ShortenOptions): AcceptPolicy {
  return { minConfidence: options.minConfidence, minSavedRatio: 0, minTokensSaved: 1, allowSanitized: false }
}

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
export function findCandidates(session: SessionLike, entries: Entry[], options: ShortenOptions, includeUnread = false): Candidate[] {
  let lastAssistant = -1
  entries.forEach((entry, index) => {
    if (entry.message.role === 'assistant') lastAssistant = index
  })
  // Results after the last assistant message are unread and never eligible (except where the Harness's own pruner is about to cut them
  // anyway: `includeUnread`, trigger policy only); among the rest, the newest `protectRecent` are kept too.
  const read = entries.map((entry, index) => ({ entry, index })).filter(({ entry, index }) => entry.event.type === 'tool/result' && (includeUnread || index < lastAssistant))
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

/** Longest the "dropped" part of the header may be. */
const DROPPED_CHARS = 150
const WHERE_CHARS = 24

/**
 * The header's "dropped" summary from the engine's: `412 log lines (line 12), 38 trace lines (Foo.java:88…)`. The category is checked
 * against a closed pattern and the locator (text from the result) goes through `safeLine`, so nothing from a result can shape the line.
 */
export function droppedSummary(dropped: readonly Dropped[]): string {
  const rows = dropped
    .filter(row => /^[a-z]{2,16}$/.test(row.category) && Number.isFinite(row.lines) && row.lines > 0)
    .slice(0, 3)
    .map(row => ({ text: `${Math.floor(row.lines).toLocaleString('en-US')} ${row.category} lines`, where: safeLine(row.where.replace(/[\[\]]/g, ' '), WHERE_CHARS) }))
  if (rows.length === 0) return ''
  const render = (withWhere: number): string => rows.map((row, i) => (i < withWhere && row.where ? `${row.text} (${row.where})` : row.text)).join(', ')
  for (let n = rows.length; n >= 0; n--) if (render(n).length <= DROPPED_CHARS) return render(n)
  return render(0).slice(0, DROPPED_CHARS)
}

/**
 * The text the model sees in place of a result: one factual header line, then the engine's extract. The header names what was left
 * out (the engine's `dropped` summary) and ends in `ref=N`, the reference to read the original with, the same token the Hermes
 * plugin's headers end in.
 */
export function shortenedText(original: string, extract: string, ref: number, dropped: readonly Dropped[] = []): string {
  const summary = droppedSummary(dropped)
  return `${SHORTENED_PREFIX}${original.length.toLocaleString('en-US')} to ${extract.length.toLocaleString('en-US')} characters;${summary ? ` dropped: ${summary};` : ''} read the original with ${READ_TOOL} ref=${ref}]\n${extract}`
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

/** What a pass needs of the engine client: `compress`, and (from engine 1.10.0) `speaksV2`. A client without `speaksV2` is a protocol 1 one. */
export type PassClient = Pick<EngineClient, 'compress'> & Partial<Pick<EngineClient, 'speaksV2'>>

export interface PassContext {
  session: SessionLike
  meter: MeterLike
  client: PassClient
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
  /** Counts of the engine's closed decision reasons, filled by the pass (for `/tameru` and for tests). */
  reasons?: Record<string, number>
  /**
   * Trigger policy (opt-in `policy: 'at-trigger'`): the pass runs only when the Harness's own pruner is about to cut, and an extract
   * takes the place of the pruner's head/tail cut. Every result that cut would hit is eligible (unread ones too, the newest included),
   * none is protected, the pay-back rule does not apply (the cut rewrites the same prompt from the same place), and an extract that
   * is longer than the cut would leave is declined, so the stock cut happens as it would have.
   */
  trigger?: { thresholdChars: number; cutChars: number; /** `hybrid`: the ordinary candidates and options, acting only at the trigger (see `policy: 'hybrid'`). */ hybrid?: boolean }
  /** A listener for what the pass decided and wrote, for measurements. It must not throw and changes nothing. */
  observe?: (event: PassEvent) => void
}

export type PassEvent =
  | { kind: 'decision'; key: string; accept: boolean; reason: string; original: string; extract: string }
  | { kind: 'applied'; key: string; origin: number }

/**
 * Identifies one result: its place in the chat and its length, and nothing else. The question is NOT part of it: a result the engine
 * declined or Tameru shortened is never asked about again because the question later changed (a new user message, a compaction), so a
 * later step cannot rewrite it a second time. The engine's `stable_key` is not part of it either: it hashes the question as well.
 */
export function itemKey(seq: number, textLength: number): string {
  return `${seq}:${textLength}`
}

export interface Applied {
  originalSeq: number
  replacementSeq: number
  toolName: string
  beforeTokens: number
  afterTokens: number
}

export type PassOutcome =
  | { kind: 'skipped'; reason: 'below_activation' | 'compaction_open' | 'no_candidates' | 'engine_unavailable' | 'not_confident' | 'not_worth_it' | 'would_leave_cuts' | 'surface_changed' | 'aborted' }
  | { kind: 'applied'; applied: Applied[]; freedTokens: number; candidates: number }

/**
 * One pass at a step boundary. It reads, asks the engine, decides, and only then writes. The writes are synchronous and are
 * re-checked first, so a session that changed while the engine worked is left alone.
 */
export async function shortenPass(pass: PassContext): Promise<PassOutcome> {
  const { session, meter, client } = pass
  const options: ShortenOptions = pass.trigger && !pass.trigger.hybrid
    ? { ...pass.options, protectRecent: 0, minResultChars: Math.max(pass.options.minResultChars, pass.trigger.thresholdChars + 1), share: 0 }
    : pass.options
  if (pass.signal?.aborted) return { kind: 'skipped', reason: 'aborted' }
  const measurement = meter.measure(session, pass.header)
  if (measurement.totalTokens < pass.activationTokens) return { kind: 'skipped', reason: 'below_activation' }
  if (compactionOpen(session)) return { kind: 'skipped', reason: 'compaction_open' }
  const entries = readSurface(session)
  const candidates = findCandidates(session, entries, options, pass.trigger !== undefined && !pass.trigger.hybrid)
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, options.maxPerPass)
  if (candidates.length === 0) return { kind: 'skipped', reason: 'no_candidates' }
  const generation = session.surface.replaceGeneration
  const lookup = entries.map(({ seq, message }) => ({ seq, message }))
  const tokensOf = new Map(measurement.nodes.map(node => [node.seq, node.heuristicTokens]))

  const v2 = (await client.speaksV2?.()) === true
  const note = (reason: string): void => {
    if (pass.reasons) pass.reasons[reason] = (pass.reasons[reason] ?? 0) + 1
  }
  const planned: Planned[] = []
  let answered = 0
  let unsure = 0
  // One at a time, within a time budget: a step boundary must not wait long, and what is not reached now is reached at a later step.
  const started = Date.now()
  for (const candidate of candidates) {
    if (Date.now() - started > PASS_BUDGET_MS || pass.signal?.aborted) break
    await (async () => {
      const key = itemKey(candidate.seq, candidate.text.length)
      if (pass.declined?.has(key)) {
        answered++
        return
      }
      const policy = policyOf(options)
      // protocol 2: the worker builds the query from the pieces and decides; protocol 1: this host builds the query (the fallback) and decides
      const fallbackQuery = buildQuery(lookup, candidate.index, candidate.callId)
      const request: CompressRequest = v2
        ? { text: candidate.text, query: fallbackQuery, preset: ENGINE_PRESET, anchorErrors: ANCHOR_ERRORS, redactSecrets: REDACT_SECRETS, queryParts: queryPartsFor(lookup, candidate.index, candidate.callId), policy }
        : { text: candidate.text, query: fallbackQuery, minSavingsRatio: LEGACY_MIN_SAVINGS }
      const result = await client.compress(request)
      if (!result) {
        // the engine did not answer for this one: a second failure stops it being tried again, so one hard result cannot stall every step
        const failedOnce = `${key}#failed`
        if (pass.declined?.has(failedOnce)) pass.declined.add(key)
        else pass.declined?.add(failedOnce)
        return
      }
      answered++
      // the engine's decision; only a worker without `decide()` leaves it to the legacy rule, with the same policy
      const decision = result.decision ?? legacyDecision(result, candidate.text, policy)
      note(decision.reason)
      pass.observe?.({ kind: 'decision', key, accept: decision.accept, reason: decision.reason, original: candidate.text, extract: result.text })
      if (!decision.accept) {
        if (decision.reason === 'low_confidence') unsure++
        pass.declined?.add(key)
        return
      }
      const newText = shortenedText(candidate.text, result.text, candidate.origin, result.dropped)
      if (pass.trigger && newText.length > pass.trigger.cutChars) {
        note('longer_than_stock_cut')
        pass.declined?.add(key)
        return
      }
      const replacement: Message = { ...candidate.message, content: [{ type: 'text', text: newText }] }
      const beforeTokens = tokensOf.get(candidate.seq) ?? meter.estimateMessage(candidate.message)
      const afterTokens = meter.estimateMessage(replacement)
      if (afterTokens >= beforeTokens) {
        // the Harness's own meter prices the message with its header: the one check that cannot be made in the worker
        note('not_enough_tokens')
        pass.declined?.add(key)
        return
      }
      planned.push({ candidate, replacement, newText, beforeTokens, afterTokens })
    })()
  }
  if (answered === 0) return { kind: 'skipped', reason: 'engine_unavailable' }
  if (planned.length === 0) return { kind: 'skipped', reason: unsure > 0 ? 'not_confident' : 'no_candidates' }
  let batch: Planned[]
  if (pass.trigger?.hybrid) {
    // what the stock pruner would cut is replaced without a pay-back test (the cut rewrites the prompt from there anyway); an item it would
    // not cut keeps the share rule, except after the first replaced cut, whose rewrite it shares
    const cuts = planned.filter(item => item.candidate.text.length > pass.trigger!.thresholdChars)
    const others = planned.filter(item => item.candidate.text.length <= pass.trigger!.thresholdChars)
    const firstCut = cuts.length ? Math.min(...cuts.map(item => item.candidate.seq)) : Infinity
    batch = [...cuts, ...others.filter(item => item.candidate.seq > firstCut), ...chooseBatch(others.filter(item => item.candidate.seq < firstCut), tokensOf, session.surface.nodes, options.share)]
  } else batch = chooseBatch(planned, tokensOf, session.surface.nodes, options.share)
  if (batch.length === 0) return { kind: 'skipped', reason: 'not_worth_it' }
  if (pass.trigger) {
    // The stock pruner runs only while the prompt is still at the trigger. If these replacements bring it under while results it would
    // cut stay in full, nothing cuts them and the prompt is back at the trigger a few steps later (a repeated cache rewrite): so write
    // only if the pruner will still run, or nothing it would cut is left.
    const inBatch = new Set(batch.map(item => item.candidate.seq))
    const left = entries.some(({ seq, event, message }) => event.type === 'tool/result' && !inBatch.has(seq) && Array.from(textOnly(message) ?? '').length > pass.trigger!.thresholdChars)
    const projected = measurement.totalTokens - batch.reduce((sum, item) => sum + (item.beforeTokens - item.afterTokens), 0)
    if (left && projected < pass.activationTokens) return { kind: 'skipped', reason: 'would_leave_cuts' }
  }

  // The engine took time. Write only if nothing was replaced or compacted meanwhile.
  if (pass.signal?.aborted) return { kind: 'skipped', reason: 'aborted' }
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
      pass.observe?.({ kind: 'applied', key: itemKey(seq, item.candidate.text.length), origin })
      applied.push({ originalSeq: seq, replacementSeq: written.seq, toolName: item.candidate.toolName, beforeTokens: item.beforeTokens, afterTokens: item.afterTokens })
    } catch {
      break // what was written is a complete pair; stop before anything half-written
    }
  }
  if (applied.length === 0) return { kind: 'skipped', reason: 'surface_changed' }
  return { kind: 'applied', applied, freedTokens: applied.reduce((sum, a) => sum + (a.beforeTokens - a.afterTokens), 0), candidates: candidates.length }
}
