// The browser half, built and loaded the way the Harness's module loader loads it, against a recording stand-in for the web client's
// context. It cannot render the panel (no React here); it proves what broke or could break the whole sidebar: the wrapper format, the
// declared dependencies, what is registered, that titles and descriptions are functions (a string crashes the Harness's guide), and that
// everything is unregistered when the plugin goes.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from '../src/client/text.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'ignore' })
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

const reactStub = { createElement: () => ({}), Fragment: Symbol('Fragment'), Component: class {}, useState: (v: unknown) => [v, () => {}], useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v: unknown) => ({ current: v }), useCallback: (f: unknown) => f }
const requireStub = (name: string): unknown => (name === 'react' ? reactStub : {})

function load(): { definition: { id: string; factory: (require: (name: string) => unknown) => Record<string, any> }; required: string[] } {
  const required: string[] = []
  let definition: any
  ;(globalThis as any).window = { __ModuleLoader__: { load: (d: unknown) => (definition = d) } }
  new Function('window', source)((globalThis as any).window)
  const originalFactory = definition.factory
  definition.factory = (_require: unknown) => originalFactory((name: string) => (required.push(name), name === 'react' ? reactStub : {}))
  return { definition, required }
}

test('the bundle is in the Harness loader format and asks only for modules the web shell shares', () => {
  assert.match(source, /^\/\/ Generated from src\/client/)
  assert.match(source, /window\.__ModuleLoader__\.load\(\{\s*id: "dsh-tameru"/)
  const { definition, required } = load()
  const exports = definition.factory(requireStub)
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
  for (const name of new Set(required)) assert.ok(['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'].includes(name), `unexpected module request: ${name}`)
  assert.ok(!/@deepseek-ai\/dsh-(?!client-ui-primitives)/.test(source.replace(/\/\/.*$/gm, '').match(/require\("[^"]+"\)/g)?.join('\n') ?? ''), 'no other Harness package is required')
})

test('applying it registers one dock bar in the input dock, and removes it and its style when unloaded', () => {
  const { definition } = load()
  const exports = definition.factory(requireStub)
  const styles: any[] = []
  ;(globalThis as any).document = {
    createElement: () => ({ setAttribute() {}, remove() { styles.length = 0 }, textContent: '' }),
    head: { appendChild: (element: unknown) => styles.push(element) },
    documentElement: { lang: 'en' },
  }
  const registered: any[] = []
  const injected: string[] = []
  const disposers: Array<() => void> = []
  exports.apply({
    effect: (setup: () => unknown) => {
      const dispose = setup()
      disposers.push(() => {
        if (typeof dispose === 'function') dispose()
      })
    },
    slots: {
      inject: (slot: string, factory: () => () => void) => {
        injected.push(slot)
        const remove = factory()
        return () => remove()
      },
      register: (definition: unknown, body: unknown) => {
        registered.push({ definition, body })
        return () => registered.splice(0)
      },
    },
  })
  assert.deepEqual(injected, ['conversation.input.dock'])
  assert.equal(registered.length, 1)
  const { definition: dock, body } = registered[0]
  assert.equal(dock.name, 'conversation.input.dock')
  assert.equal(dock.id, 'dsh-tameru')
  assert.ok(typeof dock.order === 'number' && dock.order > 20, 'it sits after the Harness goal (10) and queue (20) docks')
  assert.deepEqual(dock.inject('chat-1'), { sessionId: 'chat-1' }, 'the bar is told which chat it is in')
  assert.equal(typeof body, 'function')
  assert.equal(styles.length, 1, 'one style element was added')
  for (const dispose of disposers.reverse()) dispose()
  assert.equal(registered.length, 0)
  assert.equal(styles.length, 0, 'the style element was removed')
})

test('every string the bar can show is in both languages, from the shared vocabulary, and none claims or implies a saving', () => {
  const vocabulary = JSON.parse(readFileSync(join(root, 'src', 'shared', 'ui-vocabulary.json'), 'utf8'))
  const english = build('en')
  const chinese = build('zh')
  const shape = (value: unknown): unknown =>
    typeof value === 'function' ? 'function' : typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shape(inner)])) : typeof value
  assert.deepEqual(shape(chinese), shape(english), 'the same keys and kinds in both languages')
  assert.equal(english.name, 'Tameru')
  assert.equal(english.kana, '(ためる)')
  assert.equal(chinese.kana, '(ためる)')
  // every phrase the bar can show, in both languages, non-empty (loading is deliberately empty)
  const statuses: any[] = [
    { key: 'notConnected', tone: 'problem' }, { key: 'notRunning', tone: 'problem' }, { key: 'notRunningRetrying', tone: 'problem' }, { key: 'problem', tone: 'problem' },
    { key: 'waiting', tone: 'working', n: 2 }, { key: 'off', tone: 'off' }, { key: 'shortened', tone: 'idle', n: 1 }, { key: 'shortened', tone: 'idle', n: 3 },
    { key: 'keptOnly', tone: 'idle', n: 2 }, { key: 'idleUntil', tone: 'idle', percent: 59 }, { key: 'idle', tone: 'idle' },
  ]
  const shown: string[] = []
  for (const language of [english, chinese]) for (const status of statuses) shown.push(language.status(status))
  assert.ok(shown.every(text => text.length > 0 && !/[{}]/.test(text)), 'no phrase is empty or leaves a placeholder')
  assert.equal(english.status({ key: 'shortened', tone: 'idle', n: 3 }), '3 outputs shortened')
  assert.equal(english.status({ key: 'shortened', tone: 'idle', n: 1 }), '1 output shortened')
  assert.equal(english.status({ key: 'idleUntil', tone: 'idle', percent: 59 }), 'Idle until 59% full')
  assert.deepEqual(english.full(55), { before: '', figure: '55%', after: 'full' })
  assert.deepEqual(chinese.full(55), { before: '已用', figure: '55%', after: '' })
  // the forbidden words, over everything the bar can say: the shared strings and this plugin's own few
  const flatten = (value: unknown, out: string[] = []): string[] => {
    if (typeof value === 'string') out.push(value)
    else if (typeof value === 'function') { try { const text = (value as (...a: any[]) => unknown)(3, 4, 5); if (typeof text === 'string') out.push(text) } catch { /* needs another shape */ } }
    else if (value && typeof value === 'object') for (const inner of Object.values(value)) flatten(inner, out)
    return out
  }
  for (const [language, words] of [['en', vocabulary.forbidden.en], ['zh', vocabulary.forbidden.zh]] as const) {
    const texts = [...flatten(language === 'en' ? english : chinese), ...(language === 'en' ? Object.values(english.gaugeReason ? ['x'] : []) : [])]
    for (const text of texts.map(t => t.toLowerCase())) for (const word of words) {
      const hit = language === 'en' ? new RegExp(`\\b${word}`).test(text) : text.includes(word)
      assert.ok(!hit, `"${text}" contains "${word}"`)
    }
  }
  for (const reason of ['no_request_yet', 'no_context_window', 'unusable_context_window', 'managed_elsewhere', 'no_token_meter', 'other']) {
    for (const language of [english, chinese]) assert.ok(language.gaugeReason(reason).length > 0)
  }
})

test('the plugin\'s copies of the shared vocabulary and drawings equal the engine repository\'s', { skip: !existsSync(join(root, '..', 'Tameru', 'docs', 'ui-vocabulary.json')) && 'the engine repository is not beside this one' }, () => {
  for (const file of ['ui-vocabulary.json', 'ui-icons.json']) {
    const ours = JSON.parse(readFileSync(join(root, 'src', 'shared', file), 'utf8'))
    const theirs = JSON.parse(readFileSync(join(root, '..', 'Tameru', 'docs', file), 'utf8'))
    assert.deepEqual(ours, theirs, `${file} must be the engine repository's copy, unchanged`)
  }
})

// A render test with a tiny stand-in for React: it calls the bar's own function, so a typo, a missing import or a primitive that is not there
// shows up here instead of in the user's Harness. `overrides` replaces the Nth `useState` of the render (the bar's state is the fourth).
function renderBar(options: { primitives: Record<string, unknown>; state?: Record<string, unknown>; props?: Record<string, unknown>; throwing?: boolean }): any {
  ;(globalThis as any).document = { documentElement: { lang: 'en' }, createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} } }
  let call = 0
  const react = {
    // components are called at once, as React would when it renders them, so the whole tree is there to look at
    createElement: (type: any, props: any, ...children: unknown[]): any => {
      const all = { ...(props ?? {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) }
      if (typeof type === 'function' && type.prototype?.render) {
        const instance = new type(all)
        instance.props = all
        // an error thrown while a child rendered is handed to the boundary, as React does
        const failed = [all.children].flat().find((child: any) => child && child.type === '__error')
        if (failed && type.getDerivedStateFromError) instance.state = type.getDerivedStateFromError(failed.error)
        return instance.render()
      }
      if (typeof type === 'function') {
        try { return type(all) } catch (error) { return { type: '__error', error, props: {}, children: [] } }
      }
      return { type, props: props ?? {}, children: children.flat() }
    },
    cloneElement: (element: any, props: any) => ({ ...element, props: { ...element.props, ...props } }),
    Fragment: 'fragment',
    Component: class { props: any; state: any; constructor(props: any) { this.props = props } },
    useState: (initial: unknown) => {
      const index = call++
      const value = index === 3 && options.state ? options.state : typeof initial === 'function' ? (initial as () => unknown)() : initial
      return [value, () => {}]
    },
    useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v: unknown) => ({ current: v }), useCallback: (f: unknown) => f,
  }
  ;(globalThis as any).window = { __ModuleLoader__: { load: (d: unknown) => ((globalThis as any).__def = d) } }
  new Function('window', source)((globalThis as any).window)
  const exports = (globalThis as any).__def.factory((name: string) => (name === 'react' ? react : name === 'react-dom' ? { createPortal: (child: unknown) => child } : name.includes('primitives') ? options.primitives : {}))
  let body: any
  exports.apply({ effect: (setup: () => unknown) => setup(), slots: { inject: (_: string, factory: () => unknown) => factory(), register: (_: unknown, component: unknown) => (body = component) } })
  return body({ sessionId: 'chat-1', ...(options.props ?? {}) })
}

const textOf = (node: any): string => (node == null || typeof node === 'boolean' ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : [node.props?.['aria-label'], ...(node.children ?? []).map(textOf)].filter(Boolean).join(' '))
const find = (node: any, test: (n: any) => boolean, found: any[] = []): any[] => {
  if (node && typeof node === 'object') { if (test(node)) found.push(node); for (const child of node.children ?? []) find(child, test, found) }
  return found
}

const liveState = {
  sessionKey: 'chat-1', live: true, ok: true, version: '0.1.2', python: '/py', engine: { state: 'running' }, working: false, failure: null,
  gauge: { tokens: 64_000, contextWindow: 128_000, stockTrigger: 100_000, startsAt: 75_000 }, chat: { pending: 0, lastSkip: null },
  items: [
    { ref: 12, tool: 'bash', label: 'npm test -- checkout', state: 'shortened', originalChars: 20_000, shownChars: 1_200, onSurface: true },
    { ref: 18, tool: 'read_file', label: 'src/checkout.ts', state: 'kept', originalChars: 14_800, shownChars: 14_900, onSurface: true },
  ],
  pins: ['Never touch the production config'], limits: { pins: 5, pinChars: 300 }, settings: { values: { shorten: true, minConfidence: 0.7 }, defaults: {}, saved: false },
}
const pressure = (name: string) => (name === 'contextPressure' ? { projectedTokens: 64_000, contextWindow: 128_000 } : undefined)

test('the bar renders with none of the Harness UI parts present: plain fallbacks, nothing throws', () => {
  const bar = renderBar({ primitives: {}, state: liveState, props: { useProjection: pressure } })
  const text = textOf(bar)
  assert.match(text, /Tameru/)
  assert.match(text, /\(ためる\)/)
  assert.match(text, /50%/)
  assert.match(text, /1 output shortened/, 'the phrase counts what is shortened, not what is kept')
  assert.ok(find(bar, n => n.type === 'small' && n.props.lang === 'ja').length === 1, 'the kana carries its language')
  const labels = find(bar, n => n.type === 'button').map(n => n.props['aria-label']).filter(Boolean)
  assert.ok(labels.some((l: string) => l.startsWith('Strength: Normal')), `the strength menu button: ${labels}`)
  assert.ok(labels.includes('Shortened, 1') && labels.includes('Pins, 1'), `the two launchers carry the counts: ${labels}`)
  assert.equal(find(bar, n => n.props?.['aria-label'] === 'Pause').length, 0, 'there is no pause button: Off replaces it')
  assert.ok(find(bar, n => n.type === 'svg').length >= 4, 'star, ring, chevron and icons are all drawn without the Harness icons')
  assert.equal(find(bar, n => n.type === 'select').length, 0, 'no native select')
})

test('Off, a custom gate and the other strengths show the right label, and a held output is not counted as shortened', () => {
  const off = renderBar({ primitives: {}, state: { ...liveState, settings: { values: { shorten: false, minConfidence: 0.7 } } } })
  assert.match(textOf(off), /Strength: Off/)
  assert.match(textOf(off), /\bOff\b/)
  const more = renderBar({ primitives: {}, state: { ...liveState, settings: { values: { shorten: true, minConfidence: 0.55 } } } })
  assert.match(textOf(more), /Strength: More/)
  const custom = renderBar({ primitives: {}, state: { ...liveState, settings: { values: { shorten: true, minConfidence: 0.42 } } } })
  assert.match(textOf(custom), /Strength: Custom/)
  const keptOnly = renderBar({ primitives: {}, state: { ...liveState, items: [liveState.items[1]] } })
  assert.match(textOf(keptOnly), /1 kept in full/)
  assert.match(textOf(keptOnly), /Shortened, 0/, 'the launcher stays and reads zero')
})

test('a part of the Harness UI that exists but is not a component cannot blank the bar', () => {
  const bar = renderBar({ primitives: { Tooltip: 'oops', IconCloseOutlineRegular: { not: 'a component' }, IconPinOutlineRegular: 42 }, state: liveState })
  assert.match(textOf(bar), /Tameru/)
})

test('when the bar itself throws, a plain name and a quiet line stand in and the render does not throw', () => {
  const bar = renderBar({ primitives: {}, state: { ...liveState, items: 'not a list', pins: null } })
  assert.match(textOf(bar), /Tameru/)
  assert.match(textOf(bar), /Problem/)
})

test('with the Harness UI parts present they are used for hover cards and icons', () => {
  const used: string[] = []
  const part = (name: string) => (props: any) => (used.push(name), { type: name, props, children: [] })
  const primitives = { Tooltip: (props: any) => (used.push('Tooltip'), props.children), IconFlatListOutlineRegular: part('IconList'), IconPinOutlineRegular: part('IconPin'), IconChevronDownOutlineRegular: part('IconDown') }
  const bar = renderBar({ primitives, state: liveState })
  for (const name of ['Tooltip', 'IconList', 'IconPin', 'IconDown']) assert.ok(used.includes(name), `${name} was used: ${used}`)
  assert.match(textOf(bar), /Tameru/)
})

test('before the chat has answered the bar still shows its name, and offers nothing it cannot do', () => {
  const bar = renderBar({ primitives: {} })
  assert.match(textOf(bar), /Tameru/)
  const labels = find(bar, n => n.type === 'button').map(n => n.props['aria-label']).filter(Boolean)
  assert.ok(!labels.some((l: string) => l.startsWith('Strength')) && !labels.includes('Pins, 0'), 'no strength and no launchers until the plugin answers')
})

test('a problem is a short phrase, tints the star, and the raw error is never on the bar', () => {
  const bar = renderBar({ primitives: {}, state: { ...liveState, python: null, failure: 'ENOENT: secret/path/leaked.txt' } })
  assert.match(textOf(bar), /Not running/)
  assert.ok(!/ENOENT|secret/.test(textOf(bar)))
  assert.ok(find(bar, n => n.type === 'span' && String(n.props.className).includes('tameru-star problem')).length === 1)
  const failed = renderBar({ primitives: {}, state: { ...liveState, failure: 'ENOENT: secret/path/leaked.txt' } })
  assert.match(textOf(failed), /Problem/)
  assert.ok(!/ENOENT|secret/.test(textOf(failed)), 'raw error text stays in the details')
})
