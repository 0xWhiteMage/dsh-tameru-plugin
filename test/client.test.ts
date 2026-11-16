// The browser half, built and loaded the way the Harness's module loader loads it, against a recording stand-in for the web client's
// context. It cannot render the panel (no React here); it proves what broke or could break the whole sidebar: the wrapper format, the
// declared dependencies, what is registered, that titles and descriptions are functions (a string crashes the Harness's guide), and that
// everything is unregistered when the plugin goes.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { copy } from '../src/client/text.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'ignore' })
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

function load(): { definition: { id: string; factory: (require: (name: string) => unknown) => Record<string, any> }; required: string[] } {
  const required: string[] = []
  let definition: any
  ;(globalThis as any).window = { __ModuleLoader__: { load: (d: unknown) => (definition = d) } }
  new Function('window', source)((globalThis as any).window)
  const react = { createElement: () => ({}), Fragment: Symbol('Fragment'), useState: (v: unknown) => [v, () => {}], useEffect: () => {}, useRef: (v: unknown) => ({ current: v }), useCallback: (f: unknown) => f }
  const originalFactory = definition.factory
  definition.factory = (_require: unknown) => originalFactory((name: string) => (required.push(name), name === 'react' ? react : {}))
  return { definition, required }
}

test('the bundle is in the Harness loader format and asks only for modules the web shell shares', () => {
  assert.match(source, /^\/\/ Generated from src\/client/)
  assert.match(source, /window\.__ModuleLoader__\.load\(\{\s*id: "dsh-tameru"/)
  const { definition, required } = load()
  const exports = definition.factory(() => ({}))
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
  for (const name of new Set(required)) assert.ok(['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'].includes(name), `unexpected module request: ${name}`)
  assert.ok(!/@deepseek-ai\/dsh-(?!client-ui-primitives)/.test(source.replace(/\/\/.*$/gm, '').match(/require\("[^"]+"\)/g)?.join('\n') ?? ''), 'no other Harness package is required')
})

test('applying it registers one dock bar in the input dock, and removes it and its style when unloaded', () => {
  const { definition } = load()
  const exports = definition.factory(() => ({}))
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

test('the bar words exist in English and Chinese with the same keys, and every phrase the bar can show is written', () => {
  const shapes = (value: unknown): unknown =>
    typeof value === 'function' ? 'function' : typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shapes(inner)])) : typeof value
  ;(globalThis as any).document = { documentElement: { lang: 'en' } }
  const en = copy()
  ;(globalThis as any).document = { documentElement: { lang: 'zh-CN' } }
  const zh = copy()
  assert.deepEqual(shapes(zh), shapes(en), 'the same keys and kinds in both languages')
  assert.notEqual(zh.tabs.results, en.tabs.results)
  assert.ok(zh.kana === en.kana && en.kana === '(ためる)', 'the Japanese name is part of the brand in both languages')
  const statuses: any[] = [
    { tone: 'off', key: 'loading' }, { tone: 'off', key: 'notOpen' }, { tone: 'off', key: 'unreachable' }, { tone: 'off', key: 'paused' }, { tone: 'ok', key: 'kept', count: 2 },
    { tone: 'warn', key: 'noPython' }, { tone: 'warn', key: 'enginePaused' }, { tone: 'warn', key: 'failure', text: 'x' },
    { tone: 'idle', key: 'waiting', count: 2 }, { tone: 'ok', key: 'shortened', count: 3, fresh: 1 }, { tone: 'ok', key: 'shortened', count: 3, fresh: 0 },
    { tone: 'idle', key: 'startsAt', percent: 56 }, { tone: 'idle', key: 'watching' },
  ]
  for (const language of [en, zh]) for (const status of statuses) assert.ok(language.status(status).length > 0, status.key)
  assert.match(en.gaugeReason('no_context_window'), /context window/)
  assert.match(en.gaugeReason('anything else'), /not available/)
  // nothing in the bar words may promise a saving
  const everything = JSON.stringify([en.modes, en.pauseTip, en.resumeTip, en.nameTip('1'), en.empty, en.status({ tone: 'ok', key: 'shortened', count: 2, fresh: 0 })])
  assert.ok(!/\bsav(e|ed|ing|ings)\b|\bfreed?\b|cheaper/i.test(everything))
})

// A render test with a tiny stand-in for React: it calls the bar's own function, so a typo, a missing import or a primitive that is not there
// shows up here instead of in the user's Harness. `overrides` replaces the Nth `useState` of the render (the bar's state is the fourth).
function renderBar(options: { primitives: Record<string, unknown>; state?: Record<string, unknown>; props?: Record<string, unknown> }): any {
  ;(globalThis as any).document = { documentElement: { lang: 'en' }, createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} } }
  let call = 0
  const react = {
    // components are called at once, as React would when it renders them, so the whole tree is there to look at
    createElement: (type: unknown, props: any, ...children: unknown[]): any =>
      typeof type === 'function' ? type({ ...(props ?? {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) }) : { type, props: props ?? {}, children: children.flat() },
    cloneElement: (element: any, props: any) => ({ ...element, props: { ...element.props, ...props } }),
    Fragment: 'fragment',
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

const textOf = (node: any): string => (node == null || typeof node === 'boolean' ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : [node.props?.['aria-label'], node.props?.title, ...(node.children ?? []).map(textOf)].filter(Boolean).join(' '))
const find = (node: any, test: (n: any) => boolean, found: any[] = []): any[] => {
  if (node && typeof node === 'object') { if (test(node)) found.push(node); for (const child of node.children ?? []) find(child, test, found) }
  return found
}

const liveState = {
  sessionKey: 'chat-1', live: true, ok: true, version: '0.1.2', python: '/py', engine: { state: 'running' }, working: false, failure: null,
  gauge: { tokens: 64_000, contextWindow: 128_000, stockTrigger: 100_000, startsAt: 75_000 }, chat: { pending: 0, lastSkip: null },
  items: [{ ref: 12, tool: 'bash', state: 'shortened', originalChars: 20_000, shownChars: 1_200, onSurface: true }],
  pins: ['Never touch the production config'], limits: { pins: 5, pinChars: 300 }, settings: { values: { shorten: true, minConfidence: 0.7 }, defaults: {}, saved: false },
}

test('the bar renders with none of the Harness UI parts present: plain fallbacks, nothing throws', () => {
  const bar = renderBar({ primitives: {}, state: liveState, props: { useProjection: (name: string) => (name === 'contextPressure' ? { projectedTokens: 64_000, contextWindow: 128_000 } : undefined) } })
  const text = textOf(bar)
  assert.match(text, /Tameru/)
  assert.match(text, /\(ためる\)/)
  assert.match(text, /50%/)
  assert.match(text, /1 new/, 'a result not seen yet is new')
  assert.ok(find(bar, n => n.type === 'select').length === 1, 'the mode choice is in the bar')
  const labels = find(bar, n => n.type === 'button').map(n => n.props['aria-label'])
  assert.ok(labels.includes('Pause') && labels.includes('Show details'), `pause and chevron are buttons: ${labels}`)
  assert.ok(find(bar, n => n.type === 'svg').length >= 3, 'icons fall back to inline drawings')
  const options = find(bar, n => n.type === 'option').map(n => n.children.join(''))
  assert.deepEqual(options, ['Shorten more', 'Balanced', 'Keep detail'])
})

test('with the Harness UI parts present they are used for hover cards, the status dot and icons', () => {
  const used: string[] = []
  const part = (name: string) => (props: any) => (used.push(name), { type: name, props, children: [] })
  const primitives = { Tooltip: (props: any) => (used.push('Tooltip'), props.children), StateDot: part('StateDot'), IconPinFillRegular: part('IconPinFill'), IconPauseOutlineRegular: part('IconPause'), IconChevronUpOutlineRegular: part('IconUp') }
  const bar = renderBar({ primitives, state: liveState })
  for (const name of ['Tooltip', 'StateDot', 'IconPinFill', 'IconPause', 'IconUp']) assert.ok(used.includes(name), `${name} was used: ${used}`)
  assert.equal(find(bar, n => n.type === 'svg').length, 0, 'no fallback drawing where the Harness icon exists')
  assert.match(textOf(bar), /Tameru/)
})

test('before the chat has answered the bar still shows its name and a quiet phrase, and offers nothing it cannot do', () => {
  const bar = renderBar({ primitives: {} })
  const text = textOf(bar)
  assert.match(text, /Tameru/)
  assert.equal(find(bar, n => n.type === 'select').length, 0, 'no mode choice until the plugin answers')
  const labels = find(bar, n => n.type === 'button').map(n => n.props['aria-label'])
  assert.ok(!labels.includes('Pause'), 'no pause until the plugin answers')
})

test('a problem is shown as a short phrase and tints the dot', () => {
  const bar = renderBar({ primitives: {}, state: { ...liveState, python: null } })
  assert.match(textOf(bar), /No Python/)
  assert.ok(find(bar, n => n.type === 'span' && String(n.props.className).includes('tameru-dot warn')).length === 1)
})
