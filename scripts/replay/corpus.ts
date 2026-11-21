// Adapter from the engine's host-neutral session corpus (Tameru benchmarks/session_corpus, SCHEMA.md and ADAPTERS.md) to the replay's
// Scenario. REPLAY ONLY. It reads the exported JSON files by path (never imports or runs the engine's package):
//
//   python -m benchmarks.session_corpus.build --split dev --out <plugin>/dev/session_corpus       (ignored; never committed)
//
// Per window W a session is `steps[0 : windows[W].steps]` (the corpus's `steps_for_window`); the questions answerable at W are those
// with `first_window <= W` (the `absent` question has no fact and is scored only by answer probes, so it is not a fact here). A fact is
// held when its full fact line is in the text, or, for a natural/error/buried fact whose whitespace an extract rewrote, when one line
// holds both its key and its value; a real (Squeez) fact is held when its gold `value` line is in the text. `value_present` (the value
// alone) is reported as a secondary column. A superseded question is held only through its newest line (the stale line is never a
// question fact); an aggregate question needs every fact.
//
// The holdout is sealed: this loader refuses a `holdout` split, any path with a `holdout` segment, and any scenario whose family is not
// one of the dev/validation families dealt in the corpus's splits.json (deal attempt 10, copied below), before reading a scenario file.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Scenario, Step } from './scenarios.ts'

export type CorpusSplit = 'dev' | 'validation'
export type CorpusLanguage = 'en' | 'zh' | 'mixed'
export type Position = 'early' | 'middle' | 'late'

/** The corpus's own splits.json (generator session-corpus-3, deal seed `session-corpus-round2-deal-10`): dev and validation only. */
export const CORPUS_GENERATOR = 'session-corpus-3'
export const CORPUS_FAMILIES: Record<CorpusSplit, readonly string[]> = {
  dev: ['cargo', 'gcc', 'ghactions', 'gotest', 'jest', 'kubectl', 'maven', 'metrics', 'pytest', 'rspec', 'sql', 'webpack'],
  validation: ['ansible', 'bazel', 'cmake', 'gitlog', 'grep', 'pglog', 'trace-node', 'trace-python'],
}
export const CORPUS_COUNTS: Record<CorpusSplit, number> = { dev: 132, validation: 88 }
/** The windows the round-2 replay runs on the corpus (200K exists in the corpus for the 200K regression only). */
export const CORPUS_WINDOWS = [128_000, 252_000, 500_000, 1_000_000] as const

export class HoldoutRefused extends Error {}

export interface CorpusFact {
  id: string
  kind: 'natural' | 'error' | 'buried' | 'real'
  key: string
  value: string
  /** The text whose presence means "held": the fact line (`output_text.split("\n")[line_index]`), or the gold value line (real). */
  line: string
  step: number
  position: Position
}

export interface CorpusQuestion {
  id: string
  stratum: 'single' | 'buried' | 'superseded' | 'aggregate' | 'real'
  fact_kind: string
  fact_ids: string[]
}

export interface CorpusInfo {
  split: CorpusSplit
  language: CorpusLanguage
  window: number
  /** steps(W): the slice length. */
  steps: number
  /** Every fact a question answerable at W needs (deduplicated, in id order). */
  facts: CorpusFact[]
  questions: CorpusQuestion[]
  /** Characters from real (Squeez) outputs in the slice, and all characters of the slice. */
  real_chars: number
  chars: number
}

export interface IndexEntry {
  id: string
  family: string
  language: CorpusLanguage
  task_style: 'specific' | 'vague'
  steps: number
  questions: number
  windows: Record<string, { steps: number; chars: number; trigger_tokens: { deepseek: number; hermes: number } }>
}

const SPLITS: CorpusSplit[] = ['dev', 'validation']

function refuseHoldoutPath(path: string): void {
  if (resolve(path).split(sep).some(seg => seg.toLowerCase() === 'holdout') || /[\\/]holdout([\\/]|$)/i.test(path)) throw new HoldoutRefused(`refusing ${path}: the corpus holdout is sealed (one logged look, never through this loader)`)
}

export function refuseFamily(family: string, split: CorpusSplit): void {
  if (!CORPUS_FAMILIES[split]?.includes(family)) throw new HoldoutRefused(`refusing family ${family}: not a ${split} family of the corpus deal (the holdout is sealed)`)
}

/** The directory of one split's full export: `<root>/<split>/full`. */
export function splitDir(root: string, split: string): string {
  if (!SPLITS.includes(split as CorpusSplit)) throw new HoldoutRefused(`refusing split ${split}: only dev and validation are read (the holdout is sealed)`)
  const dir = join(root, split, 'full')
  refuseHoldoutPath(dir)
  return dir
}

/** The split's index.json, checked: every family is a known family of that split. */
export function readIndex(root: string, split: CorpusSplit): IndexEntry[] {
  const dir = splitDir(root, split)
  const file = join(dir, 'index.json')
  if (!existsSync(file)) throw new Error(`no corpus export at ${dir}: run \`python -m benchmarks.session_corpus.build --split ${split} --out ${root}\` in the engine repository`)
  const index = JSON.parse(readFileSync(file, 'utf8')) as IndexEntry[]
  for (const e of index) refuseFamily(e.family, split)
  return index
}

const positionOf = (step: number, steps: number): Position => {
  const x = step / steps
  return x < 1 / 3 ? 'early' : x < 2 / 3 ? 'middle' : 'late'
}

/** One exported scenario (already parsed) at window W, as the replay's Scenario. Pure: the same input always gives the same output. */
export function toScenario(raw: any, window: number, split: CorpusSplit): Scenario {
  if (raw.schema !== 1) throw new Error(`${raw.id}: unknown corpus schema ${raw.schema}`)
  refuseFamily(String(raw.family), split)
  const w = raw.windows?.[String(window)]
  if (!w) throw new Error(`${raw.id}: no window ${window}`)
  const n = Number(w.steps)
  if (!(n > 0) || n > raw.steps.length) throw new Error(`${raw.id}: the export has ${raw.steps.length} steps, window ${window} needs ${n}`)
  const slice = raw.steps.slice(0, n) as any[]
  const steps: Step[] = slice.map(s => {
    if (typeof s.output_text !== 'string') throw new Error(`${raw.id}: step ${s.index} has no output_text (a hash-only export cannot be replayed)`)
    return { tool: String(s.tool), args: s.args as Record<string, unknown>, output: s.output_text }
  })
  const byId = new Map<string, CorpusFact>()
  for (const s of slice) {
    for (const f of s.facts as any[]) {
      if (f.kind === 'stale') continue
      const line = f.kind === 'real' ? String(f.value) : String(s.output_text.split('\n')[f.line_index])
      byId.set(f.id, { id: f.id, kind: f.kind, key: String(f.key), value: String(f.value), line, step: Number(s.index), position: positionOf(Number(s.index), n) })
    }
  }
  const questions: CorpusQuestion[] = (raw.questions as any[])
    .filter(q => q.first_window <= window && q.stratum !== 'absent')
    .map(q => ({ id: q.id, stratum: q.stratum, fact_kind: q.fact_kind, fact_ids: [...q.fact_ids] }))
  const needed = new Set<string>()
  for (const q of questions) {
    for (const id of q.fact_ids) {
      if (!byId.has(id)) throw new Error(`${raw.id}: question ${q.id} needs fact ${id}, which is not in the ${window} slice`)
      needed.add(id)
    }
  }
  const facts = [...needed].sort().map(id => byId.get(id)!)
  const chars = slice.reduce((a, s) => a + Array.from(s.output_text as string).length, 0)
  const realChars = slice.filter(s => s.kind === 'real').reduce((a, s) => a + Array.from(s.output_text as string).length, 0)
  const language = raw.language as CorpusLanguage
  return {
    id: String(raw.id),
    family: String(raw.family),
    seed: Number(raw.seed),
    lang: language === 'en' ? 'en' : 'zh',
    style: raw.task_style,
    task: String(raw.task),
    steps,
    needed: facts.map(f => f.value),
    corpus: { split, language, window, steps: n, facts, questions, real_chars: realChars, chars },
  }
}

/** Read one scenario file of a split at window W (the family is checked against the index before the file is read). */
export function loadScenario(root: string, split: CorpusSplit, entry: Pick<IndexEntry, 'id' | 'family'>, window: number): Scenario {
  refuseFamily(entry.family, split)
  const file = join(splitDir(root, split), `${entry.id}.json`)
  return toScenario(JSON.parse(readFileSync(file, 'utf8')), window, split)
}

/** Read one scenario file once and slice it at every window (the replay runs all windows of a scenario together). */
export function loadScenarioWindows(root: string, split: CorpusSplit, entry: Pick<IndexEntry, 'id' | 'family'>, windows: readonly number[]): Scenario[] {
  refuseFamily(entry.family, split)
  const raw = JSON.parse(readFileSync(join(splitDir(root, split), `${entry.id}.json`), 'utf8'))
  return windows.map(w => toScenario(raw, w, split))
}

// ---- the fact check (ADAPTERS.md, "Fact held") ----------------------------------------------------------------------------------------

export interface FactPresence {
  line_present: boolean
  value_present: boolean
}

/** Text with its lines, split once (a final prompt can be several MB). */
export interface Searchable {
  text: string
  lines: string[]
}
export const searchable = (text: string): Searchable => ({ text, lines: text.split('\n') })

export function factPresence(f: Pick<CorpusFact, 'kind' | 'key' | 'value' | 'line'>, s: Searchable): FactPresence {
  const value_present = s.text.includes(f.value)
  if (!value_present) return { line_present: false, value_present }
  if (s.text.includes(f.line)) return { line_present: true, value_present }
  if (f.kind === 'real') return { line_present: false, value_present }
  return { line_present: s.lines.some(l => l.includes(f.key) && l.includes(f.value)), value_present }
}

/** Every string inside a message's content, one per line: the text a model would read (tool results included), JSON escaping undone. */
export function promptText(messages: any[]): string {
  const out: string[] = []
  const walk = (x: unknown): void => {
    if (typeof x === 'string') out.push(x)
    else if (Array.isArray(x)) x.forEach(walk)
    else if (x && typeof x === 'object') for (const v of Object.values(x)) walk(v)
  }
  for (const m of messages) walk(m.content)
  return out.join('\n')
}

// ---- subsampling --------------------------------------------------------------------------------------------------------------------

/**
 * A deterministic stratified subsample: within every family the ids are ordered by sha256(`${seed}:${id}`) and the first `perFamily`
 * are taken. It depends only on the ids, the seed and the count.
 */
export function stratifiedSubsample<T extends { id: string; family: string }>(entries: T[], perFamily: number, seed: string): T[] {
  const byFamily = new Map<string, T[]>()
  for (const e of entries) byFamily.set(e.family, [...(byFamily.get(e.family) ?? []), e])
  const key = (id: string): string => createHash('sha256').update(`${seed}:${id}`).digest('hex')
  const keep = new Set<string>()
  for (const list of byFamily.values()) for (const e of [...list].sort((a, b) => (key(a.id) < key(b.id) ? -1 : 1)).slice(0, perFamily)) keep.add(e.id)
  return entries.filter(e => keep.has(e.id))
}
