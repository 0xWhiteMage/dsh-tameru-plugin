/** The bar's words, in English and Chinese. The language is the page's own. Few words on screen; the detail lives in hover cards.
 *  Nothing here claims a saving: the plugin has not measured one. */
import type { Status } from './model.ts'

const en = {
  name: 'Tameru',
  kana: '(ためる)',
  nameTip: (version: string) => `Shortens bulky tool output before it fills the context. Originals stay in the chat log. v${version}. Type /tameru help for commands.`,
  show: 'Show details',
  hide: 'Hide details',
  card: 'Tameru details',
  close: 'Close',
  tabs: { results: 'Shortened results', pins: 'Pinned lines' },
  tabsLabel: 'Tameru sections',
  gaugeTitle: (percent: number, starts?: number, compacts?: number) =>
    `${percent}% of the context is in use.${starts !== undefined ? ` Tameru starts at ${Math.round(starts * 100)}%.` : ''}${compacts !== undefined ? ` The Harness compacts at ${Math.round(compacts * 100)}%.` : ''}`,
  mode: 'Mode',
  modes: {
    more: { name: 'Shorten more', tip: 'Shortens more results. In a simulated replay a looser gate (0.5; this is 0.55) cost about 3% more and kept about 0.7 more of 5 needed facts.' },
    balanced: { name: 'Balanced', tip: 'The default. In a simulated replay (40 sessions, assumed prices) it matched the stock pruner, because it rarely acted.' },
    less: { name: 'Keep detail', tip: 'Shortens fewer results. Not measured separately.' },
    custom: { name: 'Custom', tip: 'Set in your profile file.' },
  },
  pause: 'Pause',
  resume: 'Resume',
  pauseTip: 'Stop shortening until you resume. Pins and /tameru keep working.',
  resumeTip: 'Start shortening again.',
  pinsTip: (count: number) => (count > 0 ? `Pinned lines: ${count}` : 'Pin a line'),
  status: (s: Status): string => {
    switch (s.key) {
      case 'loading': return '…'
      case 'unreachable': return 'Offline'
      case 'notOpen': return 'No chat'
      case 'paused': return 'Paused'
      case 'noPython': return 'No Python'
      case 'enginePaused': return 'Engine resting'
      case 'failure': return s.text
      case 'waiting': return `${s.count} waiting`
      case 'shortened': return s.fresh > 0 ? `${s.fresh} new` : `${s.count} shortened`
      case 'kept': return `${s.count} in full`
      case 'startsAt': return `Starts at ${s.percent}%`
      case 'watching': return 'Watching'
    }
  },
  unreachable: 'Cannot reach the Harness.',
  loading: '…',
  gaugeReason: (reason: string | null): string =>
    ({
      no_request_yet: 'Waiting for the first request.',
      no_context_window: 'This model declares no context window, so Tameru has no point to start from.',
      unusable_context_window: 'This model’s context window is too small.',
      managed_elsewhere: 'Another plugin manages this chat; Tameru stays out.',
      no_token_meter: 'The Harness has no token meter.',
    })[reason ?? ''] ?? 'Context size not available yet.',
  skipReason: (reason: string): string =>
    ({
      below_activation: 'Below the starting point.',
      no_candidates: 'Nothing old and large yet.',
      not_confident: 'The engine was not sure enough.',
      not_worth_it: 'Would not pay for itself.',
      engine_unavailable: 'The engine did not answer.',
      off: 'Paused.',
    })[reason] ?? '',
  empty: 'Nothing shortened yet.',
  emptyStarts: (percent: number) => `Nothing yet. Starts at ${percent}%.`,
  working: 'Applies at the next step.',
  inFull: 'full',
  fresh: 'New',
  rowGone: 'Summarised away',
  rowCut: 'Also trimmed by the Harness',
  rowWaiting: 'Waiting for the next step',
  rowRestored: 'Full for now',
  showFull: (tool: string, ref: number) => `Show ${tool} #${ref} in full`,
  shortenAgain: (tool: string, ref: number) => `Shorten ${tool} #${ref} again`,
  open: (tool: string, ref: number) => `Open ${tool} #${ref}`,
  tool: 'tool',
  back: 'Back',
  original: 'Original',
  shortened: 'Shortened',
  view: 'View',
  previous: 'Previous',
  next: 'Next',
  chars: (from: string, to: string, total: string) => `${from}–${to} of ${total}`,
  restore: 'Show in full for 3 replies',
  pinsEmpty: 'Nothing pinned.',
  pinsFull: 'Limit reached',
  pinPlaceholder: 'Pin a line…',
  pinAdd: 'Add pin',
  removePin: (position: number) => `Remove pin ${position}`,
  pinsHelp: (limit: number) => `Kept word for word, even after a summary. Up to ${limit} characters. No passwords.`,
}

export type Copy = typeof en

const zh: Copy = {
  name: 'Tameru',
  kana: '(ためる)',
  nameTip: version => `在大段工具输出占满上下文之前将其缩短。原文保留在对话日志中。v${version}。输入 /tameru help 查看命令。`,
  show: '展开',
  hide: '收起',
  card: 'Tameru 详情',
  close: '关闭',
  tabs: { results: '已缩短', pins: '已固定' },
  tabsLabel: 'Tameru 分区',
  gaugeTitle: (percent, starts, compacts) =>
    `已用上下文 ${percent}%。${starts !== undefined ? `Tameru 在 ${Math.round(starts * 100)}% 开始。` : ''}${compacts !== undefined ? `Harness 在 ${Math.round(compacts * 100)}% 压缩。` : ''}`,
  mode: '模式',
  modes: {
    more: { name: '多缩短', tip: '缩短更多结果。模拟回放中，更宽松的门槛（0.5；此处为 0.55）成本约高 3%，在 5 条所需事实中多保留约 0.7 条。' },
    balanced: { name: '均衡', tip: '默认。模拟回放（40 个会话，价格为假设）中与原生裁剪成本相同，因为它很少动作。' },
    less: { name: '保留细节', tip: '缩短更少的结果。未单独测量。' },
    custom: { name: '自定义', tip: '在你的配置文件中设置。' },
  },
  pause: '暂停',
  resume: '继续',
  pauseTip: '暂停缩短，直到你继续。固定内容和 /tameru 仍然有效。',
  resumeTip: '重新开始缩短。',
  pinsTip: count => (count > 0 ? `已固定：${count} 条` : '固定一句话'),
  status: s => {
    switch (s.key) {
      case 'loading': return '…'
      case 'unreachable': return '离线'
      case 'notOpen': return '无对话'
      case 'paused': return '已暂停'
      case 'noPython': return '无 Python'
      case 'enginePaused': return '引擎休息中'
      case 'failure': return s.text
      case 'waiting': return `${s.count} 项等待`
      case 'shortened': return s.fresh > 0 ? `新增 ${s.fresh}` : `已缩短 ${s.count}`
      case 'kept': return `${s.count} 项完整`
      case 'startsAt': return `${s.percent}% 时开始`
      case 'watching': return '监视中'
    }
  },
  unreachable: '无法连接 Harness。',
  loading: '…',
  gaugeReason: reason =>
    ({
      no_request_yet: '正在等待第一次请求。',
      no_context_window: '此模型未声明上下文窗口，Tameru 没有起点。',
      unusable_context_window: '此模型的上下文窗口太小。',
      managed_elsewhere: '另一个插件管理此对话，Tameru 不介入。',
      no_token_meter: 'Harness 没有 token 计量器。',
    })[reason ?? ''] ?? '暂时无法获得上下文大小。',
  skipReason: reason =>
    ({
      below_activation: '尚未达到起点。',
      no_candidates: '暂无旧的大结果。',
      not_confident: '引擎把握不足。',
      not_worth_it: '不划算。',
      engine_unavailable: '引擎没有响应。',
      off: '已暂停。',
    })[reason] ?? '',
  empty: '尚未缩短任何内容。',
  emptyStarts: percent => `暂无。${percent}% 时开始。`,
  working: '将在下一步生效。',
  inFull: '完整',
  fresh: '新',
  rowGone: '已被摘要取代',
  rowCut: 'Harness 也已裁剪',
  rowWaiting: '等待下一步',
  rowRestored: '暂时完整',
  showFull: (tool, ref) => `完整显示 ${tool} #${ref}`,
  shortenAgain: (tool, ref) => `重新缩短 ${tool} #${ref}`,
  open: (tool, ref) => `打开 ${tool} #${ref}`,
  tool: '工具',
  back: '返回',
  original: '原文',
  shortened: '缩短后',
  view: '查看',
  previous: '上一页',
  next: '下一页',
  chars: (from, to, total) => `${from}–${to} / ${total}`,
  restore: '在接下来 3 次回复中完整显示',
  pinsEmpty: '还没有固定内容。',
  pinsFull: '已达上限',
  pinPlaceholder: '固定一句话…',
  pinAdd: '添加',
  removePin: position => `移除第 ${position} 条`,
  pinsHelp: limit => `原样保留，摘要后也不丢失。每条最多 ${limit} 字符。请勿放入密码。`,
}

export function copy(): Copy {
  const language = (typeof document !== 'undefined' ? document.documentElement.lang : '') || (typeof navigator !== 'undefined' ? navigator.language : '')
  return language.toLowerCase().startsWith('zh') ? zh : en
}
