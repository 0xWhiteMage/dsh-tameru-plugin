import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface PythonLookup {
  /** An explicit setting wins. */
  configured?: string
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
  home?: () => string
}

export interface PythonChoice {
  path: string
  source: 'setting' | 'harness-runtime' | 'system'
}

/** `$DSH_HOME`, falling back to `~/.dsh` exactly as the Harness does. */
export function dshHome(lookup: PythonLookup = {}): string {
  const env = lookup.env ?? process.env
  const configured = env.DSH_HOME?.trim()
  return configured ? configured : join((lookup.home ?? homedir)(), '.dsh')
}

/**
 * Where to find a Python for the worker, in order: the setting; the interpreter bundled with the Harness; on Linux and macOS
 * only, `python3` on the PATH. On Windows there is no bare `python` fallback: that name can resolve to the Microsoft Store alias.
 * Returns `undefined` when none applies, and the plugin then leaves everything as stock and says why.
 */
export function findPython(lookup: PythonLookup = {}): PythonChoice | undefined {
  const exists = lookup.exists ?? existsSync
  const platform = lookup.platform ?? process.platform
  const configured = lookup.configured?.trim()
  if (configured) return exists(configured) ? { path: configured, source: 'setting' } : undefined
  const bundled =
    platform === 'win32'
      ? join(dshHome(lookup), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
      : join(dshHome(lookup), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'bin', 'python3')
  if (exists(bundled)) return { path: bundled, source: 'harness-runtime' }
  if (platform !== 'win32') return { path: 'python3', source: 'system' }
  return undefined
}
