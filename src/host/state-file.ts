import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Write one of our state files atomically, readable by its owner only: pins are the user's own standing instructions. The folder is ours
 * (`<Harness home>/tameru`), so it is closed to other users too; a leftover temporary file is removed, never written through.
 */
export function writePrivate(path: string, text: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    chmodSync(directory, 0o700)
  } catch {
    // a folder we cannot tighten still holds files only we can read
  }
  const temporary = `${path}.${process.pid}.tmp`
  rmSync(temporary, { force: true })
  writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}
