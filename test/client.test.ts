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
  const statuses: any[] = [
    { tone: 'off', key: 'loading' }, { tone: 'off', key: 'notOpen' }, { tone: 'off', key: 'unreachable' }, { tone: 'off', key: 'shorteningOff' },
    { tone: 'warn', key: 'noPython' }, { tone: 'warn', key: 'enginePaused' }, { tone: 'warn', key: 'failure', text: 'x' },
    { tone: 'idle', key: 'waiting', count: 2 }, { tone: 'ok', key: 'shortened', count: 3, fresh: 1 }, { tone: 'ok', key: 'shortened', count: 3, fresh: 0 },
    { tone: 'idle', key: 'startsAt', percent: 56 }, { tone: 'idle', key: 'watching' },
  ]
  for (const language of [en, zh]) for (const status of statuses) assert.ok(language.status(status).length > 0, status.key)
  assert.match(en.gaugeReason('no_context_window'), /context window/)
  assert.match(en.gaugeReason('anything else'), /not available/)
  // nothing in the bar words may promise a saving
  const everything = JSON.stringify([en.presets, en.shorteningHelp, en.footer('1'), en.empty, en.status({ tone: 'ok', key: 'shortened', count: 2, fresh: 0 })])
  assert.ok(!/\bsav(e|ed|ing|ings)\b|\bfreed?\b|cheaper/i.test(everything))
})
