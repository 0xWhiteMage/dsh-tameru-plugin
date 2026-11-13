// A real Harness session and token meter, built from the packages extracted by scripts/extract_harness.py into dev/harness.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { MeterLike, SessionLike } from '../../src/host/shorten.ts'

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const modules = join(root, 'dev', 'harness', 'node_modules')
export const harnessAvailable = existsSync(join(modules, '@deepseek-ai', 'cordis', 'lib', 'index.js'))
export const skip = harnessAvailable ? false : 'run `python scripts/extract_harness.py` to extract the Harness packages'

export const load = (pkg: string): Promise<any> => import(pathToFileURL(join(modules, pkg, 'lib', 'index.js')).href)

export interface World {
  ctx: any
  session: SessionLike & { deriveMessages(): any[] }
  meter: MeterLike & { measure(session: any, header?: any): any }
  step(call: { name: string; args: unknown }, output: string, options?: { isError?: boolean }): { callId: string; resultSeq: number }
  finish(text?: string): void
  pendingCall(call: { name: string; args: unknown }, output: string): number
  /** Record the routed request (provider, model, output cap) the way the agent loop does before a step. */
  header(maxTokens?: number): void
}

let counter = 0

/** A live session with a system prompt and a user message, plus helpers that add the events a real agent loop writes. */
export async function world(task = 'Find why the build fails and fix it.'): Promise<World> {
  const { Context } = await load('@deepseek-ai/cordis')
  const sessions = await load('@deepseek-ai/dsh-session')
  const ctx = new Context()
  ctx.plugin(sessions.default)
  ctx.plugin((await load('@deepseek-ai/dsh-session-projection')).default)
  ctx.plugin((await load('@deepseek-ai/dsh-token-meter')).default)
  ctx.plugin((await load('@deepseek-ai/dsh-compaction-tool-result-pruner')).default)   // the Harness's own pruner, for comparisons
  ctx.plugin((await load('@deepseek-ai/dsh-system-prompt')).default)                    // the real prompt assembler and tool registry
  ctx.plugin((await load('@deepseek-ai/dsh-tools')).default)
  await new Promise(resolve => setTimeout(resolve, 50))
  const session = ctx.sessions.create(`s${++counter}`, { meta: { cwd: root } })
  const model = { provider: 'p', model: 'm' }
  let turn = 0
  let stepNo = 0
  session.append('system/message', { message: { id: `sys${counter}`, role: 'system', content: [{ type: 'text', text: 'You are an agent.' }], source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' })
  session.append('user/message', { id: `user${counter}`, role: 'user', content: [{ type: 'text', text: task }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('turn/start', { turn })
  let n = 0
  // one agent-loop step: step/start, the assistant message, whatever the callback adds (tool results), step/end
  const inStep = (content: unknown[], then?: () => number): number => {
    const step = ++stepNo
    session.append('step/start', { turn, step })
    session.append('assistant/message', { turn, step, stream: [], message: { id: `a${counter}-${++n}`, role: 'assistant', content, source: { kind: 'model', ...model } } }, { surfaceOp: 'append' })
    const seq = then ? then() : -1
    session.append('step/end', { turn, step })
    return seq
  }
  const result = (callId: string, name: string, output: string, isError = false): number =>
    session.append('tool/result', { message: { id: `r${counter}-${++n}`, role: 'tool', toolCallId: callId, content: [{ type: 'text', text: output }], ...(isError ? { isError: true } : {}), source: { kind: 'tool', callId, name } } }, { surfaceOp: 'append' }).seq
  return {
    ctx,
    session,
    meter: ctx.tokenMeter,
    step(call, output, options = {}) {
      const callId = `call-${counter}-${++n}`
      const resultSeq = inStep([{ type: 'text', text: `Running ${call.name}.` }, { type: 'tool-call', id: callId, name: call.name, arguments: JSON.stringify(call.args) }], () => result(callId, call.name, output, options.isError === true))
      return { callId, resultSeq }
    },
    pendingCall(call, output) {
      const callId = `call-${counter}-${++n}`
      return inStep([{ type: 'tool-call', id: callId, name: call.name, arguments: JSON.stringify(call.args) }], () => result(callId, call.name, output))
    },
    header(maxTokens = 8000) {
      session.append('request/header', { header: { config: { ...model, maxTokens } } })
    },
    finish(text = 'Done for now.') {
      inStep([{ type: 'text', text }])
      session.append('turn/end', { turn })
      turn++
    },
  }
}

/** A tool output of about `chars` characters: routine lines with one distinctive error line in the middle. */
export function bigOutput(label: string, chars = 20_000): string {
  const lines: string[] = []
  let size = 0
  let i = 0
  const middle = Math.floor(chars / 2)
  let placed = false
  while (size < chars) {
    const line = !placed && size >= middle ? `ERROR ${label}: assertion failed at module_${label}.ts:${100 + i} expected 3 but was 4` : `INFO ${label} step ${i} completed with nothing to report`
    if (line.startsWith('ERROR')) placed = true
    lines.push(line)
    size += line.length + 1
    i++
  }
  return lines.join('\n')
}

/** Record a compaction the way the Harness's backend does: start, summary naming what it replaced, the replacing checkpoint, end. */
export function recordCompaction(w: World, first: number, last: number, id = `c${Math.random()}`): number {
  const nodes = [...w.session.surface.nodes]
  const range = nodes.slice(first, last + 1)
  const start = w.session.append('compaction/start', { compactionId: id, turn: null, source: 'manual' })
  const summary = w.session.append('compaction/summary', {
    compactionId: id, summary: 'earlier work', shadowedRange: { start: range[0], end: range.at(-1) }, shadowedSeqs: range, shadowedTokenCount: 100, provider: 'p', model: 'm',
  })
  w.session.append('user/message', { id: `chk${id}`, role: 'user', content: [{ type: 'text', text: '<compacted-summary>earlier work</compacted-summary>' }], source: { kind: 'user' } }, {
    surfaceOp: { op: 'replace', startSeq: range[0]!, endSeq: range.at(-1)! }, sourceEventSeqs: [start.seq, summary.seq, ...range],
  })
  return w.session.append('compaction/end', { compactionId: id, turn: null, source: 'manual' }).seq
}
