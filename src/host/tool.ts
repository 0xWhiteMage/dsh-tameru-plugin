import { DEFAULT_READ_CHARS, MAX_READ_CHARS, readOriginal } from './originals.ts'
import { READ_TOOL } from './messages.ts'
import type { SessionLike } from './shorten.ts'

/** What a tool body receives from the Harness. Only these parts are used. */
export interface ToolExec {
  agent?: { session: SessionLike }
  signal?: AbortSignal
}

/**
 * The model-facing tool that reads a shortened result's original back. It is a plain tool definition (what the Harness's
 * `defineTool` builds), so this plugin imports nothing from the Harness at run time. It reads only the calling agent's own session
 * and only results Tameru shortened.
 */
export function readOriginalTool(): {
  name: string
  description: string
  parameters: unknown
  output: { schema: unknown; render: (args: unknown, value: string) => Array<{ type: 'text'; text: string }> }
  execute(args: { reference: number; offset?: number; limit?: number }, exec: ToolExec): Promise<string>
} {
  return {
    name: READ_TOOL,
    description:
      'Read the original text of a tool result that Tameru shortened. Use it when a shortened result (its first line starts with "[Tameru: shortened") may hold a detail you need. ' +
      `Pass the reference from that line. Long originals come back in windows of up to ${MAX_READ_CHARS} characters; continue with offset.`,
    parameters: {
      type: 'object',
      properties: {
        reference: { type: 'integer', description: 'The reference number in the shortened result\'s first line.' },
        offset: { type: 'integer', description: 'Character offset to start from (default 0).' },
        limit: { type: 'integer', description: `Most characters to return (default ${DEFAULT_READ_CHARS}, at most ${MAX_READ_CHARS}).` },
      },
      required: ['reference'],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (!session) throw new Error(`${READ_TOOL} needs an agent session`)
      const read = readOriginal(session, args.reference, args.offset ?? 0, args.limit ?? DEFAULT_READ_CHARS)
      if (!read.ok) throw new Error(read.reason)
      const more = read.end < read.total ? ` Continue with offset ${read.end}.` : ' That is the end.'
      return `${read.text}\n\n[characters ${read.offset}-${read.end} of ${read.total}.${more}]`
    },
  }
}
