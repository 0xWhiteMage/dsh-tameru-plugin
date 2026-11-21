// The session-corpus adapter (scripts/replay/corpus.ts): counts, slicing, the fact check against the corpus's gold, determinism and
// the sealed holdout. The hand-built scenario below follows SCHEMA.md; the export checks run when `dev/session_corpus` holds a local
// build (python -m benchmarks.session_corpus.build --split dev|validation --out dev/session_corpus, in the engine repository).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  CORPUS_COUNTS,
  CORPUS_FAMILIES,
  CORPUS_WINDOWS,
  HoldoutRefused,
  factPresence,
  loadScenarioWindows,
  promptText,
  readIndex,
  searchable,
  splitDir,
  stratifiedSubsample,
  toScenario,
  type CorpusSplit,
} from '../scripts/replay/corpus.ts'
import { root } from './helpers/harness.ts'

const step = (index: number, text: string, facts: any[] = [], kind = 'filler'): any => ({ index, tool: 'bash', args: { command: `make ${index}` }, kind, chars: text.length, planned_chars: text.length, facts, output_text: text })

/** A tiny scenario in the corpus's export format: 6 steps, windows 128K = 3 steps, 252K = 5, 500K = 6, 1M = 6. */
function tiny(over: Record<string, unknown> = {}): any {
  return {
    schema: 1,
    generator: 'session-corpus-3',
    id: 'cargo-99',
    family: 'cargo',
    index: 99,
    seed: 4242,
    language: 'mixed',
    task_style: 'vague',
    task: '运行测试并汇报',
    parameters: {},
    windows: { '128000': { steps: 3 }, '200000': { steps: 4 }, '252000': { steps: 5 }, '500000': { steps: 6 }, '1000000': { steps: 6 } },
    steps: [
      step(0, 'ok 1\nok 2\nexample_suite FAILED test_a (12)\nok 3', [{ id: 'f00', kind: 'natural', key: 'example_suite', value: 'test_a', line_index: 2 }], 'fact'),
      step(1, 'retries=1\nok', [{ id: 'f03', kind: 'stale', key: 'retries', value: '1', line_index: 0, superseded: true }], 'fact'),
      step(2, 'PASS\nPASS\nretries=7\nPASS', [{ id: 'f02', kind: 'buried', key: 'retries', value: '7', line_index: 2 }], 'fact'),
      step(3, 'error[E0425]: cannot find value `zz` in this scope\n  --> src/lib.rs:3', [{ id: 'f04', kind: 'error', key: 'E0425', value: 'zz', line_index: 0 }], 'error'),
      step(4, 'collected 3 items\n  FAILED tests/test_io.py::test_read - OSError  \nend', [{ id: 'r004.0', kind: 'real', key: 'which test fails', value: 'FAILED tests/test_io.py::test_read - OSError', line_index: 1 }], 'real'),
      step(5, 'tail line'),
    ],
    questions: [
      { id: 'q-f00', fact_ids: ['f00'], stratum: 'single', fact_kind: 'natural', first_window: 128000 },
      { id: 'q-f02', fact_ids: ['f02'], stratum: 'superseded', fact_kind: 'buried', first_window: 128000 },
      { id: 'q-f04', fact_ids: ['f04'], stratum: 'single', fact_kind: 'error', first_window: 252000 },
      { id: 'q-agg0', fact_ids: ['f00', 'f04'], stratum: 'aggregate', fact_kind: 'pair', first_window: 252000 },
      { id: 'q-absent', fact_ids: [], stratum: 'absent', fact_kind: 'none', first_window: 128000, expected: 'not present' },
      { id: 'q-r004.0', fact_ids: ['r004.0'], stratum: 'real', fact_kind: 'real', first_window: 252000 },
    ],
    ...over,
  }
}

test('the loader slices per window by the corpus step counts and maps every field', () => {
  const s128 = toScenario(tiny(), 128_000, 'dev')
  assert.equal(s128.steps.length, 3)
  assert.deepEqual(s128.corpus!.questions.map(q => q.id), ['q-f00', 'q-f02'])
  assert.deepEqual(s128.corpus!.facts.map(f => f.id), ['f00', 'f02'], 'the stale line is never a question fact')
  assert.equal(s128.lang, 'zh', 'mixed maps to zh')
  assert.equal(s128.corpus!.language, 'mixed', 'the corpus language is kept')
  assert.equal(s128.style, 'vague')
  assert.equal(s128.task, '运行测试并汇报')
  assert.deepEqual(s128.steps[0], { tool: 'bash', args: { command: 'make 0' }, output: tiny().steps[0].output_text })
  const s252 = toScenario(tiny(), 252_000, 'dev')
  assert.equal(s252.steps.length, 5)
  assert.deepEqual(s252.corpus!.questions.map(q => q.id), ['q-f00', 'q-f02', 'q-f04', 'q-agg0', 'q-r004.0'], 'absent is not a fact question')
  assert.deepEqual(s252.corpus!.facts.map(f => f.id), ['f00', 'f02', 'f04', 'r004.0'])
  assert.equal(s252.corpus!.facts.find(f => f.id === 'r004.0')!.line, 'FAILED tests/test_io.py::test_read - OSError', 'a real fact is held by its gold value line')
  assert.equal(s252.corpus!.facts.find(f => f.id === 'f00')!.line, 'example_suite FAILED test_a (12)')
  assert.deepEqual(s252.corpus!.facts.map(f => f.position), ['early', 'middle', 'middle', 'late'], 'step / steps(W) in thirds: 0/5, 2/5, 3/5, 4/5')
  assert.equal(toScenario(tiny(), 1_000_000, 'dev').steps.length, 6)
  assert.throws(() => toScenario(tiny({ windows: { '128000': { steps: 9 } } }), 128_000, 'dev'), /needs 9/)
})

test('the fact check: the fact line, or one line with key and value; real facts by their gold line; value-only is secondary', () => {
  const sc = toScenario(tiny(), 252_000, 'dev')
  const [f00, f02, f04, real] = sc.corpus!.facts as [any, any, any, any]
  const raw = searchable(sc.steps.map(s => s.output).join('\n'))
  for (const f of sc.corpus!.facts) assert.deepEqual(factPresence(f, raw), { line_present: true, value_present: true }, `${f.id} is held in the untouched session`)
  // an extract that collapsed whitespace still holds key and value on one line
  assert.equal(factPresence(f00, searchable('header\nexample_suite  FAILED  test_a  (12)')).line_present, true)
  // the value alone, on another line, is not held
  assert.deepEqual(factPresence(f00, searchable('test_a\nexample_suite passed')), { line_present: false, value_present: true })
  // a superseded key: only the newest line counts (the stale value 1 is not 7)
  assert.equal(factPresence(f02, searchable('retries=1')).line_present, false)
  assert.equal(factPresence(f02, searchable('x retries=7 y')).line_present, true)
  assert.equal(factPresence(f04, searchable('pruned')).line_present, false)
  // a real fact needs its gold line, not a key match
  assert.equal(factPresence(real, searchable('which test fails test_read')).line_present, false)
  assert.equal(factPresence(real, searchable('  FAILED tests/test_io.py::test_read - OSError')).line_present, true)
})

test('prompt text undoes JSON nesting: tool results and text blocks become plain lines', () => {
  const text = promptText([{ content: [{ type: 'text', text: 'a\nretries=7' }] }, { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'b "q"' }] }] }])
  assert.deepEqual(text.split('\n'), ['text', 'a', 'retries=7', 'tool_result', 'text', 'b "q"'])
})

test('the loader is deterministic', () => {
  for (const w of CORPUS_WINDOWS) assert.equal(JSON.stringify(toScenario(tiny(), w, 'dev')), JSON.stringify(toScenario(tiny(), w, 'dev')))
})

test('the loader refuses the holdout: split name, path, and any family outside the dev/validation deal', () => {
  assert.throws(() => splitDir('dev/session_corpus', 'holdout'), HoldoutRefused)
  assert.throws(() => splitDir(join('x', 'holdout', 'y'), 'dev'), HoldoutRefused)
  assert.throws(() => toScenario(tiny({ family: 'django' }), 128_000, 'dev'), HoldoutRefused)
  assert.throws(() => toScenario(tiny({ family: 'terraform' }), 128_000, 'dev'), HoldoutRefused, 'a holdout family')
  assert.throws(() => toScenario(tiny(), 128_000, 'validation'), HoldoutRefused, 'cargo is a dev family')
  // an index naming a holdout family is refused before any scenario file is read
  const dir = mkdtempSync(join(tmpdir(), 'corpus-'))
  mkdirSync(join(dir, 'dev', 'full'), { recursive: true })
  writeFileSync(join(dir, 'dev', 'full', 'index.json'), JSON.stringify([{ id: 'helm-00', family: 'helm' }]))
  assert.throws(() => readIndex(dir, 'dev'), HoldoutRefused)
  // the runner refuses --split holdout and --holdout with --corpus
  for (const extra of [['--split', 'holdout'], ['--split', 'dev', '--holdout']]) {
    assert.throws(() => execFileSync(process.execPath, [join(root, 'scripts', 'replay.ts'), '--corpus', dir, ...extra, '--arms', 'stock', '--out', join(dir, 'x.jsonl')], { stdio: 'pipe' }), /sealed/)
  }
  // no family is in both splits, and the counts are the corpus's
  assert.equal(CORPUS_FAMILIES.dev.filter(f => CORPUS_FAMILIES.validation.includes(f)).length, 0)
  assert.equal(CORPUS_FAMILIES.dev.length * 11, CORPUS_COUNTS.dev)
  assert.equal(CORPUS_FAMILIES.validation.length * 11, CORPUS_COUNTS.validation)
})

test('the stratified subsample takes the same number from every family, deterministically', () => {
  const entries = ['a', 'b', 'c'].flatMap(f => Array.from({ length: 11 }, (_, i) => ({ id: `${f}-${i}`, family: f })))
  const s = stratifiedSubsample(entries, 3, 'seed-1')
  assert.equal(s.length, 9)
  for (const f of ['a', 'b', 'c']) assert.equal(s.filter(e => e.family === f).length, 3)
  assert.deepEqual(stratifiedSubsample(entries, 3, 'seed-1'), s)
  assert.notDeepEqual(stratifiedSubsample(entries, 3, 'seed-2').map(e => e.id), s.map(e => e.id))
})

// ---- against a local export (skipped without one) --------------------------------------------------------------------------------------

const EXPORT = join(root, 'dev', 'session_corpus')
const haveExport = existsSync(join(EXPORT, 'dev', 'full', 'index.json')) && existsSync(join(EXPORT, 'validation', 'full', 'index.json'))

test('the local export: counts match the corpus, every slice matches its window table, and every fact holds against the gold', { skip: haveExport ? false : 'no local corpus export in dev/session_corpus' }, () => {
  for (const split of ['dev', 'validation'] as CorpusSplit[]) {
    const index = readIndex(EXPORT, split)
    assert.equal(index.length, CORPUS_COUNTS[split])
    assert.deepEqual([...new Set(index.map(e => e.family))].sort(), [...CORPUS_FAMILIES[split]].sort())
    // the first scenario of every family, at every window (a full pass over 220 files takes minutes; the replay itself reads them all)
    for (const family of CORPUS_FAMILIES[split]) {
      const entry = index.find(e => e.family === family)!
      const raw = JSON.parse(readFileSync(join(EXPORT, split, 'full', `${entry.id}.json`), 'utf8'))
      const sliced = loadScenarioWindows(EXPORT, split, entry, CORPUS_WINDOWS)
      for (const sc of sliced) {
        const w = sc.corpus!.window
        assert.equal(sc.steps.length, entry.windows[String(w)]!.steps, `${entry.id} ${w}: steps`)
        assert.equal(sc.corpus!.questions.length, raw.questions.filter((q: any) => q.first_window <= w && q.stratum !== 'absent').length)
        const gold = new Map<string, any>()
        raw.steps.slice(0, sc.steps.length).forEach((s: any) => s.facts.forEach((f: any) => gold.set(f.id, { ...f, text: s.output_text })))
        const text = searchable(sc.steps.map(s => s.output).join('\n'))
        for (const f of sc.corpus!.facts) {
          const g = gold.get(f.id)
          const line = g.text.split('\n')[g.line_index]
          assert.ok(line.includes(g.value), `${entry.id} ${f.id}: the gold line holds the value`)
          if (g.kind !== 'real') assert.ok(line.includes(g.key), `${entry.id} ${f.id}: the gold line holds the key`)
          assert.equal(factPresence(f, text).line_present, true, `${entry.id} ${w} ${f.id} is held in the untouched session`)
        }
      }
      assert.equal(JSON.stringify(loadScenarioWindows(EXPORT, split, entry, [252_000])[0]), JSON.stringify(sliced[1]), 'deterministic')
    }
  }
})
