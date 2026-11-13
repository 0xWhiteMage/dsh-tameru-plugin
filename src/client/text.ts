/** The panel's words, in English and Chinese. The language is the page's own. */
export interface Copy {
  guideDescription: string
  loading: string
  unreachable: string
  notOpen: string
  context: string
  cleanups: string
  gaugeLabel: string
  starts: string
  compacts: string
  tool: string
  kept: string
  restored: string
  summarisedAway: string
  hide: string
  view: string
  keep: string
  restore: string
  unkeep: string
  keepHelp: string
  restoreHelp: string
  unkeepHelp: string
  viewing: string
  original: string
  modelSees: string
  previous: string
  next: string
  working: string
  empty: string
  pinsTitle: string
  pinsEmpty: string
  pinsFull: string
  pinPlaceholder: string
  pin: string
  settings: string
  shortening: string
  shorteningHelp: string
  startAt: string
  startAtHelp: string
  confidence: string
  confidenceHelp: string
  reset: string
  gaugeCaption(tokens: string, trigger: string): string
  freed(tokens: string, count: number): string
  sizes(before: string, after: string): string
  fullSize(chars: string): string
  chars(from: string, to: string, total: string): string
  pending(count: number): string
  emptyWithStart(tokens: string): string
  removePin(position: number): string
  pinsHelp(limit: number): string
  engine(state: 'on' | 'off' | 'stopped' | 'none', version?: string): string
  gaugeReason(reason: string | null): string
  skipReason(reason: string): string
  footer(version: string): string
}

const en: Copy = {
  guideDescription: 'What Tameru shortened in this chat',
  loading: 'Loading…',
  unreachable: 'Could not reach the Harness. Check that it is still running.',
  notOpen: 'This chat is not open yet.',
  context: 'Context',
  cleanups: 'Shortened results',
  gaugeLabel: 'Context used against the point where the Harness compacts',
  starts: 'Tameru starts',
  compacts: 'Harness compacts',
  tool: 'tool',
  kept: 'kept in full',
  restored: 'restored',
  summarisedAway: 'Summarised away by a compaction: no longer in the model’s view.',
  hide: 'Hide',
  view: 'View',
  keep: 'Keep',
  restore: 'Restore',
  unkeep: 'Shorten again',
  keepHelp: 'Show the model the full original until you shorten it again',
  restoreHelp: 'Show the model the full original for its next few replies',
  unkeepHelp: 'Go back to the shortened version',
  viewing: 'What to show',
  original: 'Original',
  modelSees: 'What the model sees',
  previous: 'Previous',
  next: 'Next',
  working: 'The agent is working: changes you make here apply before its next step.',
  empty: 'Nothing shortened in this chat yet.',
  pinsTitle: 'Pinned lines',
  pinsEmpty: 'Nothing pinned. A pinned line is in front of the model on every request and survives every compaction.',
  pinsFull: 'The limit is reached: remove one first',
  pinPlaceholder: 'Pin a line, for example: never touch the production config',
  pin: 'Pin',
  settings: 'Settings',
  shortening: 'Shorten large results',
  shorteningHelp: 'Off: Tameru leaves every result as it is. Pins and the Artifact Trail keep working.',
  startAt: 'Start shortening at',
  startAtHelp: 'Share of the context at which the Harness compacts. Lower starts earlier.',
  confidence: 'Confidence needed',
  confidenceHelp: 'Lower shortens more, but risks losing a fact. In our simulated sessions a lower setting cost about 3% more and kept about 0.7 more of 5 needed facts.',
  reset: 'Reset to defaults',
  gaugeCaption: (tokens, trigger) => `${tokens} tokens now · the Harness compacts at ${trigger}`,
  freed: (tokens, count) => `Tameru has freed about ${tokens} tokens by shortening ${count} result${count === 1 ? '' : 's'}.`,
  sizes: (before, after) => `${before} → ${after} chars`,
  fullSize: chars => `${chars} chars, in full`,
  chars: (from, to, total) => `characters ${from}–${to} of ${total}`,
  pending: count => `${count} change${count === 1 ? '' : 's'} waiting for the agent’s next step.`,
  emptyWithStart: tokens => `Nothing shortened yet. Tameru starts once this chat passes ${tokens} tokens.`,
  removePin: position => `Remove pin ${position}`,
  pinsHelp: limit => `Up to ${limit} characters each, kept word for word. Never put a password or key here.`,
  engine: (state, version) => (state === 'on' ? `Engine${version ? ` ${version}` : ''}` : state === 'stopped' ? 'Engine stopped' : state === 'none' ? 'No Python' : 'Engine idle'),
  gaugeReason: reason =>
    ({
      no_request_yet: 'Waiting for the first model request.',
      no_context_window: 'This model declares no context window, so the Harness never compacts on size and Tameru has no point to start from.',
      unusable_context_window: 'This model’s context window is too small for the Harness’s own compaction settings.',
      managed_elsewhere: 'Another plugin manages this chat’s context; Tameru stays out of it.',
      no_token_meter: 'The Harness has no token meter.',
    })[reason ?? ''] ?? 'The context size is not available yet.',
  skipReason: reason =>
    ({
      below_activation: 'The context is still below the point where Tameru starts.',
      no_candidates: 'No old large result is eligible yet.',
      not_confident: 'The engine was not confident enough in an extract to risk losing a fact.',
      not_worth_it: 'Shortening would not have paid for rewriting the prompt cache.',
      engine_unavailable: 'The engine did not answer.',
      off: 'Shortening is switched off.',
    })[reason] ?? '',
  footer: version => `Tameru ${version} · originals stay in the chat log · /tameru help`,
}

const zh: Copy = {
  ...en,
  guideDescription: '本次对话中 Tameru 缩短了什么',
  loading: '加载中…',
  unreachable: '无法连接 Harness，请确认它仍在运行。',
  notOpen: '此对话尚未打开。',
  context: '上下文',
  cleanups: '已缩短的结果',
  starts: 'Tameru 开始',
  compacts: 'Harness 压缩',
  kept: '完整保留',
  restored: '已恢复',
  view: '查看',
  hide: '收起',
  keep: '保留',
  restore: '恢复',
  unkeep: '重新缩短',
  original: '原文',
  modelSees: '模型所见',
  previous: '上一页',
  next: '下一页',
  empty: '此对话中尚未缩短任何内容。',
  pinsTitle: '固定的话',
  pin: '固定',
  pinPlaceholder: '固定一句话，例如：不要修改生产环境配置',
  settings: '设置',
  shortening: '缩短较大的结果',
  startAt: '开始缩短的位置',
  confidence: '所需置信度',
  reset: '恢复默认',
  gaugeCaption: (tokens, trigger) => `当前 ${tokens} 个 token · Harness 在 ${trigger} 时压缩`,
  freed: (tokens, count) => `Tameru 缩短了 ${count} 条结果，释放约 ${tokens} 个 token。`,
  sizes: (before, after) => `${before} → ${after} 字符`,
  fullSize: chars => `${chars} 字符（完整）`,
  engine: (state, version) => (state === 'on' ? `引擎${version ? ` ${version}` : ''}` : state === 'stopped' ? '引擎已停止' : state === 'none' ? '无 Python' : '引擎空闲'),
  footer: version => `Tameru ${version} · 原文保留在对话日志中 · /tameru help`,
}

export function copy(): Copy {
  const language = (typeof document !== 'undefined' ? document.documentElement.lang : '') || (typeof navigator !== 'undefined' ? navigator.language : '')
  return language.toLowerCase().startsWith('zh') ? zh : en
}
