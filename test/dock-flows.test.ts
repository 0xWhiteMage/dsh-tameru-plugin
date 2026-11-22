import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test, type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'

type View = (props: any) => Element
type Element = { type: string | symbol | View; props: Record<string, any>; children: Child[] }
type Child = Element | string | number | boolean | null | undefined | Child[]
type Effect = () => (() => void) | void
type Cleanup = Array<() => void>
type Hooks = { state(initial: unknown): unknown; ref(initial: unknown): unknown; memo(value: unknown, deps: unknown[]): unknown; effect(run: Effect, deps: unknown[]): void }
type RequestBody = { endpoint: string; payload: Record<string, unknown> }

const moduleUrl = (source: string) => 'data:text/javascript,' + encodeURIComponent(source)
const reactUrl = moduleUrl(`
  export const runtime = {}
  export const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })
  export const cloneElement = (node, props) => ({ ...node, props: { ...node.props, ...props } })
  export const Fragment = Symbol('Fragment')
  export class Component {}
  export const useState = initial => runtime.hooks.state(initial)
  export const useRef = initial => runtime.hooks.ref(initial)
  export const useCallback = (value, deps) => runtime.hooks.memo(value, deps)
  export const useEffect = (run, deps) => runtime.hooks.effect(run, deps)
  export const useLayoutEffect = useEffect
`)
const portalUrl = moduleUrl('export const createPortal = node => node')
const primitivesUrl = moduleUrl('export {}')
const { runtime } = await import(reactUrl) as { runtime: { hooks?: Hooks } }
const entry = new URL('../src/client/index.tsx', import.meta.url)
const helpers = new URL('../src/client/ui.ts', import.meta.url).href
let client: Promise<typeof import('../src/client/index.tsx')> | undefined

function loadClient() {
  if (client) return client
  const resolution = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL === entry.href || context.parentURL === helpers) {
        if (specifier === 'react') return { url: reactUrl, shortCircuit: true }
        if (specifier === 'react-dom') return { url: portalUrl, shortCircuit: true }
        if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { url: primitivesUrl, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(resolved, context, nextLoad) {
      if (resolved === entry.href) return { format: 'module-typescript', source: readFileSync(entry, 'utf8'), shortCircuit: true }
      return nextLoad(resolved, context)
    },
  })
  return client = import(entry.href).finally(() => resolution.deregister())
}

function find(child: Child, match: (node: Element) => boolean): Element | undefined {
  if (Array.isArray(child)) {
    for (const next of child) {
      const node = find(next, match)
      if (node) return node
    }
  } else if (child && typeof child === 'object') {
    if (match(child)) return child
    return find(child.children, match)
  }
}

function requireNode(child: Child, match: (node: Element) => boolean): Element {
  const node = find(child, match)
  assert.ok(node, 'expected the dock control to be rendered')
  return node
}

const withClass = (name: string) => (node: Element) => node.props.className === name
const withId = (id: string) => (node: Element) => node.props.id === id
const button = (label: string) => (node: Element) => node.type === 'button' && node.children.includes(label)

function mount(cleanups: Cleanup, element: Element) {
  const slots: Array<{ value?: any; deps?: unknown[]; cleanup?: () => void }> = []
  cleanups.push(() => { for (const slot of slots.reverse()) slot.cleanup?.() })
  return () => {
    let index = 0
    const effects: Array<() => void> = []
    const compare = (deps: unknown[]) => {
      const slot = slots[index++] ??= {}
      const changed = !slot.deps || slot.deps.length !== deps.length || deps.some((dep, i) => !Object.is(dep, slot.deps![i]))
      slot.deps = deps
      return { slot, changed }
    }
    runtime.hooks = {
      state(initial) {
        const slot = slots[index++] ??= { value: typeof initial === 'function' ? initial() : initial }
        return [slot.value, (next: any) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
      },
      ref(initial) {
        const slot = slots[index++] ??= { value: { current: initial } }
        return slot.value
      },
      memo(value, deps) {
        const { slot, changed } = compare(deps)
        if (changed) slot.value = value
        return slot.value
      },
      effect(run, deps) {
        const { slot, changed } = compare(deps)
        if (changed) effects.push(() => {
          slot.cleanup?.()
          slot.cleanup = run() || undefined
        })
      },
    }
    assert.equal(typeof element.type, 'function')
    let tree: Element
    try { tree = (element.type as View)(element.props) } finally { delete runtime.hooks }
    const anchor = find(tree, withClass('tameru-bar'))
    if (anchor) anchor.props.ref.current = { getBoundingClientRect: () => ({ top: 500, width: 600, right: 800 }) }
    for (const effect of effects) effect()
    return tree
  }
}

function fakeGlobal(cleanups: Cleanup, name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true })
  cleanups.push(() => {
    if (previous) Object.defineProperty(globalThis, name, previous)
    else Reflect.deleteProperty(globalThis, name)
  })
}

async function dock(t: TestContext, respond: (request: RequestBody) => Response | Promise<Response>) {
  const cleanups: Cleanup = []
  t.after(() => { for (const cleanup of cleanups.reverse()) cleanup() })
  const actions: RequestBody[] = []
  let pins = ['Keep the build log']
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  fakeGlobal(cleanups, 'document', {
    documentElement: { lang: 'en' }, body: {}, hidden: false,
    head: { appendChild() {} }, createElement: () => ({ setAttribute() {}, remove() {} }),
    addEventListener() {}, removeEventListener() {}, getElementById: () => null,
  })
  fakeGlobal(cleanups, 'window', { innerWidth: 1000, innerHeight: 700, requestAnimationFrame: () => 1, cancelAnimationFrame() {} })
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as RequestBody
    if (request.endpoint === 'state') return Response.json({
      ok: true, live: true, python: '/python', engine: { state: 'idle' }, settings: { values: { shorten: true, minConfidence: 0.7 } },
      pins, limits: { pins: 5, pinChars: 300 },
      items: [{ ref: 7, tool: 'bash', label: 'npm test', state: 'shortened', onSurface: true, originalChars: 2000, shownChars: 200 }],
    })
    actions.push(request)
    if (request.endpoint === 'pin') {
      pins = [...pins, String(request.payload.text)]
      return Response.json({ ok: true })
    }
    if (request.endpoint === 'unpin') {
      pins = pins.filter((_, index) => index + 1 !== request.payload.position)
      return Response.json({ ok: true })
    }
    return respond(request)
  })
  const { apply } = await loadClient()
  const components: View[] = []
  apply({
    effect: (setup: () => unknown) => setup(),
    slots: { inject: (_: string, setup: () => unknown) => setup(), register: (_: unknown, view: View) => { components.push(view) } },
  })
  const [component] = components
  assert.ok(component)
  const bar = requireNode(component({ sessionId: 'chat' }).children, node => typeof node.type === 'function')
  const mountView = (element: Element) => mount(cleanups, element)
  const render = mountView(bar)
  render()
  await setImmediate()
  return { actions, render, mountView }
}

async function openViewer(t: TestContext, respond: (request: RequestBody) => Response | Promise<Response>) {
  const { actions, render, mountView } = await dock(t, respond)
  requireNode(render(), withId('tameru-launch-results')).props.onClick()
  render()
  const row = requireNode(render(), node => typeof node.type === 'function' && typeof node.props.open === 'function')
  const renderRow = mountView(row)
  requireNode(renderRow(), withClass('tameru-rowmain')).props.onClick()
  const card = requireNode(render(), withId('tameru-card'))
  const viewer = requireNode(card, node => typeof node.props.onBack === 'function')
  const renderViewer = mountView(viewer)
  const aiSees = requireNode(renderViewer(), button('AI sees'))
  t.after(() => { aiSees.props.onClick() })
  return { actions, renderViewer }
}

const page = (text: string, end: number, total = end) => Response.json({ ok: true, text, end, total })
const shownText = (tree: Element) => requireNode(tree, node => node.type === 'pre').children[0]

test('the viewer appends a page at the returned offset, then resets the offset and content when switching to Original', async t => {
  const { actions, renderViewer } = await openViewer(t, request => {
    if (request.payload.which === 'original') return page('full original', 13)
    return request.payload.offset === 0 ? page('first ', 6, 10) : page('page', 10)
  })
  await setImmediate()
  assert.equal(shownText(renderViewer()), 'first ')
  requireNode(renderViewer(), withClass('tameru-more')).props.onClick()
  assert.equal(requireNode(renderViewer(), withClass('tameru-more')).props.disabled, true)
  await setImmediate()
  assert.equal(shownText(renderViewer()), 'first page')
  assert.equal(find(renderViewer(), withClass('tameru-more')), undefined)
  requireNode(renderViewer(), button('Original')).props.onClick()
  renderViewer()
  await setImmediate()
  assert.equal(shownText(renderViewer()), 'full original')
  assert.equal(requireNode(renderViewer(), button('Original')).props['aria-pressed'], true)
  assert.deepEqual(actions, [
    { endpoint: 'view', payload: { sessionId: 'chat', ref: 7, which: 'shown', offset: 0 } },
    { endpoint: 'view', payload: { sessionId: 'chat', ref: 7, which: 'shown', offset: 6 } },
    { endpoint: 'view', payload: { sessionId: 'chat', ref: 7, which: 'original', offset: 0 } },
  ])
})

test('a late AI-sees response cannot overwrite the selected Original view', { todo: 'Viewer does not guard an earlier request when the side changes' }, async t => {
  const shown = Promise.withResolvers<Response>()
  const { actions, renderViewer } = await openViewer(t, request => request.payload.which === 'original' ? page('full original', 13) : shown.promise)
  requireNode(renderViewer(), button('Original')).props.onClick()
  renderViewer()
  await setImmediate()
  assert.equal(shownText(renderViewer()), 'full original')
  assert.deepEqual(actions.map(request => request.payload.which), ['shown', 'original'])
  shown.resolve(page('short extract', 13))
  await setImmediate()
  assert.equal(requireNode(renderViewer(), button('Original')).props['aria-pressed'], true)
  assert.equal(shownText(renderViewer()), 'full original')
})

test('pin input ignores both IME Enter forms, then submits the finished line and can undo a removal', async t => {
  const { actions, render, mountView } = await dock(t, request => assert.fail(`unexpected ${request.endpoint}`))
  requireNode(render(), withId('tameru-launch-pins')).props.onClick()
  render()
  const pins = requireNode(render(), node => typeof node.props.refresh === 'function')
  const renderPins = mountView(pins)
  requireNode(renderPins(), withId('tameru-pin-input')).props.onChange({ target: { value: '保持日志' } })
  const input = requireNode(renderPins(), withId('tameru-pin-input'))
  let prevented = 0
  const enter = { key: 'Enter', preventDefault: () => { prevented++ } }
  input.props.onKeyDown({ ...enter, nativeEvent: { isComposing: true } })
  input.props.onKeyDown({ ...enter, keyCode: 229 })
  assert.equal(prevented, 0)
  assert.deepEqual(actions, [])
  input.props.onKeyDown(enter)
  await setImmediate()
  assert.equal(prevented, 1)
  assert.equal(requireNode(renderPins(), withId('tameru-pin-input')).props.value, '')
  const remove = requireNode(renderPins(), node => typeof node.type === 'function' && node.props.label?.endsWith(': Keep the build log'))
  remove.props.onClick()
  await setImmediate()
  requireNode(renderPins(), button('Undo')).props.onClick()
  await setImmediate()
  assert.equal(find(renderPins(), button('Undo')), undefined)
  assert.deepEqual(actions, [
    { endpoint: 'pin', payload: { sessionId: 'chat', text: '保持日志' } },
    { endpoint: 'unpin', payload: { sessionId: 'chat', position: 1 } },
    { endpoint: 'pin', payload: { sessionId: 'chat', text: 'Keep the build log' } },
  ])
})
