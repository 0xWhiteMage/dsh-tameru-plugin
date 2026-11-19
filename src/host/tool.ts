import { DEFAULT_READ_CHARS, MAX_READ_CHARS, readOriginal } from './originals.ts'
import { DEFAULT_GREP_MATCHES, MAX_GREP_MATCHES, grepOriginal } from './grep.ts'
import { READ_TOOL } from './messages.ts'
import type { SessionLike } from './shorten.ts'

/** What a tool body receives from the Harness. Only these parts are used. */
export interface ToolExec {
  agent?: { session: SessionLike }
  signal?: AbortSignal
}

export interface ReadArgs {
  reference: number
  offset?: number
  limit?: number
  grep?: string
  literal?: boolean
  ignore_case?: boolean
  max_matches?: number
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
  execute(args: ReadArgs, exec: ToolExec): Promise<string>
} {
  return {
    name: READ_TOOL,
    description:
      'Read the original text of a tool result that Tameru shortened. Use it when a shortened result (its first line starts with "[Tameru: shortened") may hold a detail you need: ' +
      'the first line says what was dropped ("dropped: 412 log lines, 38 trace lines (Foo.java:88…)"), so when that list could include what you are looking for, read the original again instead of guessing. ' +
      'Pass the number after "ref=" in that line as reference. ' +
      `To find something in a long original, pass grep: the lines that match come back with their line numbers (up to ${DEFAULT_GREP_MATCHES}, at most ${MAX_GREP_MATCHES}). ` +
      `Without grep, long originals come back in windows of up to ${MAX_READ_CHARS} characters; continue with offset.`,
    parameters: {
      type: 'object',
      properties: {
        reference: { type: 'integer', description: 'The number after "ref=" in the shortened result\'s first line.' },
        grep: { type: 'string', description: 'Return only the lines of the original that match this pattern, with line numbers (a regular expression, or plain text with literal: true; at most 120 characters).' },
        literal: { type: 'boolean', description: 'Match grep as plain text instead of a regular expression (default false).' },
        ignore_case: { type: 'boolean', description: 'Ignore upper and lower case in grep (default false).' },
        max_matches: { type: 'integer', description: `Most matching lines to return (default ${DEFAULT_GREP_MATCHES}, at most ${MAX_GREP_MATCHES}).` },
        offset: { type: 'integer', description: 'Character offset to start from (default 0). Not used with grep.' },
        limit: { type: 'integer', description: `Most characters to return (default ${DEFAULT_READ_CHARS}, at most ${MAX_READ_CHARS}). Not used with grep.` },
      },
      required: ['reference'],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (!session) throw new Error(`${READ_TOOL} needs an agent session`)
      if (args.grep !== undefined) {
        const found = grepOriginal(session, args.reference, args.grep, {
          ...(args.literal === undefined ? {} : { literal: args.literal }),
          ...(args.ignore_case === undefined ? {} : { ignoreCase: args.ignore_case }),
          ...(args.max_matches === undefined ? {} : { max: args.max_matches }),
        })
        if (!found.ok) throw new Error(found.reason)
        return found.text
      }
      const read = readOriginal(session, args.reference, args.offset ?? 0, args.limit ?? DEFAULT_READ_CHARS)
      if (!read.ok) throw new Error(read.reason)
      const more = read.end < read.total ? ` Continue with offset ${read.end}.` : ' That is the end.'
      return `${read.text}\n\n[characters ${read.offset}-${read.end} of ${read.total}.${more}]`
    },
  }
}
