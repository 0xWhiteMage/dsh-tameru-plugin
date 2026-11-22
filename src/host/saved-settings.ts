import { join } from 'node:path'
import { normalizeSettings } from './settings.ts'
import { readPrivate, writePrivate } from './state-file.ts'
import type { TameruSettings } from './step.ts'

/**
 * Settings the user changed in the Tameru panel, in one small file of our own (`<Harness home>/tameru/settings.json`). They sit on top of
 * the values in the profile's patch file and survive a restart. A damaged file reads as empty; nothing here ever throws.
 */
export function readSaved(directory: string): TameruSettings {
  try {
    const parsed = JSON.parse(readPrivate(join(directory, 'settings.json')) ?? '') as { version?: number; settings?: unknown }
    if (parsed?.version === 2) return normalizeSettings(parsed.settings)
  } catch {
    // missing or damaged: nothing saved
  }
  return {}
}

/** Write the saved settings atomically. Returns an error message, or `undefined` on success. */
export function writeSaved(directory: string, settings: TameruSettings): string | undefined {
  try {
    writePrivate(join(directory, 'settings.json'), JSON.stringify({ version: 2, settings }))
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
