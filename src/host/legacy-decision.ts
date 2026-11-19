import type { AcceptPolicy, CompressResult, Decision } from '../shared/protocol.ts'

/**
 * The acceptance rule of plugin 0.1.x, for a worker that speaks protocol 1 (an engine before 1.10.0) and therefore has no `decide()`.
 * It is the engine's `DSH_POLICY` without the token count (the host's own meter makes that check afterwards, on the message it would
 * write): not failed open, not sanitized, strictly shorter, confidence present and at least the policy's. Every number comes from the policy the
 * caller passes (the one it would have sent to a protocol 2 worker); this file holds no threshold of its own.
 * The vendored worker answers every compress request with a decision, so this runs only against an older worker.
 */
export function legacyDecision(result: CompressResult, original: string, policy: AcceptPolicy): Decision {
  if (result.failOpen) return { accept: false, reason: 'fail_open', basis: '' }
  if (result.sanitized && !policy.allowSanitized) return { accept: false, reason: 'sanitized', basis: '' }
  if (original.length - result.text.length <= policy.minSavedRatio * original.length) return { accept: false, reason: 'no_gain', basis: '' }
  if (result.confidence === null || result.confidence < policy.minConfidence) return { accept: false, reason: 'low_confidence', basis: '' }
  return { accept: true, reason: 'ok', basis: '' }
}
