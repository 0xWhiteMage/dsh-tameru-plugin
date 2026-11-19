// Writes (--write) or checks (--verify) the committed record of the fresh holdout: test/fixtures/replay/HOLDOUT.sha256 (the hash of the
// canonical text of every scenario) and holdout-definitions.json (which scenarios, per-scenario hashes). Generating the scenarios to
// hash them is not running them: no engine, no Harness, nothing is measured here.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOLDOUT_DIR, HOLDOUT_FAMILIES, HOLDOUT_HASH_FILE, HOLDOUT_LOOKS_FILE, holdoutHash, registeredHash } from './holdout.ts'

const { hash, count, perScenario } = holdoutHash()
if (process.argv.includes('--write')) {
  mkdirSync(HOLDOUT_DIR, { recursive: true })
  writeFileSync(HOLDOUT_HASH_FILE, `${hash}  ${count} fresh holdout scenarios in ${HOLDOUT_FAMILIES.length} families (sha256 over "id:sha256(canonical scenario)" lines, sorted by id; scripts/replay/holdout.ts)\n`)
  writeFileSync(join(HOLDOUT_DIR, 'holdout-definitions.json'), `${JSON.stringify({ hash, count, families: HOLDOUT_FAMILIES, scenarios: perScenario }, null, 2)}\n`)
  if (!existsSync(HOLDOUT_LOOKS_FILE)) writeFileSync(HOLDOUT_LOOKS_FILE, '[]\n')
  console.log(`registered ${count} scenarios: ${hash}`)
} else {
  const ok = registeredHash() === hash && JSON.parse(readFileSync(join(HOLDOUT_DIR, 'holdout-definitions.json'), 'utf8')).hash === hash
  console.log(ok ? `holdout matches HOLDOUT.sha256 (${count} scenarios, ${hash})` : `MISMATCH: scenarios hash to ${hash}, registered ${registeredHash()}`)
  process.exitCode = ok ? 0 : 1
}
