import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngineClient } from './engine-client.ts'
import { harnessWorkerSpawn, type HarnessSubprocess } from './process.ts'
import type { SessionLike } from './shorten.ts'
import { dshHome, findPython } from './python.ts'
import { filePins, pinsSection } from './pins.ts'
import { scanForTrail, trailMessage } from './trail.ts'
import { handleApi, type ApiEnv } from './api.ts'
import { readSaved, writeSaved } from './saved-settings.ts'
import { normalizeSettings, resolveEffective, type TameruConfig } from './settings.ts'
import { statusText } from './status.ts'
import { chatStatsOf, onPreStep, pressureOf, type ChatStats, type StepAgent, type StepDeps, type TameruSettings } from './step.ts'
import { drainPending, runCommand } from './commands.ts'
import { compactionIsManagedElsewhere } from './stock.ts'
import { readOriginalTool } from './tool.ts'

/**
 * Tameru for DeepSeek Harness: host half.
 *
 * Nothing stock is replaced, disabled or wrapped. This plugin adds a command and one `agent/pre-step` listener (registered after the
 * Harness's and DS Bot's, never `prepend`), and with `enabled: false` the host half does nothing.
 */
export const name = 'dsh-tameru'
export const inject = ['commands', 'subprocess', 'tools', 'systemPrompt', 'connection']

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
  tools?: { register(definition: unknown): unknown }
  connection?: { fetch: { register(route: { path: string; methods: string[]; requestBody: string; fetch: (request: Request) => Promise<Response> }): unknown } }
  systemPrompt?: { section(definition: { name: string; order: number; interpolate: boolean; text: (context: { agent?: { session?: { id?: string } } }) => string }): unknown }
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
  const stateDir = join(dshHome(), 'tameru')
  // what the profile says, then what the user changed in the Tameru panel; one live object the panel edits in place
  const profile: TameruSettings = normalizeSettings(config)
  const saved: TameruSettings = readSaved(stateDir)
  const settings: TameruSettings = { ...profile, ...saved }
  const python = findPython(config.pythonPath ? { configured: config.pythonPath } : {})
  const stats = new WeakMap<object, ChatStats>()
  const log = ctx.logger?.('tameru')
  const pins = filePins(stateDir)
  let client: EngineClient | undefined
  let deps: StepDeps | undefined
  const baseDeps = {
    meter: () => ctx.get?.('tokenMeter'),
    resolveModelInfo: async (provider: string, model: string, signal?: AbortSignal) => ctx.get?.('llm')?.resolveModelInfo(provider, model, signal),
    backendFor: (agent: StepAgent) => {
      try {
        return ctx.get?.('agentPresets')?.serviceFor?.(agent, 'compaction') ?? ctx.get?.('compaction')
      } catch {
        return ctx.get?.('compaction')
      }
    },
    settings,
    stats,
    ...(log ? { log } : {}),
  }
  if (python) {
    const stop = new AbortController()
    // A request waits on the engine inside a step boundary, so it gets a short deadline: a slow engine must never slow the chat.
    client = new EngineClient(harnessWorkerSpawn(ctx.subprocess, python.path, join(dir, 'vendor', 'run_worker.py'), dir, stop.signal), { timeoutMs: 4000 })
    const worker = client
    ctx.effect(() => () => {
      stop.abort()
      void worker.dispose()
    }, 'dsh-tameru: engine worker')
    deps = { ...baseDeps, client: worker }
  }
  // Never `prepend`: the Harness's backend and DS Bot run first. Whatever happens here, the step goes on.
  ctx.on?.('agent/pre-step', async ({ agent, signal }, next) => {
    if (deps) await onPreStep(deps, agent, signal)
    else if (agent?.session) {
      // no engine: nothing is shortened, but what the user queued (keep, restore, unkeep) is still applied
      try {
        const meter = baseDeps.meter()
        const chat = chatStatsOf(stats, agent.session)
        if (meter) for (const failure of drainPending(agent.session, meter, chat)) { chat.lastFailure = failure.reason; chat.lastFailureAt = Date.now() }
      } catch (error) {
        log?.warn(`dsh-tameru: could not apply a queued change: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const decision = (await next()) as { kind?: string; messages?: unknown[] } | undefined
    // After a compaction, add the Artifact Trail once, as a note on this step. Not in a chat whose compaction another plugin manages,
    // and never to a step that carries no message of its own: an empty decision means "nothing to run" to the agent loop.
    try {
      const managed = agent?.session ? compactionIsManagedElsewhere(baseDeps.backendFor(agent)) : true
      const owed = agent?.session && !managed ? scanForTrail(agent.session, chatStatsOf(stats, agent.session).trail) : undefined
      if (owed && decision?.kind === 'enter' && Array.isArray(decision.messages) && decision.messages.length > 0) return { ...decision, messages: [...decision.messages, trailMessage(owed)] }
    } catch (error) {
      log?.warn(`dsh-tameru: could not build the Artifact Trail: ${error instanceof Error ? error.message : String(error)}`)
    }
    return decision
  })
  // The user's pinned lines, word for word, as a section of the system prompt: no compaction replaces the system prompt.
  ctx.systemPrompt?.section({
    name: 'tameru:pins',
    order: 10_100,
    interpolate: false,
    text: (context: { agent?: { session?: { id?: string } } }) => pinsSection(pins.list(context.agent?.session?.id ?? '')),
  })
  // The Tameru panel's route. The Harness authenticates the browser; the panel only reaches chats that are open.
  const api: ApiEnv = {
    version,
    sessionFor: id => ctx.get?.('sessions')?.get?.(id),
    meter: () => ctx.get?.('tokenMeter'),
    stats,
    pins,
    settings,
    profile,
    saved,
    saveSettings: next => writeSaved(stateDir, next),
    engine: () => client?.status(),
    pythonPath: () => python?.path,
    pressure: session => pressureOf({ ...baseDeps, client: undefined as never }, { session } as unknown as StepAgent),
  }
  ctx.effect(
    () =>
      ctx.connection?.fetch.register({
        path: '/api/tameru',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async request => {
          let body: { endpoint?: unknown; payload?: unknown } = {}
          try {
            body = await request.json()
          } catch {
            return new Response(JSON.stringify({ ok: false, error: 'bad request' }), { status: 400, headers: { 'content-type': 'application/json' } })
          }
          const result = await handleApi(typeof body.endpoint === 'string' ? body.endpoint : '', body.payload, api)
          return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
        },
      }) ?? (() => {}),
    'dsh-tameru: panel route',
  )
  if (python) log?.info(`dsh-tameru ${version} loaded (engine Python: ${python.path}, from ${python.source})`)
  else log?.warn(`dsh-tameru ${version} loaded but no Python was found: shortening is off (pins and the Artifact Trail still work). Set pythonPath in Tameru's settings.`)
  ctx.commands.register({
    name: 'tameru',
    description: 'Show what Tameru is doing in this chat; pin lines, keep, restore or read a shortened result (try /tameru help)',
    input: { hint: '[help|changes|view|keep|restore|unkeep|pin|pins|unpin] ...' },
    handler: async ({ rawInput, agent }) => {
      if (client && !client.status().version) await client.probe()
      const session = agent?.session as SessionLike | undefined
      const chat = session ? stats.get(session) : undefined
      const status = (): string => statusText({ pluginVersion: version, enabled, python, worker: client?.status(), chat, pins: session?.id ? pins.list(session.id).length : 0, effective: resolveEffective(settings, client?.status()?.version?.engineVersion ?? null) })
      if (!session) return { kind: 'success', text: status() }
      return runCommand(rawInput, { session, meter: ctx.get?.('tokenMeter'), stats: chatStatsOf(stats, session), pins, status })
    },
  })
  // The model's way back to a shortened result's original. A plain definition: nothing is imported from the Harness at run time.
  if (python) ctx.tools?.register(readOriginalTool())
}
