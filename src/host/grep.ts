import { textOnly } from './messages.ts'
import { listItems } from './originals.ts'
import type { SessionLike } from './shorten.ts'

export const MAX_GREP_MATCHES = 200
export const DEFAULT_GREP_MATCHES = 50
const GREP_PATTERN_CHARS = 120
const GREP_LINE_SCAN = 600
const GREP_LINE_SHOW = 300
const GREP_BUDGET_MS = 1500
const BRACE_REPEAT = /^\{\d*,\d*\}|^\{\d+\}/
const OPEN_REPEAT = /^\{\d+,\}/

/**
 * True for a regular expression the search will not run: one that can backtrack catastrophically (a back-reference, a look-around,
 * a repeated group that holds a repeat or an alternation) or that has more than three unbounded repeats. The pattern comes from the
 * model and the search runs inside the Harness, so the check is conservative; a refused pattern can be written as a literal.
 */
export function riskyPattern(pattern: string): boolean {
  if (/\\[1-9k]/.test(pattern) || /\(\?<?[=!]/.test(pattern)) return true
  const stack: Array<{ repeated: boolean; alternation: boolean }> = []
  let cur = { repeated: false, alternation: false }
  let unbounded = 0
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '\\') {
      i++
      continue
    }
    if (inClass) {
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '[') inClass = true
    else if (ch === '(') {
      stack.push(cur)
      cur = { repeated: false, alternation: false }
    } else if (ch === ')') {
      const inner = cur
      cur = stack.pop() ?? { repeated: false, alternation: false }
      const next = pattern[i + 1]
      const repeats = next === '+' || next === '*' || (next === '{' && BRACE_REPEAT.test(pattern.slice(i + 1)))
      if (repeats && (inner.repeated || inner.alternation)) return true
      if (repeats || inner.repeated) cur.repeated = true
      if (inner.alternation) cur.alternation = true
    } else if (ch === '|') cur.alternation = true
    else if (ch === '+' || ch === '*') {
      cur.repeated = true
      unbounded++
    } else if (ch === '{' && BRACE_REPEAT.test(pattern.slice(i))) {
      cur.repeated = true
      if (OPEN_REPEAT.test(pattern.slice(i))) unbounded++
    }
  }
  return unbounded > 3
}

export type GrepResult = { ok: true; text: string; matches: number; shown: number } | { ok: false; reason: string }

const escapeLiteral = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The lines of a result's original that match `pattern`, with their line numbers. A literal is matched as plain text, otherwise the
 * pattern is a regular expression (refused when `riskyPattern`). Lines are matched up to 600 characters and shown up to 300; at most
 * `max` lines come back (200 at most), and the search stops after 1.5 seconds. Only results Tameru shortened can be searched.
 */
export function grepOriginal(session: SessionLike, ref: number, pattern: string, options: { literal?: boolean; ignoreCase?: boolean; max?: number } = {}): GrepResult {
  if (!Number.isInteger(ref) || ref < 0) return { ok: false, reason: 'the reference must be a whole number' }
  if (typeof pattern !== 'string' || pattern === '' || pattern.length > GREP_PATTERN_CHARS) return { ok: false, reason: `the pattern must be 1 to ${GREP_PATTERN_CHARS} characters` }
  const item = listItems(session).find(candidate => candidate.ref === ref)
  if (!item) return { ok: false, reason: `no result shortened by Tameru has reference ${ref} in this chat` }
  const flags = options.ignoreCase === true ? 'i' : ''
  let matcher: RegExp
  if (options.literal === true) matcher = new RegExp(escapeLiteral(pattern), flags)
  else {
    if (riskyPattern(pattern)) return { ok: false, reason: 'that pattern can run very long: search for a literal (literal: true) or write a simpler pattern' }
    try {
      matcher = new RegExp(pattern, flags)
    } catch {
      return { ok: false, reason: 'the pattern is not a valid regular expression' }
    }
  }
  const cap = Math.max(1, Math.min(Number.isInteger(options.max) ? options.max! : DEFAULT_GREP_MATCHES, MAX_GREP_MATCHES))
  const lines = textOnly(session.eventAt(ref)!.data.message!)!.split('\n')
  const started = Date.now()
  const out: string[] = []
  let matches = 0
  let stopped = false
  for (let i = 0; i < lines.length; i++) {
    if (i % 256 === 255 && Date.now() - started > GREP_BUDGET_MS) {
      stopped = true
      break
    }
    const line = lines[i]!
    if (!matcher.test(line.length > GREP_LINE_SCAN ? line.slice(0, GREP_LINE_SCAN) : line)) continue
    matches++
    if (out.length < cap) out.push(`${i + 1}: ${line.length > GREP_LINE_SHOW ? `${line.slice(0, GREP_LINE_SHOW)}…` : line}`)
  }
  const note = `[${matches} matching line${matches === 1 ? '' : 's'}${stopped ? ` so far (the search stopped after ${GREP_BUDGET_MS} ms)` : ''} of ${lines.length}${matches > out.length ? `; the first ${out.length} are shown, narrow the pattern or read a window with offset` : ''}]`
  return { ok: true, text: out.length ? `${out.join('\n')}\n\n${note}` : note, matches, shown: out.length }
}
