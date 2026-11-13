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
  assert.deepEqual(exports.inject, ['slots', 'sidebarRightTabs'])
  assert.equal(typeof exports.apply, 'function')
  for (const name of new Set(required)) assert.ok(['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'].includes(name), `unexpected module request: ${name}`)
  assert.ok(!/@deepseek-ai\/dsh-(?!client-ui-primitives)/.test(source.replace(/\/\/.*$/gm, '').match(/require\("[^"]+"\)/g)?.join('\n') ?? ''), 'no other Harness package is required')
})

test('applying it registers one tab type and one body, with function titles, and removes them all when unloaded', () => {
  const { definition } = load()
  const exports = definition.factory(() => ({}))
  const styles: any[] = []
  ;(globalThis as any).document = {
    createElement: () => ({ setAttribute() {}, remove() { styles.length = 0 }, textContent: '' }),
    head: { appendChild: (element: unknown) => styles.push(element) },
    documentElement: { lang: 'en' },
  }
  const types: any[] = []
  const bodies: any[] = []
  const disposers: Array<() => void> = []
  const removed: string[] = []
  exports.apply({
    effect: (setup: () => unknown, label?: string) => {
      const dispose = setup()
      disposers.push(() => {
        removed.push(label ?? '')
        if (typeof dispose === 'function') dispose()
      })
    },
    sidebarRightTabs: { register: (type: unknown) => (types.push(type), () => types.splice(types.indexOf(type), 1)) },
    slots: { register: (key: unknown, body: unknown) => (bodies.push({ key, body }), () => bodies.splice(0)) },
  })
  assert.equal(types.length, 1)
  const type = types[0]
  assert.equal(type.id, 'dsh-tameru/panel')
  assert.equal(type.kind, 'tameru')
  assert.equal(typeof type.title, 'function')
  assert.equal(type.title(), 'Tameru')
  assert.equal(type.guide.length, 1)
  for (const entry of type.guide) {
    assert.equal(typeof entry.title, 'function', 'a string title crashes the Harness guide')
    assert.equal(typeof entry.description, 'function', 'a string description crashes the Harness guide')
    assert.ok(entry.title().length > 0 && entry.description().length > 0)
  }
  assert.deepEqual(bodies.map(b => b.key), [{ name: 'sidebar.right.pane.tab', key: 'dsh-tameru/panel' }])
  assert.equal(typeof bodies[0].body, 'function')
  assert.equal(styles.length, 1, 'one style element was added')
  for (const dispose of disposers.reverse()) dispose()
  assert.equal(types.length, 0)
  assert.equal(bodies.length, 0)
  assert.equal(styles.length, 0, 'the style element was removed')
})

test('the panel\'s words exist in English and Chinese, every string non-empty', () => {
  for (const language of ['en', 'zh-CN']) {
    ;(globalThis as any).document = { documentElement: { lang: language } }
    const text: Record<string, unknown> = copy() as never
    for (const [key, value] of Object.entries(text)) {
      if (typeof value === 'string') assert.ok(value.length > 0, `${language}.${key}`)
      else assert.equal(typeof value, 'function', `${language}.${key}`)
    }
  }
  ;(globalThis as any).document = { documentElement: { lang: 'zh-CN' } }
  assert.notEqual(copy().cleanups, (void ((globalThis as any).document = { documentElement: { lang: 'en' } }), copy().cleanups))
  const en = copy()
  assert.match(en.engine('on', '1.9.0'), /1\.9\.0/)
  assert.match(en.gaugeReason('no_context_window'), /context window/)
  assert.match(en.gaugeReason('anything else'), /not available/)
})
