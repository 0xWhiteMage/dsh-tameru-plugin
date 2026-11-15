/** The bar's words, in English and Chinese. The language is the page's own. Nothing here claims a saving: the plugin has not measured one. */
import type { Status } from './model.ts'

const en = {
  name: 'Tameru',
  open: 'Show Tameru details',
  close: 'Hide Tameru details',
  gauge: 'Context in use',
  gaugeTitle: (percent: number, starts?: number, compacts?: number) =>
    `${percent}% of the context window is in use.${starts !== undefined ? ` Tameru starts at ${Math.round(starts * 100)}%.` : ''}${compacts !== undefined ? ` The Harness compacts at ${Math.round(compacts * 100)}%.` : ''}`,
  tabs: { results: 'Results', pins: 'Pins', settings: 'Settings' },
  tabsLabel: 'Tameru sections',
  pinsButton: (count: number) => `Pins: ${count}`,
  status: (s: Status): string => {
    switch (s.key) {
      case 'loading': return 'Loading…'
      case 'unreachable': return 'Cannot reach the Harness'
      case 'notOpen': return 'Chat not open yet'
      case 'shorteningOff': return 'Shortening is off'
      case 'noPython': return 'No Python found: nothing is shortened'
      case 'enginePaused': return 'Engine paused after errors'
      case 'failure': return s.text
      case 'waiting': return `${s.count} change${s.count === 1 ? '' : 's'} waiting for the next step`
      case 'shortened': return s.fresh > 0 ? `${s.fresh} new · ${s.count} shortened` : `${s.count} shortened`
      case 'startsAt': return `Starts at ${s.percent}%`
      case 'watching': return 'Watching'
    }
  },
  unreachable: 'Could not reach the Harness. Check that it is still running.',
  loading: 'Loading…',
  gaugeReason: (reason: string | null): string =>
    ({
      no_request_yet: 'Waiting for the first model request.',
      no_context_window: 'This model declares no context window, so the Harness never compacts on size and Tameru has no point to start from.',
      unusable_context_window: 'This model’s context window is too small for the Harness’s own compaction settings.',
      managed_elsewhere: 'Another plugin manages this chat’s context; Tameru stays out of it.',
      no_token_meter: 'The Harness has no token meter.',
    })[reason ?? ''] ?? 'The context size is not available yet.',
  skipReason: (reason: string): string =>
    ({
      below_activation: 'The context is still below the point where Tameru starts.',
      no_candidates: 'No old large result is eligible yet.',
      not_confident: 'The engine was not sure enough about an extract to risk losing a fact.',
      not_worth_it: 'Shortening would not have paid for rewriting the prompt cache.',
      engine_unavailable: 'The engine did not answer.',
      off: 'Shortening is switched off.',
    })[reason] ?? '',
  empty: 'Nothing shortened in this chat yet.',
  emptyStarts: (percent: number) => `Nothing shortened yet. Tameru starts once the context passes ${percent}%.`,
  working: 'The agent is working: a change you make applies before its next step.',
  summarisedAway: 'Summarised away by a compaction: no longer in the model’s view.',
  inFull: 'in full',
  cutByHarness: 'The Harness has also trimmed this one',
  fresh: 'New',
  waitingRow: 'waiting',
  keep: 'Keep',
  keepLabel: (tool: string, ref: number) => `Keep ${tool} #${ref} in full`,
  keepHelp: 'Show the model the full original until you turn this off',
  fullForNow: 'full for now',
  details: 'Details',
  detailsLabel: (tool: string, ref: number) => `Details of ${tool} #${ref}`,
  tool: 'tool',
  viewing: 'What to show',
  original: 'Original',
  modelSees: 'What the model sees',
  previous: 'Previous',
  next: 'Next',
  chars: (from: string, to: string, total: string) => `characters ${from}–${to} of ${total}`,
  restore: 'Show the model in full for its next 3 replies',
  loadingText: 'Loading…',
  pinsTitle: 'Pinned lines',
  pinsEmpty: 'Nothing pinned. A pinned line is in front of the model on every request and survives every compaction.',
  pinsFull: 'The limit is reached: remove one first',
  pinPlaceholder: 'Pin a line, for example: never touch the production config',
  pin: 'Pin',
  removePin: (position: number) => `Remove pin ${position}`,
  pinsHelp: (limit: number) => `Up to ${limit} characters each, kept word for word. Never put a password or key here.`,
  shortening: 'Shorten large results',
  shorteningHelp: 'Off: every result stays as it is. Pins and the Artifact Trail keep working.',
  carefulness: 'How sure the engine must be',
  presets: {
    cautious: { name: 'Cautious', line: 'Shortens fewer results. Not measured separately.' },
    balanced: { name: 'Balanced', line: 'The default. Measured on 160 replayed sessions: no change in cost.' },
    eager: { name: 'Eager', line: 'Shortens more results. In the same replay a looser setting cost about 3% more and kept about 0.7 more of 5 needed facts.' },
    custom: { name: 'Custom', line: 'Set in your profile file.' },
  },
  reset: 'Back to defaults',
  footer: (version: string) => `Tameru ${version} · originals stay in the chat log · /tameru help`,
}

export type Copy = typeof en

const zh: Copy = {
  name: 'Tameru',
  open: '展开 Tameru 详情',
  close: '收起 Tameru 详情',
  gauge: '上下文用量',
  gaugeTitle: (percent, starts, compacts) =>
    `已使用上下文窗口的 ${percent}%。${starts !== undefined ? `Tameru 在 ${Math.round(starts * 100)}% 开始。` : ''}${compacts !== undefined ? `Harness 在 ${Math.round(compacts * 100)}% 压缩。` : ''}`,
  tabs: { results: '结果', pins: '固定', settings: '设置' },
  tabsLabel: 'Tameru 分区',
  pinsButton: count => `固定：${count}`,
  status: s => {
    switch (s.key) {
      case 'loading': return '加载中…'
      case 'unreachable': return '无法连接 Harness'
      case 'notOpen': return '对话尚未打开'
      case 'shorteningOff': return '缩短已关闭'
      case 'noPython': return '未找到 Python：不会缩短任何内容'
      case 'enginePaused': return '引擎因错误暂停'
      case 'failure': return s.text
      case 'waiting': return `${s.count} 项更改等待下一步`
      case 'shortened': return s.fresh > 0 ? `新增 ${s.fresh} · 已缩短 ${s.count}` : `已缩短 ${s.count}`
      case 'startsAt': return `${s.percent}% 时开始`
      case 'watching': return '监视中'
    }
  },
  unreachable: '无法连接 Harness，请确认它仍在运行。',
  loading: '加载中…',
  gaugeReason: reason =>
    ({
      no_request_yet: '正在等待第一次模型请求。',
      no_context_window: '此模型未声明上下文窗口，Harness 不会按大小压缩，Tameru 也没有起点。',
      unusable_context_window: '此模型的上下文窗口对 Harness 自身的压缩设置而言太小。',
      managed_elsewhere: '另一个插件管理此对话的上下文，Tameru 不介入。',
      no_token_meter: 'Harness 没有 token 计量器。',
    })[reason ?? ''] ?? '暂时无法获得上下文大小。',
  skipReason: reason =>
    ({
      below_activation: '上下文尚未达到 Tameru 的起点。',
      no_candidates: '暂时没有符合条件的旧的大结果。',
      not_confident: '引擎对摘要把握不足，不愿冒丢失事实的风险。',
      not_worth_it: '缩短不足以抵偿重写提示缓存的代价。',
      engine_unavailable: '引擎没有响应。',
      off: '缩短已关闭。',
    })[reason] ?? '',
  empty: '此对话中尚未缩短任何内容。',
  emptyStarts: percent => `尚未缩短任何内容。上下文超过 ${percent}% 后 Tameru 才会开始。`,
  working: '智能体正在工作：你的更改会在它的下一步之前生效。',
  summarisedAway: '已被压缩摘要取代：不再在模型的视野中。',
  inFull: '完整',
  cutByHarness: 'Harness 也已裁剪过这一条',
  fresh: '新',
  waitingRow: '等待中',
  keep: '保留',
  keepLabel: (tool, ref) => `完整保留 ${tool} #${ref}`,
  keepHelp: '在你关闭之前，让模型看到完整原文',
  fullForNow: '暂时完整',
  details: '详情',
  detailsLabel: (tool, ref) => `${tool} #${ref} 的详情`,
  tool: '工具',
  viewing: '显示内容',
  original: '原文',
  modelSees: '模型所见',
  previous: '上一页',
  next: '下一页',
  chars: (from, to, total) => `第 ${from}–${to} 字符，共 ${total}`,
  restore: '在模型接下来的 3 次回复中显示完整内容',
  loadingText: '加载中…',
  pinsTitle: '固定的话',
  pinsEmpty: '还没有固定内容。固定的话会出现在每次请求中，且不会被任何压缩移除。',
  pinsFull: '已达上限：请先移除一条',
  pinPlaceholder: '固定一句话，例如：不要修改生产环境配置',
  pin: '固定',
  removePin: position => `移除第 ${position} 条`,
  pinsHelp: limit => `每条最多 ${limit} 个字符，原样保留。请勿在此放入密码或密钥。`,
  shortening: '缩短较大的结果',
  shorteningHelp: '关闭后所有结果保持原样。固定内容和 Artifact Trail 仍然有效。',
  carefulness: '引擎需要多大把握',
  presets: {
    cautious: { name: '谨慎', line: '缩短的结果更少。未单独测量。' },
    balanced: { name: '均衡', line: '默认。在 160 个回放会话中测得：成本没有变化。' },
    eager: { name: '积极', line: '缩短更多结果。同一回放中，更宽松的设置成本约高 3%，在 5 条所需事实中多保留约 0.7 条。' },
    custom: { name: '自定义', line: '在你的配置文件中设置。' },
  },
  reset: '恢复默认',
  footer: version => `Tameru ${version} · 原文保留在对话日志中 · /tameru help`,
}

export function copy(): Copy {
  const language = (typeof document !== 'undefined' ? document.documentElement.lang : '') || (typeof navigator !== 'undefined' ? navigator.language : '')
  return language.toLowerCase().startsWith('zh') ? zh : en
}
