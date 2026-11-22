import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// Modes and owners are POSIX only: on Windows the folder keeps the access list it inherits from the user's profile, and only the link and
// plain-file checks apply.
const posix = process.platform !== 'win32'

const refused = (path: string, why: string): Error => new Error(`${path} ${why}, so Tameru leaves it alone`)

/**
 * Make and check our state folder (`<Harness home>/tameru`): a real folder, not a link, owned by this user and closed to everyone else.
 * Pins are the user's own standing instructions, so a folder that is not safe is refused (this throws) rather than used. Access for
 * group and others is removed; the owner's own bits are left as they are, so a folder made read-only stays read-only.
 */
export function securePrivateDir(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  if (!stat.isDirectory()) throw refused(directory, 'is not a folder')
  if (!posix) return
  if (stat.uid !== process.getuid?.()) throw refused(directory, 'belongs to another user')
  if ((stat.mode & 0o077) !== 0) chmodSync(directory, stat.mode & 0o700)
}

/**
 * One of our state files, or `undefined` when it does not exist. Throws when it cannot be trusted or read: in an unsafe folder, a link or
 * anything but a plain file, a file with other names (hard links), another user's file, or one that changed between the check and the
 * open. Checked by name first: Windows has no O_NOFOLLOW, and a FIFO must not be opened at all; O_NONBLOCK keeps one swapped in from
 * stalling the host.
 */
export function readPrivate(path: string): string | undefined {
  securePrivateDir(dirname(path))
  let before: ReturnType<typeof lstatSync>
  try {
    before = lstatSync(path)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
  if (!before.isFile()) throw refused(path, 'is not a plain file')
  if (before.nlink > 1) throw refused(path, 'has other names (hard links)')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) throw refused(path, 'changed while it was being opened')
    if (posix && stat.uid !== process.getuid?.()) throw refused(path, 'belongs to another user')
    // a file left readable by an older version is closed before it is read
    if (posix && (stat.mode & 0o077) !== 0) fchmodSync(fd, stat.mode & 0o700)
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * Write one of our state files atomically, readable by its owner only. A file that is there but could not be read is never replaced, so
 * state that failed to load is not lost to the next save; a leftover temporary file is removed, never written through.
 */
export function writePrivate(path: string, text: string): void {
  readPrivate(path)
  const temporary = `${path}.${process.pid}.tmp`
  rmSync(temporary, { force: true })
  writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}
