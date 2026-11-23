import type { WorkerStatus } from '../shared/protocol.ts'
import type { PythonChoice } from './python.ts'
import type { ChatStats } from './step.ts'
import type { Effective } from './settings.ts'

export interface StatusInput {
  pluginVersion: string
  enabled: boolean
  python: PythonChoice | undefined
  worker: WorkerStatus | undefined
  chat?: ChatStats | undefined
  /** How many lines the user has pinned in this chat. */
  pins?: number
  /** The settings in force, from `resolveEffective`. */
  effective?: Effective
}

const REASONS: Record<string, string> = {
  below_activation: 'the context is still below the point where Tameru starts',
  no_candidates: 'no old large tool result is eligible yet',
  not_confident: 'the engine was not confident enough in its extract to risk losing a fact',
  longer_than_stock_cut: "the extract would have been longer than the Harness's own cut",
  would_leave_cuts: "the Harness's own cut will handle these results, so Tameru left them to it",
  not_worth_it: 'shortening would not have paid for rewriting the prompt cache',
  surface_changed: 'the chat changed while the engine worked',
  compaction_open: 'the Harness is compacting',
  engine_unavailable: 'the engine did not answer',
  managed_elsewhere: "another plugin manages this chat's context",
  no_request_yet: 'the chat has not made a model request yet',
  no_context_window: 'the model declares no context window',
  unusable_context_window: "the model's context window is too small for the Harness's own settings",
  no_token_meter: 'the Harness has no token meter',
  off: 'shortening is switched off',
  error: 'an error (see the Harness log)',
  aborted: 'the turn was cancelled',
  over_budget: 'the engine took longer than a step can wait',
}

/** The text `/tameru` shows. Plain, short, and honest about what is and is not working. */
export function statusText(input: StatusInput): string {
  const lines = [`Tameru ${input.pluginVersion} for DeepSeek Harness`]
  if (!input.enabled) {
    lines.push('Off: Tameru does nothing and the Harness behaves as stock.')
    return lines.join('\n')
  }
  if (!input.python) {
    lines.push('Shortening is off: no Python was found for the engine (pins and the Artifact Trail still work).')
    lines.push("Set `pythonPath` in Tameru's settings, or let the Harness create its bundled Python runtime.")
    if (input.pins) lines.push(`${input.pins} pinned line${input.pins === 1 ? '' : 's'} in this chat (/tameru pins).`)
    return lines.join('\n')
  }
  const worker = input.worker
  const version = worker?.version
  if (version) {
    lines.push(`Engine ${version.engineVersion} (matches source commit ${version.vendoredFrom?.slice(0, 7) ?? 'unknown'}), protocol ${version.protocol}${version.resultSchema === undefined ? '' : `, result schema ${version.resultSchema}`}, Python ${version.python}.`)
  } else {
    lines.push(`Engine not started yet (Python: ${input.python.path}).`)
  }
  if (worker?.state === 'disabled') {
    lines.push(`The engine stopped after repeated failures (${worker.lastError ?? 'unknown'}); the Harness is behaving as stock.`)
  } else if (worker?.lastError) {
    lines.push(`Last problem: ${worker.lastError}. When the engine fails, the original text is left as it is.`)
  }
  const effective = input.effective
  if (effective) {
    lines.push(`Channel ${effective.channel}${effective.channel === 'beta' ? ' (unconfirmed candidates)' : ''}: policy ${effective.policy}, confidence gate ${effective.minConfidence}${effective.policy === 'every-step' ? `, starts at ${Math.round(effective.activation * 100)}% of the Harness's trigger` : ", at the Harness's own trigger"}${effective.shorten ? '' : ' (shortening is off)'}.`)
  }
  const chat = input.chat
  if (chat && chat.shortened > 0) {
    lines.push(`In this chat: shortened ${chat.shortened} tool result${chat.shortened === 1 ? '' : 's'}, freeing about ${chat.freedTokens.toLocaleString('en-US')} tokens.`)
  } else if (chat?.lastSkip) {
    lines.push(`Nothing shortened in this chat yet: ${REASONS[chat.lastSkip] ?? chat.lastSkip}.`)
  } else {
    lines.push('Nothing shortened in this chat yet.')
  }
  const reasons = Object.entries(chat?.reasons ?? {})
  if (reasons.length > 0) lines.push(`The engine's decisions in this chat: ${reasons.map(([reason, count]) => `${reason.replace(/_/g, ' ')} ${count}`).join(', ')}.`)
  if (input.pins) lines.push(`${input.pins} pinned line${input.pins === 1 ? '' : 's'} in this chat (/tameru pins).`)
  return lines.join('\n')
}
