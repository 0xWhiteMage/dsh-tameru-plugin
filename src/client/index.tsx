// The Tameru tab of the Harness's right sidebar. Plain React from the Harness's shared module table; every class is `tameru-*`, colours
// are the surrounding text colour and translucent overlays of it, so light and dark themes need no tokens of ours.
import { createElement as h, Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { copy, type Copy } from './text.ts'

export const inject = ['slots', 'sidebarRightTabs']

const ROUTE = 'api/tameru'
const POLL_MS = 2500
const TAB_ID = 'dsh-tameru/panel'

type Json = Record<string, any>

const STYLE = `
.tameru { font: inherit; color: inherit; padding: 12px 14px 20px; display: flex; flex-direction: column; gap: 16px; font-size: 13px; line-height: 1.45; overflow-y: auto; height: 100%; box-sizing: border-box; }
.tameru * { box-sizing: border-box; }
.tameru h3 { margin: 0 0 6px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; opacity: .6; }
.tameru-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.tameru-title { font-size: 15px; font-weight: 600; }
.tameru-chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; font-size: 11px; background: color-mix(in srgb, currentColor 10%, transparent); }
.tameru-dot { width: 7px; height: 7px; border-radius: 50%; background: #3fb950; }
.tameru-dot.off { background: #8b949e; } .tameru-dot.bad { background: #f0883e; }
.tameru-gauge { position: relative; height: 8px; border-radius: 4px; background: color-mix(in srgb, currentColor 12%, transparent); margin: 22px 0 6px; }
.tameru-fill { position: absolute; inset: 0 auto 0 0; border-radius: 4px; background: #4d6bfe; transition: width .4s ease; }
.tameru-fill.hot { background: #f0883e; }
.tameru-mark { position: absolute; top: -5px; bottom: -5px; width: 2px; background: color-mix(in srgb, currentColor 55%, transparent); }
.tameru-mark span { position: absolute; top: -16px; left: 50%; transform: translateX(-50%); font-size: 10px; white-space: nowrap; opacity: .75; }
.tameru-muted { opacity: .65; }
.tameru-note { padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, currentColor 7%, transparent); }
.tameru-list { display: flex; flex-direction: column; gap: 6px; }
.tameru-row { border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 10px; padding: 8px 10px; }
.tameru-row-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tameru-tool { font-weight: 600; } .tameru-ref { opacity: .55; font-variant-numeric: tabular-nums; }
.tameru-size { margin-left: auto; opacity: .8; font-variant-numeric: tabular-nums; }
.tameru-badge { padding: 0 7px; border-radius: 999px; font-size: 10.5px; background: color-mix(in srgb, #4d6bfe 28%, transparent); }
.tameru-badge.kept { background: color-mix(in srgb, #3fb950 30%, transparent); }
.tameru-actions { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
.tameru button { font: inherit; color: inherit; cursor: pointer; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); background: transparent; border-radius: 8px; padding: 3px 10px; }
.tameru button:hover:not(:disabled) { background: color-mix(in srgb, currentColor 10%, transparent); }
.tameru button:disabled { opacity: .45; cursor: default; }
.tameru button:focus-visible, .tameru input:focus-visible { outline: 2px solid #4d6bfe; outline-offset: 1px; }
.tameru button.primary { background: #4d6bfe; border-color: #4d6bfe; color: #fff; }
.tameru-seg { display: inline-flex; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 8px; overflow: hidden; }
.tameru-seg button { border: 0; border-radius: 0; } .tameru-seg button[aria-pressed="true"] { background: color-mix(in srgb, currentColor 16%, transparent); }
.tameru-view { margin-top: 8px; }
.tameru-pre { margin: 6px 0 0; max-height: 240px; overflow: auto; padding: 8px; border-radius: 8px; background: color-mix(in srgb, currentColor 8%, transparent); font: 11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
.tameru-pager { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 11px; }
.tameru-pin { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent); }
.tameru-pin span { flex: 1; word-break: break-word; }
.tameru-add { display: flex; gap: 6px; margin-top: 8px; }
.tameru-add input { flex: 1; min-width: 0; font: inherit; color: inherit; background: transparent; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 8px; padding: 4px 9px; }
.tameru-error { color: #f0883e; margin-top: 6px; }
.tameru details { border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 10px; padding: 8px 10px; }
.tameru summary { cursor: pointer; font-weight: 600; }
.tameru-field { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; margin-top: 10px; align-items: center; }
.tameru-field small { grid-column: 1 / -1; opacity: .65; }
.tameru input[type="range"] { grid-column: 1 / -1; width: 100%; }
.tameru-foot { font-size: 11px; opacity: .55; }
`

function installStyle(): () => void {
  const element = document.createElement('style')
  element.setAttribute('data-tameru', '')
  element.textContent = STYLE
  document.head.appendChild(element)
  return () => element.remove()
}

async function call(endpoint: string, payload: Json, signal?: AbortSignal): Promise<Json> {
  const response = await fetch(ROUTE, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload }), ...(signal ? { signal } : {}) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as Json
}

const n = (value: number): string => Math.round(value).toLocaleString()

function Gauge({ state, t }: { state: Json; t: Copy }) {
  const g = state.gauge
  if (!g) return h('div', { className: 'tameru-note' }, t.gaugeReason(state.gaugeUnavailable))
  const fraction = Math.min(1, g.tokens / g.stockTrigger)
  const start = g.startsAt / g.stockTrigger
  return h(Fragment, null,
    h('div', { className: 'tameru-gauge', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': g.stockTrigger, 'aria-valuenow': Math.min(g.tokens, g.stockTrigger), 'aria-label': t.gaugeLabel },
      h('div', { className: `tameru-fill${fraction >= 1 ? ' hot' : ''}`, style: { width: `${fraction * 100}%` } }),
      h('div', { className: 'tameru-mark', style: { left: `${start * 100}%` } }, h('span', null, t.starts)),
      h('div', { className: 'tameru-mark', style: { left: '100%' } }, h('span', { style: { transform: 'translateX(-100%)', left: 0 } }, t.compacts))),
    h('div', null, t.gaugeCaption(n(g.tokens), n(g.stockTrigger))),
    state.chat.freedTokens > 0 ? h('div', { className: 'tameru-muted' }, t.freed(n(state.chat.freedTokens), state.chat.shortened)) : null)
}

function Viewer({ item, sessionId, t }: { item: Json; sessionId: string; t: Copy }) {
  const [which, setWhich] = useState<'shown' | 'original'>('original')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<Json | null>(null)
  useEffect(() => {
    let live = true
    setPage(null)
    call('view', { sessionId, ref: item.ref, which, offset }).then(r => live && setPage(r), () => live && setPage({ ok: false, error: t.unreachable }))
    return () => { live = false }
  }, [sessionId, item.ref, which, offset, item.state])
  const switchTo = (next: 'shown' | 'original') => { setWhich(next); setOffset(0) }
  return h('div', { className: 'tameru-view' },
    h('div', { className: 'tameru-seg', role: 'group', 'aria-label': t.viewing },
      h('button', { type: 'button', 'aria-pressed': which === 'original', onClick: () => switchTo('original') }, t.original),
      h('button', { type: 'button', 'aria-pressed': which === 'shown', onClick: () => switchTo('shown') }, t.modelSees)),
    page === null ? h('div', { className: 'tameru-muted', style: { marginTop: 6 } }, t.loading)
      : !page.ok ? h('div', { className: 'tameru-error' }, page.error)
      : h(Fragment, null,
          h('pre', { className: 'tameru-pre' }, page.text),
          h('div', { className: 'tameru-pager' },
            h('button', { type: 'button', disabled: page.offset <= 0, onClick: () => setOffset(Math.max(0, page.offset - 3000)) }, t.previous),
            h('span', { className: 'tameru-muted' }, t.chars(n(page.offset), n(page.end), n(page.total))),
            h('button', { type: 'button', disabled: page.end >= page.total, onClick: () => setOffset(page.end) }, t.next))))
}

function Row({ item, sessionId, act, t }: { item: Json; sessionId: string; act: (op: string, ref: number) => void; t: Copy }) {
  const [open, setOpen] = useState(false)
  const held = item.state !== 'shortened'
  return h('div', { className: 'tameru-row' },
    h('div', { className: 'tameru-row-top' },
      h('span', { className: 'tameru-tool' }, item.tool || t.tool),
      h('span', { className: 'tameru-ref' }, `#${item.ref}`),
      held ? h('span', { className: `tameru-badge${item.state === 'kept' ? ' kept' : ''}` }, item.state === 'kept' ? t.kept : t.restored) : null,
      h('span', { className: 'tameru-size' }, held ? t.fullSize(n(item.originalChars)) : t.sizes(n(item.originalChars), n(item.shownChars)))),
    !item.onSurface ? h('div', { className: 'tameru-muted' }, t.summarisedAway)
      : h('div', { className: 'tameru-actions' },
          h('button', { type: 'button', 'aria-expanded': open, onClick: () => setOpen(!open) }, open ? t.hide : t.view),
          item.state === 'shortened' ? h(Fragment, null,
            h('button', { type: 'button', title: t.keepHelp, onClick: () => act('keep', item.ref) }, t.keep),
            h('button', { type: 'button', title: t.restoreHelp, onClick: () => act('restore', item.ref) }, t.restore)) : null,
          held ? h('button', { type: 'button', title: t.unkeepHelp, onClick: () => act('unkeep', item.ref) }, t.unkeep) : null),
    open && item.onSurface ? h(Viewer, { item, sessionId, t }) : null)
}

function Pins({ state, sessionId, refresh, t }: { state: Json; sessionId: string; refresh: () => void; t: Copy }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const submit = async () => {
    if (!text.trim()) return
    const r = await call('pin', { sessionId, text }).catch(() => ({ ok: false, error: t.unreachable }))
    if (r.ok) { setText(''); setError(''); refresh() } else setError(r.error)
  }
  const remove = async (position: number) => {
    const r = await call('unpin', { sessionId, position }).catch(() => ({ ok: false, error: t.unreachable }))
    if (r.ok) { setError(''); refresh() } else setError(r.error)
  }
  const full = state.pins.length >= state.limits.pins
  return h('section', null,
    h('h3', null, `${t.pinsTitle} (${state.pins.length}/${state.limits.pins})`),
    state.pins.length === 0 ? h('div', { className: 'tameru-muted' }, t.pinsEmpty) : state.pins.map((pin: string, i: number) =>
      h('div', { className: 'tameru-pin', key: `${i}:${pin}` }, h('span', null, pin), h('button', { type: 'button', 'aria-label': t.removePin(i + 1), onClick: () => remove(i + 1) }, '×'))),
    h('div', { className: 'tameru-add' },
      h('input', { type: 'text', value: text, maxLength: state.limits.pinChars, placeholder: full ? t.pinsFull : t.pinPlaceholder, disabled: full, 'aria-label': t.pinPlaceholder, onChange: (e: any) => setText(e.target.value), onKeyDown: (e: any) => { if (e.key === 'Enter') submit() } }),
      h('button', { type: 'button', className: 'primary', disabled: full || !text.trim(), onClick: submit }, t.pin)),
    error ? h('div', { className: 'tameru-error', role: 'alert' }, error) : null,
    h('div', { className: 'tameru-muted', style: { marginTop: 4, fontSize: 11 } }, t.pinsHelp(state.limits.pinChars)))
}

function Settings({ state, refresh, t }: { state: Json; refresh: () => void; t: Copy }) {
  const v = state.settings.values
  const d = state.settings.defaults
  const [error, setError] = useState('')
  const [local, setLocal] = useState<Json>({})
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const patch = useCallback((change: Json) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      const r = await call('settings', { patch: change }).catch(() => ({ ok: false, error: t.unreachable }))
      setError(r.ok ? '' : r.error)
      refresh()
    }, 250)
  }, [refresh])
  const shown = (key: string): number => Math.round((local[key] ?? v[key]) * 100)
  const slide = (key: string, label: string, help: string, min: number, max: number) =>
    h('div', { className: 'tameru-field' },
      h('label', { htmlFor: `tameru-${key}` }, label), h('strong', null, `${shown(key)}%`),
      h('input', { id: `tameru-${key}`, type: 'range', min, max, value: shown(key), onChange: (e: any) => { const value = Number(e.target.value) / 100; setLocal({ ...local, [key]: value }); patch({ [key]: value }) } }),
      h('small', null, help))
  return h('details', null,
    h('summary', null, t.settings),
    h('div', { className: 'tameru-field' },
      h('label', { htmlFor: 'tameru-shorten' }, t.shortening),
      h('input', { id: 'tameru-shorten', type: 'checkbox', checked: v.shorten !== false, onChange: (e: any) => patch({ shorten: e.target.checked }) }),
      h('small', null, t.shorteningHelp)),
    slide('activation', t.startAt, t.startAtHelp, 30, 95),
    slide('minConfidence', t.confidence, t.confidenceHelp, 0, 100),
    h('div', { style: { marginTop: 10 } },
      h('button', { type: 'button', onClick: () => { setLocal({}); patch({ activation: null, minConfidence: null, shorten: null }) }, disabled: v.activation === d.activation && v.minConfidence === d.minConfidence && v.shorten !== false }, t.reset)),
    error ? h('div', { className: 'tameru-error', role: 'alert' }, error) : null)
}

function Panel(props: Json) {
  const t = copy()
  const info = props.useTabInfo?.()
  const visible = info?.tab?.visible !== false
  const sessionId: string = props.sessionId
  const [state, setState] = useState<Json | null>(null)
  const [failed, setFailed] = useState(false)
  const [notice, setNotice] = useState('')
  const alive = useRef(true)
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await call('state', { sessionId }, signal)
      if (alive.current) { setState(next); setFailed(false) }
    } catch (error: any) {
      if (error?.name !== 'AbortError' && alive.current) setFailed(true)
    }
  }, [sessionId])
  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    if (visible) void load(controller.signal)
    const timer = visible ? setInterval(() => void load(controller.signal), POLL_MS) : undefined
    return () => { alive.current = false; controller.abort(); if (timer) clearInterval(timer) }
  }, [load, visible])
  const act = async (op: string, ref: number) => {
    const r = await call('hold', { sessionId, op, ref }).catch(() => ({ ok: false, error: t.unreachable }))
    setNotice(r.ok ? r.text : r.error)
    void load()
  }
  if (!state) return h('div', { className: 'tameru' }, h('div', { className: 'tameru-muted' }, failed ? t.unreachable : t.loading))
  if (state.live === false) return h('div', { className: 'tameru' }, h('div', { className: 'tameru-note' }, t.notOpen))
  const engine = state.engine ?? {}
  const engineOn = engine.state === 'running' || (engine.state === 'idle' && state.python)
  return h('div', { className: 'tameru' },
    h('div', { className: 'tameru-head' },
      h('span', { className: 'tameru-title' }, 'Tameru'),
      h('span', { className: 'tameru-chip', title: engine.lastError ?? '' },
        h('span', { className: `tameru-dot${!state.python ? ' off' : engine.state === 'disabled' ? ' bad' : ''}` }),
        t.engine(!state.python ? 'none' : engine.state === 'disabled' ? 'stopped' : engineOn ? 'on' : 'off', engine.version?.engineVersion))),
    h('section', null, h('h3', null, t.context), h(Gauge, { state, t }), state.chat.lastSkip && state.chat.shortened === 0 ? h('div', { className: 'tameru-muted', style: { marginTop: 4 } }, t.skipReason(state.chat.lastSkip)) : null),
    h('section', null,
      h('h3', null, `${t.cleanups} (${state.items.length})`),
      state.working || state.chat.pending > 0 ? h('div', { className: 'tameru-note', style: { marginBottom: 6 } }, state.chat.pending > 0 ? t.pending(state.chat.pending) : t.working) : null,
      notice ? h('div', { className: 'tameru-note', role: 'status', style: { marginBottom: 6 } }, notice) : null,
      state.items.length === 0 ? h('div', { className: 'tameru-muted' }, state.gauge ? t.emptyWithStart(n(state.gauge.startsAt)) : t.empty)
        : h('div', { className: 'tameru-list' }, [...state.items].reverse().map((item: Json) => h(Row, { key: item.ref, item, sessionId, act, t })))),
    h(Pins, { state, sessionId, refresh: () => void load(), t }),
    h(Settings, { state, refresh: () => void load(), t }),
    h('div', { className: 'tameru-foot' }, t.footer(state.version)))
}

export function apply(ctx: any) {
  ctx.effect(() => installStyle(), 'tameru: styles')
  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: 'tameru',
        title: () => 'Tameru',
        guide: [{ id: 'tameru', title: () => 'Tameru', description: () => copy().guideDescription }],
      }),
    'tameru: tab type',
  )
  ctx.effect(() => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, Panel), 'tameru: tab body')
}
