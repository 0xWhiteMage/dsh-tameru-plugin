import type { WorkerStatus } from '../shared/protocol.ts'
import type { PythonChoice } from './python.ts'

export interface StatusInput {
  pluginVersion: string
  enabled: boolean
  python: PythonChoice | undefined
  worker: WorkerStatus | undefined
}

/** The text `/tameru` shows. Plain, short, and honest about what is and is not working. */
export function statusText(input: StatusInput): string {
  const lines = [`Tameru ${input.pluginVersion} for DeepSeek Harness`]
  if (!input.enabled) {
    lines.push('Off: Tameru does nothing and the Harness behaves as stock.')
    return lines.join('\n')
  }
  if (!input.python) {
    lines.push('Not working yet: no Python was found for the engine, so the Harness is behaving as stock.')
    lines.push("Set `pythonPath` in Tameru's settings, or let the Harness create its bundled Python runtime.")
    return lines.join('\n')
  }
  const worker = input.worker
  const version = worker?.version
  if (version) {
    lines.push(`Engine ${version.engineVersion} (matches source commit ${version.vendoredFrom?.slice(0, 7) ?? 'unknown'}), Python ${version.python}.`)
  } else {
    lines.push(`Engine not started yet (Python: ${input.python.path}).`)
  }
  if (worker?.state === 'disabled') {
    lines.push(`The engine stopped after repeated failures (${worker.lastError ?? 'unknown'}); the Harness is behaving as stock.`)
  } else if (worker?.lastError) {
    lines.push(`Last problem: ${worker.lastError}. When the engine fails, the original text is left as it is.`)
  }
  return lines.join('\n')
}
