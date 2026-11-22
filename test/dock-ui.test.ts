import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test, type TestContext } from 'node:test'
import { copy } from '../src/client/text.ts'

const moduleUrl = (source: string) => 'data:text/javascript,' + encodeURIComponent(source)
const reactUrl = moduleUrl(`
  export const effects = []
  export const updates = []
  export const useEffect = effect => effects.push(effect)
  export const useLayoutEffect = useEffect
  export const useState = initial => [initial, value => updates.push(value)]
  export const cloneElement = (element, props) => ({ ...element, props: { ...element.props, ...props } })
  export const createElement = (type, props, ...children) => ({ type, props, children })
  export const Fragment = Symbol('Fragment')
`)
const primitivesUrl = moduleUrl('export {}')
const react = await import(reactUrl) as { effects: Array<() => void | (() => void)>; updates: unknown[] }
const resolution = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === new URL('../src/client/ui.ts', import.meta.url).href) {
      if (specifier === 'react') return { url: reactUrl, shortCircuit: true }
      if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { url: primitivesUrl, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
const { focusables, useAnchor, useDismiss } = await import('../src/client/ui.ts').finally(() => resolution.deregister())

function globalForTest(t: TestContext, key: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key)
  Object.defineProperty(globalThis, key, { value, configurable: true })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, key, previous)
    else Reflect.deleteProperty(globalThis, key)
  })
}

function runEffect() {
  assert.equal(react.effects.length, 1)
  return react.effects.shift()!()
}

test('the card follows its anchor on animation frames, clamps to the viewport and cancels the frame on close', t => {
  let id = 0
  const frames = new Map<number, FrameRequestCallback>()
  const window = {
    innerWidth: 280, innerHeight: 600,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++id, callback); return id },
    cancelAnimationFrame: (frame: number) => frames.delete(frame),
  }
  globalForTest(t, 'window', window)
  t.after(() => { react.effects.length = react.updates.length = 0 })
  const tick = () => {
    assert.equal(frames.size, 1)
    const [frame, callback] = [...frames][0]!
    frames.delete(frame)
    callback(0)
  }

  let rect = { top: 400, right: 270, width: 300 }
  const anchor = { current: { getBoundingClientRect: () => rect } as HTMLElement }
  useAnchor(true, anchor, 480)
  const cleanup = runEffect()
  assert.deepEqual(react.updates.splice(0), [{ left: 12, bottom: 206, width: 256, maxHeight: 382 }])
  tick()
  assert.deepEqual(react.updates, [], 'an unchanged anchor does not cause a state update')
  window.innerWidth = 1000
  rect = { top: 200, right: 800, width: 300 }
  tick()
  assert.deepEqual(react.updates.splice(0), [{ left: 500, bottom: 406, width: 300, maxHeight: 182 }])
  assert.ok(typeof cleanup === 'function')
  cleanup()
  assert.equal(frames.size, 0)

  rect = { top: 12, right: 800, width: 120 }
  useAnchor(true, anchor, 264, 6, true)
  const menuCleanup = runEffect()
  assert.deepEqual(react.updates.splice(0), [{ left: 536, bottom: 594, width: 264, maxHeight: 0 }])
  assert.ok(typeof menuCleanup === 'function')
  menuCleanup()
  useAnchor(false, anchor, 264)
  runEffect()
  assert.deepEqual(react.updates.splice(0), [undefined])
  assert.equal(frames.size, 0)
})

test('dismiss ignores inside presses, handled Escape and Escape in the composer, then detaches both listeners', t => {
  const card = {}
  const launcher = {}
  const composer = {}
  const body = {}
  const target = new EventTarget()
  const doc = {
    body, activeElement: composer as object | null,
    addEventListener: (type: string, listener: EventListener, capture = false) => target.addEventListener(type, listener, { capture }),
    removeEventListener: (type: string, listener: EventListener, capture = false) => target.removeEventListener(type, listener, { capture }),
  }
  globalForTest(t, 'document', doc)
  t.after(() => { react.effects.length = 0 })
  const inside = [card, launcher].map(node => ({ current: { contains: (target: Node) => target === node } as HTMLElement }))
  let closed = 0
  const close = () => { closed++ }
  const event = (kind: string, data: Record<string, unknown>, handled = false) => {
    const ev = new Event(kind, { cancelable: true })
    for (const [key, value] of Object.entries(data)) Object.defineProperty(ev, key, { value })
    if (handled) ev.preventDefault()
    target.dispatchEvent(ev)
  }

  useDismiss(false, inside, close)
  runEffect()
  event('pointerdown', { target: composer })
  assert.equal(closed, 0)
  useDismiss(true, inside, close)
  const cleanup = runEffect()
  event('pointerdown', { target: card })
  event('pointerdown', { target: launcher })
  event('keydown', { key: 'Escape' })
  doc.activeElement = card
  event('keydown', { key: 'Escape' }, true)
  event('keydown', { key: 'Enter' })
  assert.equal(closed, 0)

  event('keydown', { key: 'Escape' })
  assert.equal(closed, 1)
  doc.activeElement = body
  event('keydown', { key: 'Escape' })
  assert.equal(closed, 2)
  doc.activeElement = null
  event('keydown', { key: 'Escape' })
  assert.equal(closed, 3)
  event('pointerdown', { target: composer })
  assert.equal(closed, 4)
  assert.ok(typeof cleanup === 'function')
  cleanup()
  event('keydown', { key: 'Escape' })
  event('pointerdown', { target: composer })
  assert.equal(closed, 4)
})

test('tab handoff ignores hidden elements but keeps the active element in document order', t => {
  const visible = { offsetParent: {} }
  const hidden = { offsetParent: null }
  const active = { offsetParent: null }
  const last = { offsetParent: {} }
  const root = { querySelectorAll: () => [visible, hidden, active, last] } as unknown as HTMLElement
  globalForTest(t, 'document', { activeElement: active })
  assert.deepEqual(focusables(root), [visible, active, last])
  assert.deepEqual(focusables(null), [])
})

test('copy falls back to navigator language for a blank document language, but an explicit document language wins', t => {
  const documentElement = { lang: '' }
  globalForTest(t, 'document', { documentElement })
  globalForTest(t, 'navigator', { language: 'ZH-Hant' })
  assert.equal(copy().card, 'Tameru 详情')
  documentElement.lang = 'en-GB'
  assert.equal(copy().card, 'Tameru details')
  documentElement.lang = 'fr'
  assert.equal(copy().card, 'Tameru details')
})
