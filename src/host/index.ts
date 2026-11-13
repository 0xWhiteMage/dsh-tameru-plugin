import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngineClient } from './engine-client.ts'
import { harnessWorkerSpawn, type HarnessSubprocess } from './process.ts'
import { findPython } from './python.ts'
import { statusText } from './status.ts'

/**
 * Tameru for DeepSeek Harness: host half.
 *
 * Nothing stock is replaced, disabled or wrapped. This plugin only adds a service, a command and (in later steps) listeners, and
 * with `enabled: false` it adds nothing at all.
 */
export const name = 'dsh-tameru'
export const inject = ['commands', 'subprocess']

export interface TameruConfig {
  enabled?: boolean
  /** Path to a Python 3.10+ interpreter for the engine. Default: the interpreter the Harness bundles. */
  pythonPath?: string
}

interface CommandsService {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler: (call: { rawInput?: string }) => Promise<{ kind: 'success' | 'error'; text: string }> | { kind: 'success' | 'error'; text: string }
  }): unknown
}

interface HostContext {
  commands: CommandsService
  subprocess: HarnessSubprocess
  /** Cordis: run `setup` now; the function it returns runs when the plugin is unloaded. */
  effect(setup: () => () => void, label?: string): unknown
  logger?: (scope: string) => { info(message: string): unknown; warn(message: string): unknown }
}

/** The folder this package lives in: the nearest ancestor with a package.json named `dsh-tameru`. */
export function packageDir(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from
  for (let depth = 0; depth < 6; depth++) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).name === 'dsh-tameru') return dir
      } catch {
        // keep climbing
      }
    }
    dir = dirname(dir)
  }
  return from
}

function pluginVersion(dir: string): string {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export function apply(ctx: HostContext, config: TameruConfig = {}): void {
  const enabled = config.enabled !== false
  if (!enabled) return
  const dir = packageDir()
  const version = pluginVersion(dir)
  const python = findPython(config.pythonPath ? { configured: config.pythonPath } : {})
  let client: EngineClient | undefined
  if (python) {
    const stop = new AbortController()
    client = new EngineClient(harnessWorkerSpawn(ctx.subprocess, python.path, join(dir, 'vendor', 'run_worker.py'), dir, stop.signal))
    const worker = client
    ctx.effect(() => () => {
      stop.abort()
      void worker.dispose()
    }, 'dsh-tameru: engine worker')
  }
  const log = ctx.logger?.('tameru')
  if (python) log?.info(`dsh-tameru ${version} loaded (engine Python: ${python.path}, from ${python.source})`)
  else log?.warn(`dsh-tameru ${version} loaded but no Python was found: the Harness behaves as stock. Set pythonPath in Tameru's settings.`)
  ctx.commands.register({
    name: 'tameru',
    description: 'Show what Tameru is doing in this chat',
    handler: async () => {
      if (client && !client.status().version) await client.probe()
      return { kind: 'success', text: statusText({ pluginVersion: version, enabled, python, worker: client?.status() }) }
    },
  })
}
