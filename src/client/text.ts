/** The bar's words, in English and Chinese; the language is the page's own. Almost all of them come from the shared vocabulary every Tameru
 *  plugin uses (src/shared/ui-vocabulary.json, a copy of the engine repository's docs/ui-vocabulary.json); only the few that belong to this
 *  plugin alone are written here. Few words on screen, the detail in hover cards, and nothing that claims or implies a saving. */
import vocabulary from '../shared/ui-vocabulary.json' with { type: 'json' }
import { fill, type Status, type StrengthId } from './model.ts'

export type Language = 'en' | 'zh'
type Pair = { en: string; zh: string }

/** The plugin's own few strings. They are checked against the same forbidden words as the shared ones. */
const LOCAL: Record<Language, {
  nameTip(version: string): string
  gaugeTitle(percent: number, starts?: number, compacts?: number): string
  card: string
  tabs: string
  loading: string
  customName: string
  customLine: string
  trimmed: string
  waitingTip: string
  restoredTip: string
  unreachable: string
  gaugeReason(reason: string | null): string
}> = {
  en: {
    nameTip: version => `Shortens bulky tool output before it fills the context. Originals stay in the chat log. v${version}. Type /tameru help for commands.`,
    gaugeTitle: (percent, starts, compacts) =>
      `${percent}% of the context is in use.${starts !== undefined ? ` Tameru starts at ${Math.round(starts * 100)}%.` : ''}${compacts !== undefined ? ` The Harness compacts at ${Math.round(compacts * 100)}%.` : ''}`,
    card: 'Tameru details',
    tabs: 'Tameru sections',
    loading: '…',
    customName: 'Custom',
    customLine: 'Set in your profile\'s Tameru settings.',
    trimmed: 'The Harness has also trimmed this one.',
    waitingTip: 'Waiting for the next step.',
    restoredTip: 'In full for a few replies.',
    unreachable: 'Cannot reach the Harness.',
    gaugeReason: reason =>
      ({
        no_request_yet: 'Waiting for the first request.',
        no_context_window: 'The AI declares no context window, so Tameru has no point to start from.',
        unusable_context_window: 'The context window is too small.',
        managed_elsewhere: 'Another plugin manages this chat; Tameru stays out.',
        no_token_meter: 'The Harness has no token meter.',
      })[reason ?? ''] ?? 'Context size not available yet.',
  },
  zh: {
    nameTip: version => `在大段工具输出占满上下文之前将其缩短。原文保留在对话日志中。v${version}。输入 /tameru help 查看命令。`,
    gaugeTitle: (percent, starts, compacts) =>
      `已用上下文 ${percent}%。${starts !== undefined ? `Tameru 在 ${Math.round(starts * 100)}% 开始。` : ''}${compacts !== undefined ? `Harness 在 ${Math.round(compacts * 100)}% 压缩。` : ''}`,
    card: 'Tameru 详情',
    tabs: 'Tameru 分区',
    loading: '…',
    customName: '自定义',
    customLine: '在你配置文件的 Tameru 设置中设置。',
    trimmed: 'Harness 也已裁剪这一条。',
    waitingTip: '等待下一步。',
    restoredTip: '在接下来几次回复中完整显示。',
    unreachable: '无法连接 Harness。',
    gaugeReason: reason =>
      ({
        no_request_yet: '正在等待第一次请求。',
        no_context_window: 'AI 未声明上下文窗口，Tameru 没有起点。',
        unusable_context_window: '上下文窗口太小。',
        managed_elsewhere: '另一个插件管理此对话，Tameru 不介入。',
        no_token_meter: 'Harness 没有 token 计量器。',
      })[reason ?? ''] ?? '暂时无法获得上下文大小。',
  },
}

export function build(language: Language) {
  const v = vocabulary
  const say = (pair: Pair): string => pair[language]
  const local = LOCAL[language]
  const strengthLine = (id: 'off' | 'less' | 'normal' | 'more') => ({ name: say(v.strength[id].name), line: say(v.strength[id].line) })
  return {
    language,
    name: say(v.brand.name),
    kana: say(v.brand.kana),
    nameTip: local.nameTip,
    gaugeTitle: local.gaugeTitle,
    gaugeReason: local.gaugeReason,
    card: local.card,
    tabsLabel: local.tabs,
    loading: local.loading,
    unreachable: local.unreachable,
    trimmed: local.trimmed,
    waitingTip: local.waitingTip,
    restoredTip: local.restoredTip,
    strengthLabel: say(v.strength.label),
    strengths: {
      off: strengthLine('off'),
      less: strengthLine('less'),
      normal: strengthLine('normal'),
      more: strengthLine('more'),
      custom: { name: local.customName, line: local.customLine },
    } as Record<StrengthId | 'custom', { name: string; line: string }>,
    scopeAll: say(v.strength.scopeAll),
    /** The one status phrase. Never raw error text. */
    status(s: Status): string {
      switch (s.key) {
        case 'loading': return ''
        case 'notConnected': return say(v.status.notConnected)
        case 'notRunning': return say(v.status.notRunning)
        case 'notRunningRetrying': return say(v.status.notRunningRetrying)
        case 'problem': return say(v.status.problem)
        case 'waiting': return say(v.status.waitingStep)
        case 'off': return say(v.status.off)
        case 'shortened': return s.n === 1 ? say(v.status.shortenedOne) : fill(say(v.status.shortened), { n: s.n ?? 0 })
        case 'keptOnly': return fill(say(v.status.keptOnly), { n: s.n ?? 0 })
        case 'idleUntil': return fill(say(v.status.idleUntil), { percent: s.percent ?? 0 })
        case 'idle': return say(v.status.idle)
      }
    },
    /** `55% full` split around the figure, so the figure can be set heavier than the word. */
    full(percent: number): { before: string; figure: string; after: string } {
      const [before = '', after = ''] = say(v.status.full).split('{percent}%')
      return { before: before.trim(), figure: `${percent}%`, after: after.trim() }
    },
    keep: say(v.actions.keep),
    kept: say(v.actions.kept),
    keepConfirm: say(v.actions.keepConfirm),
    releaseTip: say(v.actions.releaseTip),
    releaseConfirm: say(v.actions.releaseConfirm),
    nextStep: say(v.actions.nextStep),
    close: say(v.actions.close),
    back: say(v.actions.back),
    undo: say(v.actions.undo),
    removed: say(v.actions.removed),
    loadMore: say(v.actions.loadMore),
    tabShortened: say(v.views.tabShortened),
    tabPins: say(v.views.tabPins),
    aiSees: say(v.views.aiSees),
    original: say(v.views.original),
    characters: say(v.views.characters),
    keptDivider: (n: number) => fill(say(v.views.keptDivider), { n }),
    pinPlaceholder: say(v.pins.placeholder),
    pinsEmpty: say(v.pins.empty),
    pinsWarning: say(v.pins.warning),
    pinsLimit: (used: number, max: number) => fill(say(v.pins.limit), { used, max }),
    problems: {
      notConnected: say(v.problems.notConnected),
      notRunning: say(v.problems.notRunning),
      notRunningRetrying: say(v.problems.notRunningRetrying),
      problem: say(v.problems.problem),
      details: say(v.problems.details),
    },
    empty: {
      belowStart: say(v.emptyReasons.belowStart),
      noCandidates: say(v.emptyReasons.noCandidates),
      notConfident: say(v.emptyReasons.notConfident),
      tooSmall: say(v.emptyReasons.tooSmall),
      engineSilent: say(v.emptyReasons.engineSilent),
      cancelled: say(v.emptyReasons.cancelled),
      off: say(v.emptyReasons.off),
    },
  }
}

export type Copy = ReturnType<typeof build>

export function copy(): Copy {
  const language = (typeof document !== 'undefined' ? document.documentElement.lang : '') || (typeof navigator !== 'undefined' ? navigator.language : '')
  return build(language.toLowerCase().startsWith('zh') ? 'zh' : 'en')
}
