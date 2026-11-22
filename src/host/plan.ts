/**
 * `policy: 'plan'` (beta): at the moment the Harness's own pruner is about to cut, the engine's `plan()` covers every result
 * stock would cut — `extract` when the candidate passes the hard vetoes and the EV rule and fits the stock cut, `stub` (the
 * stock head/marker/tail cut itself, byte-identical, see stub.ts) otherwise. The act covers the whole cut set at once, so
 * nothing stock would cut is left behind when the prompt drops under the trigger. The host-specific numbers live only here:
 * the stock pruner's config, the trigger, `n_eff` from the session's own growth, the DSH hard vetoes.
 */
import type { EngineClient } from './engine-client.ts'
import {
  ANCHOR_ERRORS,
  ENGINE_PRESET,
  PASS_BUDGET_MS,
  PRECOMPUTE_MAX,
  REDACT_SECRETS,
  TOO_LARGE_CHARS,
  compactionOpen,
  itemKey,
  readSurface,
  shortenedText,
  tooLargeText,
  type Applied,
  type MeterLike,
  type PassEvent,
  type PassOutcome,
  type SessionLike,
} from './shorten.ts'
import { codePointLength, measureContent, pruneContent, stockKeptChars, type StockPruneConfig } from './stub.ts'
import {
  KEPT_PREFIX,
  READ_TOOL,
  RESTORED_PREFIX,
  alreadyShortened,
  buildQuery,
  hasSpillNotice,
  queryPartsFor,
  textOnly,
  touchedByTameru,
  type Message,
  type SessionEvent,
} from './messages.ts'
import { RESTORE_REPLIES } from './originals.ts'
import type { CompressResult, PlanCandidate, PlanItem, PlanReply, PlanRequest } from '../shared/protocol.ts'

/** What a plan pass needs of the engine client: `compress` for candidates, `plan` (protocol 3) for the moment itself. */
export type PlanClient = Pick<EngineClient, 'compress'> & Partial<Pick<EngineClient, 'speaksV2' | 'speaksV3' | 'plan'>>

export interface PlanPassContext {
  session: SessionLike
  meter: MeterLike
  client: PlanClient
  header: unknown
  /** Tokens at which this pass acts: the Harness's own trigger. */
  activationTokens: number
  /** The stock pruner's config (the Harness's defaults unless told otherwise). */
  stockPruner: StockPruneConfig
  /** The EV rule's inputs: which price profile and which strength. */
  ev: { priceProfile: string; strength: 'less' | 'normal' | 'more' }
  /** Steps since the last plan act (the hysteresis input `K` compares it to). */
  stepsSinceLastAct?: number
  /** Mean tokens the session's prompt grew per step; absent or non-positive when unknown (`n_eff` takes the full horizon). */
  meanStepTokens?: number
  declined?: Set<string>
  reasons?: Record<string, number>
  observe?: (event: PassEvent) => void
  signal?: AbortSignal
  /** A second worker for precomputed extracts (see `PassContext.bgClient`). */
  bgClient?: PlanClient
  /** Extract results by item key; consulted before the inline call. Shared with `shortenPass`. */
  extractCache?: Map<string, Promise<CompressResult | undefined>>
}

const PLAN_K = 3
const N_EFF_MAX = 200
/** The wire's risk vocabulary; an answer outside it is carried as `high` (fail-safe, never a host decision). */
const RISK_LEVELS = new Set(['low', 'medium', 'high'])

interface PlannedItem {
  seq: number
  index: number
  event: SessionEvent
  message: Message
  /** The seq of the original result: own seq, unless it is a restored result being shortened again (as findCandidates). */
  origin: number
  /** The text a candidate would be extracted from; `undefined` when no text is extractable at all. */
  text: string | undefined
  chars: number
  /** What stock does to this result: `cut` when it is over the pruner's threshold, `keep` otherwise. */
  stockAction: 'cut' | 'keep'
  stubContent?: unknown[]
  stubTokens?: number
  /** Set when the engine answered for this item. */
  extract?: {
    newText: string
    replacement: Message
    beforeTokens: number
    afterTokens: number
    confidence: number | null
    failOpen: boolean
    risk: 'low' | 'medium' | 'high'
    factLinesDropped: number
  }
  /** What the ask came to: `answered` the engine gave a result, else why there is no candidate. */
  ask?: 'answered' | 'sanitized' | 'not_enough_tokens' | 'too_large'
}

/** One pass at the trigger. Never throws: a problem here must never cost the user a turn. */
export async function planPass(pass: PlanPassContext): Promise<PassOutcome> {
  const { session, meter, client, stockPruner: config } = pass
  if (pass.signal?.aborted) return { kind: 'skipped', reason: 'aborted' }
  if ((await client.speaksV3?.()) !== true) return { kind: 'skipped', reason: 'engine_unavailable' }
  const measurement = meter.measure(session, pass.header)
  if (measurement.totalTokens < pass.activationTokens) return { kind: 'skipped', reason: 'below_activation' }
  if (compactionOpen(session)) return { kind: 'skipped', reason: 'compaction_open' }
  const entries = readSurface(session)
  const tokensOf = new Map(measurement.nodes.map(node => [node.seq, node.heuristicTokens]))
  const keptChars = stockKeptChars(config)
  const note = (reason: string): void => {
    if (pass.reasons) pass.reasons[reason] = (pass.reasons[reason] ?? 0) + 1
  }

  // every tool result is an item; stock's cut set is its own measure (text code points over the threshold), nothing protected
  const items: PlannedItem[] = []
  const cuts: PlannedItem[] = []
  for (const [index, entry] of entries.entries()) {
    if (entry.event.type !== 'tool/result') continue
    const { message } = entry
    const chars = measureContent(message.content as Array<{ type: string; text?: string }>)
    const item: PlannedItem = { seq: entry.seq, index, event: entry.event, message, origin: entry.seq, text: textOnly(message), chars, stockAction: chars > config.thresholdChars ? 'cut' : 'keep' }
    items.push(item)
    if (item.stockAction !== 'cut') continue
    // a result the engine cannot analyse (`too_large`) plans to the header with its read-original reference, not a stub
    const stubContent = chars > TOO_LARGE_CHARS
      ? [{ type: 'text', text: tooLargeText(item.text ?? '', entry.seq) }]
      : pruneContent(message.content as Array<{ type: string; text?: string }>, config)
    if (stubContent === null) continue // chars > threshold makes a stub exist, but a missed one would leave the cut uncovered
    item.stubContent = stubContent
    item.stubTokens = meter.estimateMessage({ ...message, content: stubContent as Message['content'] })
    cuts.push(item)
  }
  if (cuts.length === 0) return { kind: 'skipped', reason: 'no_candidates' }

  // candidates: an extract per cut item, longest first within the step's time budget; the rest stay `no_candidate` stubs
  const generation = session.surface.replaceGeneration
  const lookup = entries.map(({ seq, message }) => ({ seq, message }))
  const callId = (item: PlannedItem): string => item.message.toolCallId ?? item.message.source?.callId ?? ''
  const started = Date.now()
  const remaining = () => Math.max(0, PASS_BUDGET_MS - (Date.now() - started))
  // background extracts: the same candidates on the second worker (largest first); the fetch loop prefers what finished
  if (pass.bgClient && pass.extractCache) {
    const bg = pass.bgClient
    let fired = 0
    for (const item of [...cuts].sort((a, b) => b.chars - a.chars)) {
      if (fired >= PRECOMPUTE_MAX) break
      const key = itemKey(item.seq, item.chars)
      const text = item.text
      if (text === undefined || text.length > TOO_LARGE_CHARS || alreadyShortened(text) || hasSpillNotice(text)) continue
      if (item.message.isError === true || item.message.source?.name === READ_TOOL) continue
      if (pass.extractCache.has(key) || pass.declined?.has(key)) continue
      pass.extractCache.set(key, bg.compress({
        text,
        query: buildQuery(lookup, item.index, callId(item)),
        preset: ENGINE_PRESET,
        anchorErrors: ANCHOR_ERRORS,
        redactSecrets: REDACT_SECRETS,
        queryParts: queryPartsFor(lookup, item.index, callId(item)),
        deriveSelectorQuery: true,
      }))
      fired++
    }
  }
  for (const item of [...cuts].sort((a, b) => b.chars - a.chars)) {
    if (Date.now() - started > PASS_BUDGET_MS || pass.signal?.aborted) break
    await (async () => {
      const key = itemKey(item.seq, item.chars)
      const text = item.text
      if (text === undefined || alreadyShortened(text) || hasSpillNotice(text)) return
      if (text.length > TOO_LARGE_CHARS) {
        item.ask = 'too_large' // the header above carries it; no engine call is sent
        return
      }
      if (item.message.isError === true || item.message.source?.name === READ_TOOL) return
      if (pass.declined?.has(key)) return
      // a restored result stays in full for a few replies, then is an ordinary candidate again, from its original text
      const sources = (item.event as unknown as { sourceEventSeqs?: number[] }).sourceEventSeqs
      const cited = sources?.[0] === undefined ? undefined : session.eventAt(sources[0])
      const citedText = cited?.type === 'tool/result' && cited.data.message ? textOnly(cited.data.message as Message) : undefined
      const ours = sources?.[0] !== undefined && cited?.type === 'tool/result' && citedText !== undefined && !touchedByTameru(citedText)
      if (ours && text.startsWith(KEPT_PREFIX)) return
      let sourceText = text
      if (ours && text.startsWith(RESTORED_PREFIX)) {
        const replies = entries.filter(later => later.message.role === 'assistant' && later.seq > item.seq).length
        if (replies < RESTORE_REPLIES) return
        sourceText = citedText!
        item.origin = sources![0]!
      }
      const request = {
        text: sourceText,
        query: buildQuery(lookup, item.index, callId(item)),
        preset: ENGINE_PRESET,
        anchorErrors: ANCHOR_ERRORS,
        redactSecrets: REDACT_SECRETS,
        queryParts: queryPartsFor(lookup, item.index, callId(item)),
        deriveSelectorQuery: true,
      }
      // the pass budget is enforced inside the call too: the remaining milliseconds cap the in-flight deadline
      const cached = pass.extractCache?.get(key)
      let result = cached !== undefined ? await Promise.race([cached, new Promise<undefined>(done => setTimeout(done, remaining()))]) : undefined
      result ??= await client.compress(request, remaining())
      if (result === undefined) return // an engine miss is not a decline; the stub covers the item
      if (result.sanitized) {
        item.ask = 'sanitized'
        return
      }
      const newText = shortenedText(sourceText, result.text, item.origin, result.dropped)
      const replacement: Message = { ...item.message, content: [{ type: 'text', text: newText }] }
      const beforeTokens = tokensOf.get(item.seq) ?? meter.estimateMessage(item.message)
      const afterTokens = meter.estimateMessage(replacement)
      if (afterTokens >= beforeTokens && !result.failOpen) {
        item.ask = 'not_enough_tokens'
        return
      }
      item.ask = 'answered'
      item.extract = {
        newText,
        replacement,
        beforeTokens,
        afterTokens,
        confidence: result.confidence,
        failOpen: result.failOpen,
        risk: RISK_LEVELS.has(result.risk as 'low') ? (result.risk as 'low' | 'medium' | 'high') : 'high',
        factLinesDropped: result.factLinesDropped ?? 0,
      }
    })()
  }
  if (pass.signal?.aborted) return { kind: 'skipped', reason: 'aborted' }

  // n_eff: the steps of headroom the act buys ((trigger - prompt after all stubs) / mean growth), clamped to the input range
  const projected = measurement.totalTokens - cuts.reduce((sum, item) => sum + ((tokensOf.get(item.seq) ?? meter.estimateMessage(item.message)) - item.stubTokens!), 0)
  const headroom = pass.activationTokens - projected
  const mean = pass.meanStepTokens ?? 0
  const nEff = headroom <= 0 ? 0 : mean > 0 ? Math.min(N_EFF_MAX, headroom / mean) : N_EFF_MAX

  const candidate = (item: PlannedItem): PlanCandidate | null =>
    item.extract === undefined
      ? null
      : {
          compressedChars: codePointLength(item.extract.newText),
          tokensSaved: Math.max(0, item.extract.beforeTokens - item.extract.afterTokens),
          confidence: item.extract.confidence,
          failOpen: item.extract.failOpen,
          risk: item.extract.risk,
          fingerprintsOk: true,
          factLinesDropped: item.extract.factLinesDropped,
        }
  const request: PlanRequest = {
    event: 'trigger',
    hostMode: 'prune',
    promptTokens: measurement.totalTokens,
    triggerTokens: pass.activationTokens,
    items: items.map((item): PlanItem => ({
      id: itemKey(item.seq, item.chars),
      position: item.index,
      tokens: tokensOf.get(item.seq) ?? meter.estimateMessage(item.message),
      chars: item.chars,
      ageSteps: entries.length - 1 - item.index,
      stockAction: item.stockAction,
      ...(item.stockAction === 'cut' ? { stockKeptChars: keptChars, candidate: candidate(item) } : {}),
      stratum: 'deepseek',
    })),
    cache: { warm: false, nEff },
    policy: {
      maxRisk: 'high',
      allowSanitized: false,
      minSavedRatio: 0,
      minTokensSaved: 1,
      ev: { priceProfile: pass.ev.priceProfile, lossProfile: 'replay-2026-11-21', strength: pass.ev.strength },
    },
    stepsSinceLastAct: pass.stepsSinceLastAct ?? null,
    K: PLAN_K,
    H: 0,
  }
  const reply: PlanReply | undefined = await client.plan?.(request)
  if (reply === undefined) return { kind: 'skipped', reason: 'engine_unavailable' }
  if (!reply.acted) {
    note(`gate:${reply.gate}`)
    return { kind: 'skipped', reason: 'no_candidates' }
  }

  // the engine took time; write only if nothing was replaced or compacted meanwhile (the ordinary pass's re-check)
  if (session.surface.replaceGeneration !== generation || compactionOpen(session)) return { kind: 'skipped', reason: 'surface_changed' }
  const onSurface = new Set(session.surface.nodes)
  const byId = new Map(items.map(item => [itemKey(item.seq, item.chars), item]))
  const applied: Applied[] = []
  for (const action of [...reply.actions].sort((a, b) => (byId.get(a.id)?.index ?? 0) - (byId.get(b.id)?.index ?? 0))) {
    const item = byId.get(action.id)
    if (!item) continue
    const key = action.id
    if (item.stockAction === 'keep') {
      if (action.action !== 'keep') note('out_of_contract') // the plan must not touch what stock would not cut
      continue
    }
    const isExtract = action.action === 'extract' && item.extract !== undefined
    if ((action.action !== 'extract' && action.action !== 'stub') || item.stubContent === undefined) {
      // a cut item must never be left uncovered; any other action on one is a coverage violation
      pass.observe?.({ kind: 'decline', key, reason: 'uncovered', event: 'trigger' })
      note('uncovered')
      continue
    }
    const stubText = (item.stubContent as Array<{ type: string; text?: string }>).map(b => b.text ?? '').join('')
    // the plan's verdict, recorded like the engine's own decisions; a stub's "extract" is the stub text it keeps
    if (item.ask === 'answered') {
      pass.observe?.({ kind: 'decision', key, accept: isExtract, reason: isExtract ? 'ok' : action.reason, original: item.text ?? stubText, extract: isExtract ? item.extract!.newText : stubText, event: 'trigger' })
    } else {
      pass.observe?.({ kind: 'decline', key, reason: item.ask ?? action.reason, event: 'trigger' })
    }
    note(isExtract ? 'ok' : `stub:${action.reason}`)
    if (!onSurface.has(item.seq)) {
      pass.observe?.({ kind: 'decline', key, reason: 'surface_changed', event: 'trigger' })
      continue
    }
    const replacement: Message = isExtract ? item.extract!.replacement : { ...item.message, content: item.stubContent as Message['content'] }
    const beforeTokens = item.extract?.beforeTokens ?? tokensOf.get(item.seq) ?? meter.estimateMessage(item.message)
    const afterTokens = isExtract ? item.extract!.afterTokens : item.stubTokens!
    try {
      // The price event must sit immediately before its replacement: the Harness's meter subtracts it from the replaced node.
      session.append('compaction/prune', {
        shadowedRange: { start: item.seq, end: item.seq },
        shadowedSeqs: [item.seq],
        shadowedTokenCount: meter.estimateMessage(item.message),
      })
      const written = session.append(
        'tool/result',
        { ...(item.event as { data: unknown }).data, message: replacement },
        { surfaceOp: { op: 'replace', startSeq: item.seq, endSeq: item.seq }, sourceEventSeqs: isExtract ? (item.origin === item.seq ? [item.seq] : [item.origin, item.seq]) : [item.seq] },
      )
      pass.observe?.({ kind: 'applied', key, origin: item.origin, event: 'trigger' })
      applied.push({ originalSeq: item.seq, replacementSeq: written.seq, toolName: item.message.source?.name ?? '', beforeTokens, afterTokens })
    } catch {
      break // what was written is a complete pair; stop before anything half-written
    }
  }
  if (applied.length === 0) return { kind: 'skipped', reason: 'surface_changed' }
  return { kind: 'applied', applied, freedTokens: applied.reduce((sum, a) => sum + (a.beforeTokens - a.afterTokens), 0), candidates: cuts.length }
}
