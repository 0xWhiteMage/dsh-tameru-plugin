import {
  PROTOCOL_VERSION,
  fromWireResult,
  fromWireVersion,
  toWire,
  type CompressRequest,
  type CompressResult,
  type WorkerStatus,
  type WorkerVersion,
} from '../shared/protocol.ts'

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

  private readonly spawn: Spawn

  constructor(spawn: Spawn, options: EngineClientOptions = {}) {
    this.spawn = spawn
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.maxFailures = options.maxFailures ?? 3
    this.windowMs = options.windowMs ?? 60_000
    this.now = options.now ?? Date.now
  }

  status(): WorkerStatus {
    return {
      state: this.disabled || this.disposed ? 'disabled' : this.worker ? 'running' : 'idle',
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.version ? { version: this.version } : {}),
    }
  }

  /** Start answering requests again after the worker was turned off by repeated failures. */
  reset(): void {
    this.disabled = false
    this.failures = []
    this.lastError = undefined
  }

  async compress(request: CompressRequest): Promise<CompressResult | undefined> {
    const reply = await this.call(id => toWire(id, request))
    const result = reply?.ok === true ? (reply.result as Record<string, unknown> | undefined) : undefined
    if (reply && reply.ok !== true) this.note(typeof reply.error === 'string' ? reply.error : 'error_reply', false)
    return result ? fromWireResult(result) : undefined
  }

  async probe(): Promise<WorkerVersion | undefined> {
    const reply = await this.call(id => ({ id, op: 'version' }))
    const result = reply?.ok === true ? (reply.result as Record<string, unknown> | undefined) : undefined
    const version = result ? fromWireVersion(result) : undefined
    if (version) {
      if (version.protocol !== PROTOCOL_VERSION) {
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

  private async call(build: (id: number) => Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    if (this.disposed || this.disabled) return undefined
    const worker = await this.ensureWorker()
    if (!worker) return undefined
    const id = this.nextId++
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.note('timeout', true)
        this.drop(worker)
        resolve(undefined)
      }, this.timeoutMs)
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
        worker.onLine(line => this.onLine(line))
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
    const pending = typeof record.id === 'number' ? this.pending.get(record.id) : undefined
    if (!pending) return
    this.pending.delete(record.id as number)
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
    if (this.failures.length >= this.maxFailures) this.disabled = true
  }
}
