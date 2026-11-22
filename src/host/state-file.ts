import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const posix = process.platform !== 'win32'

/**
 * Make and check our state folder (`<Harness home>/tameru`): a real folder, not a link, owned by this user and closed to everyone else.
 * Pins are the user's own standing instructions, so a folder that is not safe is refused (this throws) rather than used.
 */
export function securePrivateDir(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  if (!stat.isDirectory()) throw new Error(`${directory} is not a folder`)
  if (!posix) return
  if (stat.uid !== process.getuid?.()) throw new Error(`${directory} belongs to another user`)
  if ((stat.mode & 0o077) !== 0) chmodSync(directory, 0o700)
}

/** One of our state files, or `undefined` when it is missing or not safe to trust: in an unsafe folder, a link, or another user's file. */
export function readPrivate(path: string): string | undefined {
  try {
    securePrivateDir(dirname(path))
  } catch {
    return undefined
  }
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    return undefined
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || (posix && stat.uid !== process.getuid?.())) return undefined
    // a file left readable by an older version is closed before it is read
    if (posix && (stat.mode & 0o077) !== 0) fchmodSync(fd, 0o600)
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/** Write one of our state files atomically, readable by its owner only. A leftover temporary file is removed, never written through. */
export function writePrivate(path: string, text: string): void {
  securePrivateDir(dirname(path))
  const temporary = `${path}.${process.pid}.tmp`
  rmSync(temporary, { force: true })
  writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}
