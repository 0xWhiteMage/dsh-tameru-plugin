// Acceptance belongs to the engine's `decide()`: no host file may hold its own confidence, risk or fingerprint threshold.
// The strength menu's numbers (0.85, 0.7, 0.55) are the only such values here, and they are passed to the worker as the policy.
import assert from 'node:assert/strict'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? walk(join(dir, entry.name)) : /\.(ts|tsx)$/.test(entry.name) ? [join(dir, entry.name)] : []))

const NAME = String.raw`[\w.]*(?:confidence|risk|fingerprint)\w*`
const COMPARE = String.raw`(?:<=?|>=?|===?|!==?)`
const RULES: Array<[string, RegExp]> = [
  ['a confidence, risk or fingerprint value compared with a number', new RegExp(String.raw`${NAME}\s*${COMPARE}\s*-?\d`, 'i')],
  ['a number compared with a confidence, risk or fingerprint value', new RegExp(String.raw`-?\d[\d.]*\s*${COMPARE}\s*${NAME}`, 'i')],
  ['risk compared with a level name', new RegExp(String.raw`risk\w*\s*${COMPARE}\s*['"\x60](?:low|medium|high)|['"\x60](?:low|medium|high)['"\x60]\s*${COMPARE}\s*\w*risk`, 'i')],
  ['confidence compared with anything but the policy\'s floor', /\bconfidence\s*(?:<=?|>=?)\s*(?!policy\.minConfidence\b)\S/i],
]

/** The findings in `source`: code lines only (comment lines are prose), with the rule that matched. */
export function findThresholds(source: string): string[] {
  const found: string[] = []
  source.split('\n').forEach((line, index) => {
    const code = line.trim()
    if (code.startsWith('*') || code.startsWith('/*') || code.startsWith('//')) return
    for (const [name, rule] of RULES) if (rule.test(code.replace(/\/\/.*$/, ''))) found.push(`line ${index + 1}: ${name}: ${code}`)
  })
  return found
}

test('the rules catch what they are meant to catch', () => {
  for (const planted of [
    'if (result.confidence < 0.7) return',
    'if (confidence >= 0.5) ok()',
    'if (0.9 <= result.confidence) ok()',
    "if (result.risk === 'high') return",
    "if (riskLevel !== 'low') skip()",
    'if (result.confidence < options.minConfidence) skip()',
    'if (lostFingerprints > 0) skip()',
  ]) assert.ok(findThresholds(planted).length >= 1, planted)
  for (const fine of [
    'if (result.confidence < policy.minConfidence) return',
    'const policy = { minConfidence: options.minConfidence, minSavedRatio: 0 }',
    '  * the confidence must be at least 0.7',
    '// risk is high',
    "{ id: 'normal', minConfidence: 0.7 },",
  ]) assert.deepEqual(findThresholds(fine), [], fine)
})

test('no host file decides on confidence, risk or fingerprints: those numbers are passed to the worker, not applied here', () => {
  const files = [...walk(join(root, 'src', 'host')), ...walk(join(root, 'src', 'shared')), ...walk(join(root, 'src', 'client'))]
  assert.ok(files.length >= 15)
  const problems = files.flatMap(file => findThresholds(readFileSync(file, 'utf8')).map(finding => `${relative(root, file)} ${finding}`))
  assert.deepEqual(problems, [])
})

test('shorten.ts acts on the engine\'s decision only: it reads no confidence, risk, fail-open or sanitized flag', () => {
  const source = readFileSync(join(root, 'src', 'host', 'shorten.ts'), 'utf8')
  const code = source.split('\n').filter(line => !/^\s*(\*|\/\*|\/\/)/.test(line)).join('\n')
  assert.deepEqual(code.match(/\.(confidence|risk|failOpen|sanitized|tokensSavedPct)\b/g), null)
  assert.match(code, /decision\.accept/)
  // the one place that still holds a rule of its own is the fallback for a worker without `decide()`, and it takes every number from the policy
  const legacy = readFileSync(join(root, 'src', 'host', 'legacy-decision.ts'), 'utf8')
  assert.deepEqual(findThresholds(legacy), [])
})

test('the engine\'s package data ships: presets.json is vendored, listed for the package, and kept byte for byte', () => {
  const vendored = join(root, 'vendor', 'tameru', 'presets.json')
  assert.ok(existsSync(vendored))
  assert.ok(Object.keys(JSON.parse(readFileSync(vendored, 'utf8')).presets).includes('dsh-tool-result@1'))
  const attributes = readFileSync(join(root, '.gitattributes'), 'utf8')
  assert.match(attributes, /^vendor\/tameru\/\*\* -text$/m, 'the vendored tree is never line-ending converted')
  const pack = JSON.parse(execSync('npm pack --dry-run --json --ignore-scripts', { cwd: root, encoding: 'utf8' }))
  const entry = Array.isArray(pack) ? pack[0] : Object.values(pack)[0]   // npm 12 keys the report by package name
  const shipped: string[] = entry.files.map((file: { path: string }) => file.path.replace(/\\/g, '/'))
  for (const file of ['vendor/tameru/presets.json', 'vendor/tameru/protocol.py', 'vendor/tameru/decide.py', 'vendor/run_worker.py']) assert.ok(shipped.includes(file), `${file} is in the package`)
  assert.ok(!shipped.some(file => file.endsWith('.pyc')))
})

test('the vendored engine is the engine, byte for byte (when the engine checkout is next to this one)', { skip: !existsSync(process.env.TAMERU_ENGINE ?? join(root, '..', 'Tameru', '.git')) }, () => {
  const engine = process.env.TAMERU_ENGINE ?? join(root, '..', 'Tameru')
  const python = process.env.TAMERU_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  const out = execFileSync(python, [join(root, 'scripts', 'check_vendored.py'), '--engine', engine], { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } })
  assert.match(out, /matches engine commit/)
})
