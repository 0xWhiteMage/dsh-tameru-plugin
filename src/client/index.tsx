// Tameru's one compact bar, docked above the message box (the Harness's `conversation.input.dock`). Closed it is a single ~30 px line:
// a state mark, the name, a context gauge and one phrase. Open, it grows a fixed-height panel with Results, Pins and Settings.
// Plain React from the Harness's shared module table; every class is `tameru-*`; colours come from the host's theme tokens with
// fallbacks, so light, dark and custom themes follow the app.
import { createElement as h, Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { PRESETS, compact, gaugeOf, liveItems, presetOf, readOpen, readSeen, sizeOf, statusOf, writeOpen, writeSeen, type Json, type PresetId } from './model.ts'
import { copy, type Copy } from './text.ts'

export const inject = ['slots']

const ROUTE = 'api/tameru'
const DOCK_ID = 'dsh-tameru'
const POLL_OPEN_MS = 2000
const POLL_CLOSED_MS = 5000

const STYLE = `
.tameru { --t-fg: var(--dsw-alias-label-secondary, currentColor); --t-fg2: var(--dsw-alias-label-tertiary, color-mix(in srgb, currentColor 60%, transparent)); --t-fg1: var(--dsw-alias-label-primary, currentColor);
  --t-line: var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent)); --t-hover: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 9%, transparent));
  --t-accent: var(--dsw-static-blue-450, #4d6bfe); --t-ok: #3fb950; --t-warn: #d9822b;
  font-size: 12px; line-height: 18px; color: var(--t-fg); box-sizing: border-box; }
.tameru *, .tameru *::before, .tameru *::after { box-sizing: border-box; }
.tameru button { font: inherit; color: inherit; background: transparent; border: 0; cursor: pointer; border-radius: 6px; }
.tameru button:hover:not(:disabled) { background: var(--t-hover); }
.tameru button:disabled { opacity: .45; cursor: default; }
.tameru button:focus-visible, .tameru input:focus-visible { outline: 2px solid var(--t-accent); outline-offset: 1px; }
.tameru-bar { display: flex; align-items: center; gap: 2px; height: 30px; }
.tameru-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 8px; text-align: left; }
.tameru-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--t-fg2); }
.tameru-dot.ok { background: var(--t-ok); } .tameru-dot.warn { background: var(--t-warn); } .tameru-dot.idle { background: var(--t-accent); }
.tameru-name { flex: none; font-weight: 600; color: var(--t-fg1); }
.tameru-meter { flex: none; position: relative; width: 56px; height: 6px; border-radius: 3px; background: var(--t-hover); }
.tameru-meter-fill { position: absolute; inset: 0 auto 0 0; border-radius: 3px; background: var(--t-fg2); }
.tameru-meter-tick { position: absolute; top: -2px; bottom: -2px; width: 1.5px; background: var(--t-fg2); }
.tameru-percent { flex: none; font-variant-numeric: tabular-nums; min-width: 3ch; }
.tameru-phrase { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--t-fg2); }
.tameru-chev { flex: none; width: 12px; height: 12px; opacity: .7; }
.tameru-pinbtn { flex: none; display: inline-flex; align-items: center; gap: 4px; height: 28px; min-width: 28px; padding: 0 7px; font-variant-numeric: tabular-nums; }
.tameru-panel { height: 280px; margin-top: 2px; border: 1px solid var(--t-line); border-radius: 10px; display: flex; flex-direction: column; overflow: hidden; }
.tameru-tabs { flex: none; display: flex; gap: 2px; padding: 4px 6px 0; border-bottom: 1px solid var(--t-line); }
.tameru-tab { padding: 3px 10px; border-radius: 6px 6px 0 0 !important; border-bottom: 2px solid transparent !important; min-height: 26px; }
.tameru-tab[aria-selected="true"] { color: var(--t-fg1); border-bottom-color: var(--t-accent) !important; }
.tameru-body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 10px; }
.tameru-foot { flex: none; padding: 4px 10px; border-top: 1px solid var(--t-line); color: var(--t-fg2); font-size: 11px; }
.tameru-note { color: var(--t-fg2); margin: 0 0 6px; }
.tameru-list { display: flex; flex-direction: column; }
.tameru-row { border-bottom: 1px solid var(--t-line); }
.tameru-row-line { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.tameru-row-toggle { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 4px; text-align: left; }
.tameru-tool { color: var(--t-fg1); font-weight: 500; } .tameru-ref { color: var(--t-fg2); font-variant-numeric: tabular-nums; }
.tameru-size { margin-left: auto; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tameru-fresh { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--t-accent); }
.tameru-tag { color: var(--t-fg2); font-size: 11px; }
.tameru-switch { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 24px; min-width: 24px; padding: 0 6px; }
.tameru-switch-track { width: 24px; height: 14px; border-radius: 7px; background: var(--t-line); position: relative; flex: none; }
.tameru-switch-track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 10px; height: 10px; border-radius: 50%; background: var(--t-fg1); }
.tameru-switch[aria-checked="true"] .tameru-switch-track { background: var(--t-accent); }
.tameru-switch[aria-checked="true"] .tameru-switch-track::after { left: 12px; background: #fff; }
.tameru-view { padding: 4px 4px 8px; }
.tameru-seg { display: inline-flex; border: 1px solid var(--t-line); border-radius: 6px; overflow: hidden; }
.tameru-seg button { border-radius: 0; padding: 2px 9px; min-height: 24px; } .tameru-seg button[aria-pressed="true"] { background: var(--t-hover); color: var(--t-fg1); }
.tameru-pre { margin: 6px 0 0; max-height: 110px; overflow: auto; padding: 6px 8px; border-radius: 6px; background: var(--t-hover); font: 11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; word-break: break-word; color: var(--t-fg1); }
.tameru-pager { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 11px; }
.tameru-link { text-decoration: underline; padding: 2px 4px; min-height: 24px; }
.tameru-pin { display: flex; gap: 8px; align-items: flex-start; padding: 4px 0; border-bottom: 1px solid var(--t-line); }
.tameru-pin span { flex: 1; word-break: break-word; color: var(--t-fg1); }
.tameru-add { display: flex; gap: 6px; margin-top: 8px; }
.tameru-add input { flex: 1; min-width: 0; font: inherit; color: inherit; background: transparent; border: 1px solid var(--t-line); border-radius: 6px; padding: 3px 8px; min-height: 26px; }
.tameru-add button { border: 1px solid var(--t-line); padding: 2px 10px; min-height: 26px; }
.tameru-error { color: var(--t-warn); margin-top: 6px; }
.tameru-radio { display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left; padding: 5px 8px; border: 1px solid transparent; }
.tameru-radio[aria-checked="true"] { border-color: var(--t-accent); }
.tameru-radio strong { color: var(--t-fg1); font-weight: 600; }
.tameru-field { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.tameru-h { margin: 8px 0 4px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--t-fg2); }
.tameru-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (prefers-reduced-motion: no-preference) { .tameru-chev { transition: transform .15s ease; } .tameru-meter-fill { transition: width .4s ease; } }
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

function Chevron({ open }: { open: boolean }) {
  return h('svg', { className: 'tameru-chev', viewBox: '0 0 12 12', 'aria-hidden': true, style: { transform: open ? 'rotate(180deg)' : 'none' } }, h('path', { d: 'M2.5 4.5 6 8l3.5-3.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))
}

function PinIcon() {
  return h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true }, h('path', { d: 'M4 1.5h4M5 1.5v3L3.5 7h5L7 4.5v-3M6 7v3.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }))
}

function Viewer({ item, sessionId, act, t }: { item: Json; sessionId: string; act: (op: string, ref: number) => void; t: Copy }) {
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
    page === null ? h('div', { className: 'tameru-note', style: { marginTop: 6 } }, t.loadingText)
      : !page.ok ? h('div', { className: 'tameru-error' }, page.error)
      : h(Fragment, null,
          h('pre', { className: 'tameru-pre', tabIndex: 0 }, page.text),
          h('div', { className: 'tameru-pager' },
            h('button', { type: 'button', className: 'tameru-link', disabled: page.offset <= 0, onClick: () => setOffset(Math.max(0, page.offset - 3000)) }, t.previous),
            h('span', { className: 'tameru-note', style: { margin: 0 } }, t.chars(n(page.offset), n(page.end), n(page.total))),
            h('button', { type: 'button', className: 'tameru-link', disabled: page.end >= page.total, onClick: () => setOffset(page.end) }, t.next))),
    item.state === 'shortened' && !item.queued ? h('button', { type: 'button', className: 'tameru-link', onClick: () => act('restore', item.ref) }, t.restore) : null)
}

function Row({ item, fresh, sessionId, act, t }: { item: Json; fresh: boolean; sessionId: string; act: (op: string, ref: number) => void; t: Copy }) {
  const [open, setOpen] = useState(false)
  const tool = item.tool || t.tool
  const kept = item.state === 'kept'
  const gone = !item.onSurface
  return h('div', { className: 'tameru-row', style: gone ? { opacity: 0.6 } : undefined },
    h('div', { className: 'tameru-row-line' },
      h('button', { type: 'button', className: 'tameru-row-toggle', 'aria-expanded': open, 'aria-label': t.detailsLabel(tool, item.ref), disabled: gone, onClick: () => setOpen(!open) },
        fresh ? h('span', { className: 'tameru-fresh', title: t.fresh }) : null,
        h('span', { className: 'tameru-tool' }, tool),
        h('span', { className: 'tameru-ref' }, `#${item.ref}`),
        item.queued ? h('span', { className: 'tameru-tag' }, t.waitingRow) : item.state === 'restored' ? h('span', { className: 'tameru-tag' }, t.fullForNow) : null,
        h('span', { className: 'tameru-size' }, sizeOf(item, t.inFull))),
      gone ? null : h('button', { type: 'button', role: 'switch', className: 'tameru-switch', 'aria-checked': kept, 'aria-label': t.keepLabel(tool, item.ref), title: t.keepHelp, onClick: () => act(kept ? 'unkeep' : 'keep', item.ref) },
        h('span', { className: 'tameru-switch-track' }), h('span', null, t.keep))),
    gone ? h('div', { className: 'tameru-note' }, t.summarisedAway) : null,
    item.cutByHarness ? h('div', { className: 'tameru-note' }, t.cutByHarness) : null,
    open && !gone ? h(Viewer, { item, sessionId, act, t }) : null)
}

function Results({ state, seen, sessionId, act, notice, t }: { state: Json; seen: number; sessionId: string; act: (op: string, ref: number) => void; notice: string; t: Copy }) {
  const items: Json[] = state.items
  return h(Fragment, null,
    state.working || state.chat.pending > 0 ? h('div', { className: 'tameru-note' }, t.working) : null,
    notice ? h('div', { className: 'tameru-note', role: 'status' }, notice) : null,
    items.length === 0
      ? h('div', { className: 'tameru-note' }, state.gauge ? t.emptyStarts(Math.round((state.gauge.startsAt / state.gauge.contextWindow) * 100)) : t.gaugeReason(state.gaugeUnavailable),
          state.chat.lastSkip ? ` ${t.skipReason(state.chat.lastSkip)}` : '')
      : h('div', { className: 'tameru-list' }, [...items].reverse().map(item => h(Row, { key: item.ref, item, fresh: item.ref > seen && item.onSurface, sessionId, act, t }))))
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
  return h(Fragment, null,
    h('div', { className: 'tameru-h', style: { marginTop: 0 } }, `${t.pinsTitle} (${state.pins.length}/${state.limits.pins})`),
    state.pins.length === 0 ? h('div', { className: 'tameru-note' }, t.pinsEmpty) : state.pins.map((pin: string, i: number) =>
      h('div', { className: 'tameru-pin', key: `${i}:${pin}` }, h('span', null, pin), h('button', { type: 'button', 'aria-label': t.removePin(i + 1), style: { minWidth: 24, minHeight: 24 }, onClick: () => remove(i + 1) }, '×'))),
    h('div', { className: 'tameru-add' },
      h('input', { type: 'text', value: text, maxLength: state.limits.pinChars, placeholder: full ? t.pinsFull : t.pinPlaceholder, disabled: full, 'aria-label': t.pinPlaceholder, onChange: (e: any) => setText(e.target.value), onKeyDown: (e: any) => { if (e.key === 'Enter') void submit() } }),
      h('button', { type: 'button', disabled: full || !text.trim(), onClick: () => void submit() }, t.pin)),
    error ? h('div', { className: 'tameru-error', role: 'alert' }, error) : null,
    h('div', { className: 'tameru-note', style: { marginTop: 6, fontSize: 11 } }, t.pinsHelp(state.limits.pinChars)))
}

function Settings({ state, refresh, t }: { state: Json; refresh: () => void; t: Copy }) {
  const v = state.settings.values
  const [error, setError] = useState('')
  const [chosen, setChosen] = useState<Json>({})
  const send = async (patch: Json) => {
    const r = await call('settings', { patch }).catch(() => ({ ok: false, error: t.unreachable }))
    setError(r.ok ? '' : r.error)
    setChosen({})
    refresh()
  }
  const current: PresetId | 'custom' = chosen.preset ?? presetOf(v.minConfidence)
  const shorten = chosen.shorten ?? v.shorten !== false
  const dirty = state.settings.saved === true
  return h(Fragment, null,
    h('div', { className: 'tameru-field' },
      h('div', null, h('div', { style: { color: 'var(--t-fg1)' } }, t.shortening), h('div', { className: 'tameru-note', style: { margin: 0 } }, t.shorteningHelp)),
      h('button', { type: 'button', role: 'switch', className: 'tameru-switch', 'aria-checked': shorten, 'aria-label': t.shortening, onClick: () => { setChosen({ ...chosen, shorten: !shorten }); void send({ shorten: !shorten }) } }, h('span', { className: 'tameru-switch-track' }))),
    h('div', { className: 'tameru-h' }, t.carefulness),
    h('div', { role: 'radiogroup', 'aria-label': t.carefulness },
      [...PRESETS.map(p => p.id), ...(current === 'custom' ? ['custom' as const] : [])].map(id => {
        const text = t.presets[id]
        return h('button', { key: id, type: 'button', role: 'radio', className: 'tameru-radio', 'aria-checked': current === id, disabled: id === 'custom',
          onClick: () => { const preset = PRESETS.find(p => p.id === id); if (preset) { setChosen({ ...chosen, preset: id }); void send({ minConfidence: preset.minConfidence }) } } },
          h('strong', null, text.name), h('span', { className: 'tameru-note', style: { margin: 0 } }, text.line))
      })),
    dirty || current === 'custom' ? h('div', { style: { marginTop: 8 } }, h('button', { type: 'button', className: 'tameru-link', onClick: () => void send({ minConfidence: null, activation: null, shorten: null }) }, t.reset)) : null,
    error ? h('div', { className: 'tameru-error', role: 'alert' }, error) : null)
}

type TabId = 'results' | 'pins' | 'settings'

function Bar(props: Json) {
  const t = copy()
  const sessionId: string | undefined = props.sessionId
  const useProjection: ((name: string) => any) | undefined = props.useProjection
  const pressure = useProjection?.('contextPressure')
  const initial = readOpen()
  const [open, setOpen] = useState(initial.open)
  const [tab, setTab] = useState<TabId>(initial.tab)
  const [state, setState] = useState<Json | null>(null)
  const [failed, setFailed] = useState(false)
  const [notice, setNotice] = useState('')
  const [seen, setSeen] = useState(-1)
  const current = useRef<string | undefined>(sessionId)
  const newest = useRef(-1)
  current.current = sessionId

  // a different chat is a different state: nothing of the last one is shown for it
  useEffect(() => {
    setState(null)
    setFailed(false)
    setNotice('')
    setSeen(sessionId ? readSeen(sessionId) : -1)
    newest.current = -1
  }, [sessionId])

  const load = useCallback(async (signal?: AbortSignal) => {
    const asked = current.current
    if (!asked) return
    try {
      const next = await call('state', { sessionId: asked }, signal)
      if (current.current === asked) { setState(next); setFailed(false) }
    } catch (error: any) {
      if (error?.name !== 'AbortError' && current.current === asked) setFailed(true)
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    const timer = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) void load(controller.signal) }, open ? POLL_OPEN_MS : POLL_CLOSED_MS)
    return () => { controller.abort(); clearInterval(timer) }
  }, [load, open, sessionId])

  const items: Json[] = state?.live ? liveItems(state) : []
  newest.current = items.reduce((max, item) => Math.max(max, item.ref), -1)
  // looking at the results marks them seen when the panel is left
  useEffect(() => {
    if (!open || tab !== 'results' || !sessionId) return
    return () => { if (newest.current >= 0) { writeSeen(sessionId, newest.current); setSeen(newest.current) } }
  }, [open, tab, sessionId])

  const choose = (next: boolean, nextTab: TabId = tab) => { setOpen(next); setTab(nextTab); writeOpen(next, nextTab) }
  const act = async (op: string, ref: number) => {
    if (!sessionId) return
    const r = await call('hold', { sessionId, op, ref }).catch(() => ({ ok: false, error: t.unreachable }))
    setNotice(r.ok ? r.text : r.error)
    void load()
  }

  const status = statusOf(state, failed, seen)
  const live = state?.live === true
  const gauge = gaugeOf(pressure, state)
  const phrase = t.status(status)
  const pinCount = live ? state!.pins.length : 0
  const panelId = 'tameru-panel'
  const tabs: TabId[] = ['results', 'pins', 'settings']

  return h('div', { className: 'tameru', role: 'region', 'aria-label': t.name },
    h('div', { className: 'tameru-bar' },
      h('button', { type: 'button', className: 'tameru-main', 'aria-expanded': open, 'aria-controls': panelId, title: open ? t.close : t.open, onClick: () => choose(!open) },
        h('span', { className: `tameru-dot ${status.tone}`, 'aria-hidden': true }),
        h('span', { className: 'tameru-name' }, t.name),
        gauge ? h(Fragment, null,
          h('span', { className: 'tameru-meter', role: 'meter', 'aria-label': t.gauge, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': gauge.percent, title: t.gaugeTitle(gauge.percent, gauge.starts, gauge.compacts) },
            h('span', { className: 'tameru-meter-fill', style: { width: `${gauge.percent}%` } }),
            gauge.starts !== undefined ? h('span', { className: 'tameru-meter-tick', style: { left: `${gauge.starts * 100}%`, opacity: 0.5 } }) : null,
            gauge.compacts !== undefined ? h('span', { className: 'tameru-meter-tick', style: { left: `${gauge.compacts * 100}%` } }) : null),
          h('span', { className: 'tameru-percent' }, `${gauge.percent}%`)) : null,
        h('span', { className: 'tameru-phrase' }, phrase),
        h(Chevron, { open })),
      live ? h('button', { type: 'button', className: 'tameru-pinbtn', 'aria-label': t.pinsButton(pinCount), title: t.pinsButton(pinCount), onClick: () => choose(true, 'pins') }, h(PinIcon, null), pinCount > 0 ? String(pinCount) : null) : null),
    h('span', { className: 'tameru-sr', role: 'status', 'aria-live': 'polite' }, phrase),
    open ? h('div', { className: 'tameru-panel', id: panelId },
      h('div', { className: 'tameru-tabs', role: 'tablist', 'aria-label': t.tabsLabel },
        tabs.map(id => h('button', { key: id, type: 'button', role: 'tab', className: 'tameru-tab', 'aria-selected': tab === id, onClick: () => choose(true, id) }, t.tabs[id]))),
      h('div', { className: 'tameru-body', role: 'tabpanel' },
        !state ? h('div', { className: 'tameru-note' }, failed ? t.unreachable : t.loading)
          : !live ? h('div', { className: 'tameru-note' }, t.status({ tone: 'off', key: 'notOpen' }))
          : tab === 'results' ? h(Results, { state, seen, sessionId: sessionId!, act, notice, t })
          : tab === 'pins' ? h(Pins, { state, sessionId: sessionId!, refresh: () => void load(), t })
          : h(Settings, { state, refresh: () => void load(), t })),
      state?.live ? h('div', { className: 'tameru-foot' }, t.footer(state.version)) : null) : null)
}

export function apply(ctx: any) {
  ctx.effect(() => installStyle(), 'tameru: styles')
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({ name: 'conversation.input.dock', id: DOCK_ID, order: 30, inject: (sessionId: string) => ({ sessionId }) }, Bar)),
    'tameru: dock bar',
  )
}
