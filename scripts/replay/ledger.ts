// The cumulative settings-tried ledger (engine docs/SETTINGS-TRIED-LEDGER.json, round-2 analysis plan section 8). The runner refuses an
// arm whose setting is not listed: a new setting is appended to the engine's ledger (append only) before it runs. The path comes from
// REPLAY_LEDGER; without it the committed copy docs/results/settings-tried-ledger.json is read.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ArmSpec } from './run.ts'

const here = dirname(fileURLToPath(import.meta.url))
export const LEDGER_COPY = join(here, '..', '..', 'docs', 'results', 'settings-tried-ledger.json')
export const ledgerPath = (): string => process.env.REPLAY_LEDGER ?? LEDGER_COPY

export interface Ledger {
  settings_tried: number
  settings: Array<{ n: number; id: string; target: string; setting: string }>
}

export const readLedger = (path = ledgerPath()): Ledger => JSON.parse(readFileSync(path, 'utf8')) as Ledger

/** Throws naming every arm that is neither a reference nor listed in the ledger (fail closed: an unreadable ledger is an error). */
export function refuseUnledgered(arms: ArmSpec[], ledger: Ledger = readLedger()): void {
  const ids = new Set(ledger.settings.filter(s => s.target === 'deepseek-plugin').map(s => s.id))
  const missing = arms.filter(a => !a.reference && (a.ledgerId === undefined || !ids.has(a.ledgerId))).map(a => a.name)
  if (missing.length) throw new Error(`arm(s) not in the settings-tried ledger (${ledgerPath()}): ${missing.join(', ')}; append the setting to the engine's ledger before running it`)
}
