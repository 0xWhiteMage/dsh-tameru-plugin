import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngineClient } from './engine-client.ts'
import { harnessWorkerSpawn, type HarnessSubprocess } from './process.ts'
import { findPython } from './python.ts'
import { normalizeSettings, type TameruConfig } from './settings.ts'
import { statusText } from './status.ts'
import { onPreStep, type ChatStats, type StepAgent } from './step.ts'

/**
 * Tameru for DeepSeek Harness: host half.
 *
 * Nothing stock is replaced, disabled or wrapped. This plugin adds a command and one `agent/pre-step` listener (registered after the
 * Harness's and DS Bot's, never `prepend`), and with `enabled: false` it adds nothing at all.
 */
export const name = 'dsh-tameru'
export const inject = ['commands', 'subprocess']

export type { TameruConfig }

interface CommandsService {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler: (call: { rawInput?: string; agent?: { session?: object } }) => Promise<{ kind: 'success' | 'error'; text: string }> | { kind: 'success' | 'error'; text: string }
  }): unknown
}

interface HostContext {
  commands: CommandsService
  subprocess: HarnessSubprocess
  /** Cordis: run `setup` now; the function it returns runs when the plugin is unloaded. */
  effect(setup: () => () => void, label?: string): unknown
  logger?: (scope: string) => { info(message: string): unknown; warn(message: string): unknown }
  /** Look up an optional Harness service by name; undefined when it is not mounted. */
  get?(name: string): any
  on?(event: 'agent/pre-step', listener: (payload: { agent: StepAgent; signal?: AbortSignal }, next: () => unknown) => unknown): unknown
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
  const settings = normalizeSettings(config)
  const python = findPython(config.pythonPath ? { configured: config.pythonPath } : {})
  const stats = new WeakMap<object, ChatStats>()
  const log = ctx.logger?.('tameru')
  let client: EngineClient | undefined
  if (python) {
    const stop = new AbortController()
    // A request waits on the engine inside a step boundary, so it gets a short deadline: a slow engine must never slow the chat.
    client = new EngineClient(harnessWorkerSpawn(ctx.subprocess, python.path, join(dir, 'vendor', 'run_worker.py'), dir, stop.signal), { timeoutMs: 4000 })
    const worker = client
    ctx.effect(() => () => {
      stop.abort()
      void worker.dispose()
    }, 'dsh-tameru: engine worker')
    const deps = {
      client: worker,
      meter: () => ctx.get?.('tokenMeter'),
      resolveModelInfo: async (provider: string, model: string, signal?: AbortSignal) => ctx.get?.('llm')?.resolveModelInfo(provider, model, signal),
      backendFor: (agent: StepAgent) => ctx.get?.('agentPresets')?.serviceFor?.(agent, 'compaction') ?? ctx.get?.('compaction'),
      settings,
      stats,
      ...(log ? { log } : {}),
    }
    // Never `prepend`: the Harness's backend and DS Bot run first. Whatever happens here, the step goes on.
    ctx.on?.('agent/pre-step', async ({ agent, signal }, next) => {
      await onPreStep(deps, agent, signal)
      return next()
    })
  }
  if (python) log?.info(`dsh-tameru ${version} loaded (engine Python: ${python.path}, from ${python.source})`)
  else log?.warn(`dsh-tameru ${version} loaded but no Python was found: the Harness behaves as stock. Set pythonPath in Tameru's settings.`)
  ctx.commands.register({
    name: 'tameru',
    description: 'Show what Tameru is doing in this chat',
    handler: async ({ agent }) => {
      if (client && !client.status().version) await client.probe()
      const chat = agent?.session ? stats.get(agent.session) : undefined
      return { kind: 'success', text: statusText({ pluginVersion: version, enabled, python, worker: client?.status(), chat }) }
    },
  })
}
