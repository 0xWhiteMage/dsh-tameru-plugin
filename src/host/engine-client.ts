import {
  OLDEST_PROTOCOL,
  PROTOCOL_VERSION,
  fromWirePlan,
  fromWireResult,
  fromWireVersion,
  planToWire,
  toWire,
  type CompressRequest,
  type CompressResult,
  type PlanReply,
  type PlanRequest,
  type WorkerStatus,
  type WorkerVersion,
} from '../shared/protocol.ts'
import { TOO_LARGE_LINE_ERROR } from './process.ts'

/** A running worker, however it was started: lines in, lines out. */
export interface WorkerProcess {
  /** Write one line (the newline is added by the caller). */
  send(line: string): void
  onLine(listener: (line: string) => void): void
  /** Called once when the process is gone, for any reason. */
  onExit(listener: () => void): void
  kill(): void
}

export type Spawn = () => Promise<WorkerProcess> | WorkerProcess

export interface EngineClientOptions {
  /** How long one request may take before it counts as a failure. */
  timeoutMs?: number
  /** This many failures within `windowMs` turns the worker off until `reset()`. */
  maxFailures?: number
  windowMs?: number
  /** Extra time the first request to a newly started worker gets (interpreter start and engine import). */
  startupMs?: number
  /** How long the engine rests after it was turned off by repeated failures before it is tried again. */
  cooldownMs?: number
  /** Host steps while disabled after which the worker is retried, whichever of this or `cooldownMs` comes first. */
  recoverySteps?: number
  now?: () => number
}

interface Pending {
  resolve: (reply: Record<string, unknown> | undefined) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Talks to one long-lived worker. It fails open: every method resolves, and a request that cannot be answered resolves to
 * `undefined`, which the caller reads as "leave the original as it is". No promise here ever rejects.
 */
export class EngineClient {
  private readonly timeoutMs: number
  private readonly maxFailures: number
  private readonly windowMs: number
  private readonly now: () => number
  private worker: WorkerProcess | undefined
  private starting: Promise<WorkerProcess | undefined> | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private failures: number[] = []
  private disabled = false
  private disposed = false
  private lastError: string | undefined
  private version: WorkerVersion | undefined
  private probeAttempts = 0
  private tail: Promise<unknown> = Promise.resolve()
  private disabledAt = 0
  private readonly startupMs: number
  private readonly cooldownMs: number
  private readonly recoverySteps: number
  private disabledSteps = 0

  private readonly spawn: Spawn

  constructor(spawn: Spawn, options: EngineClientOptions = {}) {
    this.spawn = spawn
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.maxFailures = options.maxFailures ?? 3
    this.windowMs = options.windowMs ?? 60_000
    this.now = options.now ?? Date.now
    this.startupMs = options.startupMs ?? 15_000
    this.cooldownMs = options.cooldownMs ?? 60_000
    this.recoverySteps = options.recoverySteps ?? 20
  }

  status(): WorkerStatus {
    return {
      state: this.disabled || this.disposed ? 'disabled' : this.worker ? 'running' : 'idle',
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.version ? { version: this.version } : {}),
    }
  }

  /** One host step went by: counts toward the end of a rest while the engine is disabled. */
  noteStep(): void {
    if (this.disabled) this.disabledSteps++
  }

  /** Start answering requests again after the worker was turned off by repeated failures. */
  reset(): void {
    this.disabled = false
    this.disabledSteps = 0
    this.failures = []
    this.lastError = undefined
  }

  /**
   * True when the worker speaks protocol 2 (engine 1.10.0 and later). Asks the worker once, and answers false when it cannot say:
   * the version 1 fields work with any worker.
   */
  async speaksV2(): Promise<boolean> {
    return this.speaksProtocol(2)
  }

  /** True when the worker speaks protocol 3 (selector queries and `plan` requests). */
  async speaksV3(): Promise<boolean> {
    return this.speaksProtocol(3)
  }

  private async speaksProtocol(version: number): Promise<boolean> {
    if (this.version === undefined && this.probeAttempts < 3) {
      this.probeAttempts++
      await this.probe()
    }
    return (this.version?.protocol ?? OLDEST_PROTOCOL) >= version
  }

  /**
   * Version 2 fields (preset, anchorErrors, redactSecrets, queryParts, policy) go out only when the worker reported protocol 2; to
   * a worker that reported 1 they are left out and the request is a version 1 request. The caller reads `result.decision` to
   * know whether the engine decided.
   */
  async compress(request: CompressRequest, maxMs?: number): Promise<CompressResult | undefined> {
    const wantsV2 = request.preset !== undefined || request.anchorErrors !== undefined || request.redactSecrets !== undefined || request.queryParts !== undefined || request.policy !== undefined || request.deriveSelectorQuery !== undefined
    const protocol = request.deriveSelectorQuery !== undefined && (await this.speaksV3()) ? PROTOCOL_VERSION
      : wantsV2 && (await this.speaksV2()) ? 2 : OLDEST_PROTOCOL
    // a big text takes longer to read: the deadline grows with it, so a healthy worker is not killed for a large result —
    // but a caller may cap the whole call (`maxMs`, the pass's remaining budget); at or under zero nothing is sent at all
    if (maxMs !== undefined && maxMs <= 0) return undefined
    const extraMs = maxMs === undefined ? Math.ceil(request.text.length / 50) : Math.max(0, Math.min(Math.ceil(request.text.length / 50), maxMs - this.timeoutMs))
    const reply = await this.call(id => toWire(id, request, protocol), extraMs, maxMs)
    const result = reply?.ok === true ? (reply.result as Record<string, unknown> | undefined) : undefined
    if (reply && reply.ok !== true) this.note(typeof reply.error === 'string' ? reply.error : 'error_reply', false)
    return result ? fromWireResult(result) : undefined
  }

  /**
   * A `plan` request (protocol 3): the pure planner over the items the host describes. `undefined` when the worker
   * cannot answer — the caller treats that like every other engine miss (leave everything as it is).
   */
  async plan(request: PlanRequest): Promise<PlanReply | undefined> {
    if (!(await this.speaksV3())) {
      this.note('no_protocol_3', false)
      return undefined
    }
    const reply = await this.call(id => planToWire(id, request))
    const result = reply?.ok === true ? (reply.result as Record<string, unknown> | undefined) : undefined
    if (reply && reply.ok !== true) this.note(typeof reply.error === 'string' ? reply.error : 'error_reply', false)
    return result ? fromWirePlan(result) : undefined
  }

  async probe(): Promise<WorkerVersion | undefined> {
    const reply = await this.call(id => ({ id, op: 'version' }))
    const result = reply?.ok === true ? (reply.result as Record<string, unknown> | undefined) : undefined
    const version = result ? fromWireVersion(result) : undefined
    if (version) {
      if (version.protocol < OLDEST_PROTOCOL || version.protocol > PROTOCOL_VERSION) {
        this.note('protocol_mismatch', true)
        return undefined
      }
      this.version = version
    }
    return version
  }

  /** Ask the worker to end, then make sure it is gone. Safe to call twice. */
  async dispose(): Promise<void> {
    this.disposed = true
    const worker = this.worker
    this.worker = undefined
    this.starting = undefined
    this.settleAll()
    if (worker) {
      try {
        worker.send(JSON.stringify({ id: 0, op: 'shutdown' }))
      } catch {
        // the process may already be gone
      }
      try {
        worker.kill()
      } catch {
        // already gone
      }
    }
  }

  /**
   * Requests go to the worker one at a time: it answers one at a time anyway, and this way each request's deadline covers only its own
   * work, so one slow request cannot fail the ones queued behind it.
   */
  private call(build: (id: number) => Record<string, unknown>, extraMs = 0, capMs?: number): Promise<Record<string, unknown> | undefined> {
    const run = this.tail.then(() => this.callNow(build, extraMs, capMs))
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  private async callNow(build: (id: number) => Record<string, unknown>, extraMs = 0, capMs?: number): Promise<Record<string, unknown> | undefined> {
    if (this.disposed) return undefined
    // after repeated failures the engine rests, then is tried again: a bad minute must not switch it off until the
    // Harness restarts. The rest ends after `recoverySteps` host steps or `cooldownMs`, whichever comes first — a
    // disable lasting the whole session after transient contention is too harsh. Steps come from the host's
    // `noteStep()`, not engine calls: one step can make many calls, and counting calls could end the rest inside
    // the step that caused it.
    if (this.disabled) {
      if (this.disabledSteps < this.recoverySteps && this.now() - this.disabledAt < this.cooldownMs) return undefined
      this.reset()
      // a single trial: one more failure rests the engine again at once
      this.failures = Array.from({ length: Math.max(0, this.maxFailures - 1) }, () => this.now())
    }
    const fresh = this.worker === undefined
    const worker = await this.ensureWorker()
    if (!worker) return undefined
    const id = this.nextId++
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.note('timeout', true)
        this.drop(worker)
        resolve(undefined)
      }, Math.min(this.timeoutMs, capMs ?? this.timeoutMs) + extraMs + (fresh ? this.startupMs : 0))
      this.pending.set(id, { resolve, timer })
      try {
        worker.send(JSON.stringify(build(id)))
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        this.note('write_failed', true)
        this.drop(worker)
        resolve(undefined)
      }
    })
  }

  private ensureWorker(): Promise<WorkerProcess | undefined> {
    if (this.worker) return Promise.resolve(this.worker)
    this.starting ??= (async () => {
      try {
        const worker = await this.spawn()
        if (this.disposed) {
          worker.kill()
          return undefined
        }
        worker.onLine(line => {
          if (this.worker === worker) this.onLine(line)
        })
        worker.onExit(() => this.onExit(worker))
        this.worker = worker
        return worker
      } catch {
        this.note('spawn_failed', true)
        return undefined
      } finally {
        this.starting = undefined
      }
    })()
    return this.starting
  }

  private onLine(line: string): void {
    let reply: unknown
    try {
      reply = JSON.parse(line)
    } catch {
      this.note('bad_reply', true)
      return
    }
    if (typeof reply !== 'object' || reply === null) return
    const record = reply as Record<string, unknown>
    // the host's own line splitter reports a reply it would not hold: the worker is misbehaving, so it counts and is replaced
    if (record.id === null && record.error === TOO_LARGE_LINE_ERROR) {
      this.note(TOO_LARGE_LINE_ERROR, true)
      if (this.worker) this.drop(this.worker)
      return
    }
    // The worker answers a line it could not read (bad JSON, too large) with no id. Requests are serial, so that reply belongs to the
    // one request in flight: it fails alone and at once, instead of waiting out its deadline and taking the worker with it.
    const id = typeof record.id === 'number' ? record.id : record.id === null && record.ok === false && this.pending.size === 1 ? [...this.pending.keys()][0] : undefined
    const pending = id === undefined ? undefined : this.pending.get(id)
    if (!pending || id === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(record)
  }

  private onExit(worker: WorkerProcess): void {
    if (this.worker !== worker) return
    this.worker = undefined
    if (!this.disposed) this.note('worker_exited', true)
    this.settleAll()
  }

  private drop(worker: WorkerProcess): void {
    if (this.worker === worker) this.worker = undefined
    try {
      worker.kill()
    } catch {
      // already gone
    }
    this.settleAll()
  }

  private settleAll(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.resolve(undefined)
    }
    this.pending.clear()
  }

  private note(code: string, countsAsFailure: boolean): void {
    this.lastError = code
    if (!countsAsFailure) return
    const at = this.now()
    this.failures = [...this.failures.filter(time => at - time < this.windowMs), at]
    if (this.failures.length >= this.maxFailures && !this.disabled) {
      this.disabled = true
      this.disabledAt = at
    }
  }
}
