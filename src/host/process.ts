import { spawn as nodeSpawn } from 'node:child_process'
import type { Spawn, WorkerProcess } from './engine-client.ts'

/** The longest reply line the host holds: well above the worker's largest answer (its 16 MiB request limit, ASCII-escaped). */
export const MAX_REPLY_CHARS = 128 * 1024 * 1024

/** What the splitter hands on in place of a line that was too long: the worker's own error shape, so the request in flight fails at once. */
export const TOO_LARGE_LINE = JSON.stringify({ id: null, ok: false, error: 'reply_too_large' })

/**
 * Turns a byte stream into lines. A line is complete at `\n`; a trailing `\r` is dropped. A line longer than `maxChars` is never held
 * in memory: it is discarded up to its newline and reported once as `TOO_LARGE_LINE`.
 */
export class LineSplitter {
  private readonly decoder = new TextDecoder('utf-8')
  private rest = ''
  private discarding = false
  private readonly maxChars: number

  constructor(maxChars: number = MAX_REPLY_CHARS) {
    this.maxChars = maxChars
  }

  push(chunk: Uint8Array | string, onLine: (line: string) => void): void {
    let text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
    if (this.discarding) {
      const end = text.indexOf('\n')
      if (end < 0) return
      this.discarding = false
      text = text.slice(end + 1)
    }
    this.rest += text
    let at = this.rest.indexOf('\n')
    while (at >= 0) {
      const line = at > this.maxChars ? TOO_LARGE_LINE : this.rest.slice(0, at).replace(/\r$/, '')
      this.rest = this.rest.slice(at + 1)
      if (line) onLine(line)
      at = this.rest.indexOf('\n')
    }
    if (this.rest.length > this.maxChars) {
      this.rest = ''
      this.discarding = true
      onLine(TOO_LARGE_LINE)
    }
  }
}

/** The arguments every worker start uses: isolated (no environment, no user site, no script directory on the path), no bytecode. */
export const WORKER_FLAGS = ['-I', '-B', '-P'] as const

/**
 * Start the worker with Node's own child_process. Used by the tests and anywhere the Harness's managed subprocess service is
 * not available. Inside the Harness use `harnessSpawn`, which lets the Harness own and reap the process.
 */
export function nodeWorkerSpawn(python: string, script: string, cwd: string): Spawn {
  return () => {
    const child = nodeSpawn(python, [...WORKER_FLAGS, script], { cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    const splitter = new LineSplitter()
    let lineListener: (line: string) => void = () => {}
    let exitListener: () => void = () => {}
    let exited = false
    const finish = (): void => {
      if (exited) return
      exited = true
      exitListener()
    }
    child.stdout.on('data', (chunk: Buffer) => splitter.push(chunk, line => lineListener(line)))
    child.stdin.on('error', () => {})              // a write after the process died must not crash the host
    child.on('exit', finish)
    child.on('error', finish)
    const worker: WorkerProcess = {
      send: line => {
        child.stdin.write(`${line}\n`, 'utf8')
      },
      onLine: listener => {
        lineListener = listener
      },
      onExit: listener => {
        exitListener = listener
        if (exited) listener()
      },
      kill: () => {
        child.kill()
      },
    }
    return worker
  }
}

/** What this plugin needs of the Harness's `ctx.subprocess` service. The real service has more; only these parts are used. */
export interface HarnessSubprocess {
  spawn(request: {
    argv: string[]
    cwd: string
    stdio: { stdin: 'pipe'; stdout: 'pipe'; stderr: 'ignore' }
    graceMs: number
    signal?: AbortSignal
  }): HarnessProcessHandle
}

export interface HarnessProcessHandle {
  stdin: { write(chunk: string): unknown; end?(): unknown; on?(event: 'error', listener: () => void): unknown }
  stdout: NodeJS.ReadableStream | ReadableStream<Uint8Array>
  done: Promise<unknown>
  terminate(): unknown
}

/** Start the worker through the Harness's managed subprocess service: the Harness scrubs the environment and reaps the process. */
export function harnessWorkerSpawn(subprocess: HarnessSubprocess, python: string, script: string, cwd: string, signal?: AbortSignal): Spawn {
  return () => {
    const handle = subprocess.spawn({
      argv: [python, ...WORKER_FLAGS, script],
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' },
      graceMs: 2000,
      ...(signal ? { signal } : {}),
    })
    const splitter = new LineSplitter()
    let lineListener: (line: string) => void = () => {}
    let exitListener: () => void = () => {}
    let exited = false
    const finish = (): void => {
      if (exited) return
      exited = true
      exitListener()
    }
    // A write after the process ended comes back as an 'error' event on the pipe; unhandled, it would take the whole Harness down.
    handle.stdin.on?.('error', () => {})
    const feed = (chunk: Uint8Array | string): void => splitter.push(chunk, line => lineListener(line))
    const stream = handle.stdout as { on?: (event: string, cb: (chunk: Buffer) => void) => unknown; getReader?: () => ReadableStreamDefaultReader<Uint8Array> }
    if (typeof stream.on === 'function') {
      stream.on('data', feed)
    } else if (typeof stream.getReader === 'function') {
      const reader = stream.getReader()
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            if (value) feed(value)
          }
        } catch {
          // the process ended
        }
      })()
    }
    handle.done.then(finish, finish)
    return {
      send: line => {
        handle.stdin.write(`${line}\n`)
      },
      onLine: listener => {
        lineListener = listener
      },
      onExit: listener => {
        exitListener = listener
        if (exited) listener()
      },
      kill: () => {
        try {
          void Promise.resolve(handle.terminate()).catch(() => {})
        } catch {
          // already gone
        }
      },
    }
  }
}
