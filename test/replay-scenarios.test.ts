// The replay's scenario families and splits, and the discipline around the fresh holdout. Nothing here runs the holdout: generating its
// scenarios to hash them is not running them.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HOLDOUT_FAMILIES, HOLDOUT_LOOKS_FILE, LOOK_TOKEN, burnedHashes, holdoutHash, loadHoldout, refuseBurned, registeredHash } from '../scripts/replay/holdout.ts'
import { developmentPool, scenariosFor, splitOf } from '../scripts/replay/scenarios.ts'
import { root } from './helpers/harness.ts'

test('the development pool is 60 scenarios in three families, split 60/40 by a hash of the id inside every family', () => {
  const pool = developmentPool()
  assert.equal(pool.length, 60)
  assert.equal(scenariosFor('dev').length, 36)
  assert.equal(scenariosFor('validation').length, 24)
  for (const family of new Set(pool.map(s => s.family))) {
    assert.ok(pool.some(s => s.family === family && splitOf(s.id) === 'dev'), `${family} has development scenarios`)
    assert.ok(pool.some(s => s.family === family && splitOf(s.id) === 'validation'), `${family} has validation scenarios`)
  }
  assert.equal(new Set(pool.map(s => s.id)).size, 60, 'ids are unique')
  assert.deepEqual(developmentPool().map(s => s.id), pool.map(s => s.id))
})

test('scenarios are deterministic and every needed value is in exactly one output', () => {
  const again = developmentPool()
  developmentPool().forEach((s, i) => {
    assert.equal(JSON.stringify(s), JSON.stringify(again[i]), s.id)
    const text = s.steps.map(x => x.output).join('\n')
    for (const v of s.needed) assert.equal(text.split(v).length - 1, 1, `${s.id}: ${v}`)
  })
})

test('the fresh holdout has at least 40 scenarios in families the development pool does not use, with Chinese user messages', () => {
  const holdout = loadHoldout(LOOK_TOKEN)
  assert.ok(holdout.length >= 40)
  assert.ok(new Set(holdout.map(s => s.family)).size >= 8)
  const dev = new Set(developmentPool().map(s => s.family))
  for (const family of HOLDOUT_FAMILIES) assert.ok(!dev.has(family), `${family} is not a development family`)
  assert.ok(holdout.filter(s => s.lang === 'zh' && /[一-鿿]/.test(s.task)).length >= 20)
  for (const s of holdout) {
    const text = s.steps.map(x => x.output).join('\n')
    for (const v of s.needed) assert.equal(text.split(v).length - 1, 1, `${s.id}: ${v}`)
  }
  // no line of a development output repeats in the holdout: no shared filler
  const devLines = new Set(developmentPool().flatMap(s => s.steps.flatMap(x => x.output.split('\n').slice(0, 30))))
  const shared = holdout.flatMap(s => s.steps.flatMap(x => x.output.split('\n').slice(0, 30))).filter(line => devLines.has(line))
  assert.deepEqual(shared.slice(0, 3), [])
})

test('the committed hash is the hash of the holdout scenarios, so any edit to them is noticed', () => {
  const { hash, count } = holdoutHash()
  assert.equal(registeredHash(), hash)
  assert.equal(count, 48)
  assert.match(readFileSync(join(root, 'test', 'fixtures', 'replay', 'HOLDOUT.sha256'), 'utf8'), /^[0-9a-f]{64}  48 /)
})

test('the normal runner cannot read the holdout: the loader needs the look token and the runner needs --holdout', () => {
  assert.throws(() => loadHoldout(Symbol('anything')), /logged `--holdout` run/)
  const before = readFileSync(HOLDOUT_LOOKS_FILE, 'utf8')
  let failed = false
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'replay.ts'), '--split', 'holdout', '--out', join(root, 'never-written.jsonl')], { stdio: 'pipe' })
  } catch (error) {
    failed = true
    assert.match(String((error as { stderr?: Buffer }).stderr), /holdout is read only with --holdout/)
  }
  assert.ok(failed)
  assert.equal(readFileSync(HOLDOUT_LOOKS_FILE, 'utf8'), before, 'no look was logged')
  // the scenario, run, report and statistics modules never import it; the runner imports it only inside the --holdout path
  for (const file of ['scenarios.ts', 'run.ts', 'report.ts', 'stats.ts']) assert.ok(!/import[^\n]*holdout/i.test(readFileSync(join(root, 'scripts', 'replay', file), 'utf8')), file)
  const runner = readFileSync(join(root, 'scripts', 'replay.ts'), 'utf8')
  assert.match(runner, /await import\('\.\/replay\/holdout\.ts'\)/)
  assert.ok(!/^import[^\n]*holdout/im.test(runner))
})

test('the round 1 holdout is burned: the runner refuses --holdout for it before logging anything', () => {
  const round1 = 'ac9e77dd723d3755b8238c4a1e60d6947e798ddcc0ee489e9d2c10f2b5ca1489'
  assert.ok(burnedHashes().has(round1))
  assert.throws(() => refuseBurned(round1), /burned/)
  assert.doesNotThrow(() => refuseBurned('0'.repeat(64)))
  assert.equal(burnedHashes(join(root, 'no-such-file.md')).size, 0)
  const { hash } = holdoutHash()
  assert.equal(hash, round1, 'the current holdout is the burned round 1 set')
  // the guard was checked above before this ever runs the --holdout path; it must stop at once and log no look
  const before = readFileSync(HOLDOUT_LOOKS_FILE, 'utf8')
  let failed = false
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'replay.ts'), '--holdout', '--out', join(root, 'never-written.jsonl')], { stdio: 'pipe', env: { ...process.env, REPLAY_BASELINE_VENDOR: '' } })
  } catch (error) {
    failed = true
    assert.match(String((error as { stderr?: Buffer }).stderr), /is burned/)
  }
  assert.ok(failed)
  assert.equal(readFileSync(HOLDOUT_LOOKS_FILE, 'utf8'), before, 'no look was logged')
})
