// Tameru's bar, docked above the message box (the Harness's `conversation.input.dock`): one solid pill, built the way the Harness's own goal
// bar is, with the mode, pause and pins in it. Its details open as a floating card above it, so the chat and the message box never move.
// React and the Harness's shared UI parts come from the Harness's module table (see ui.ts); every class is `tameru-*`.
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useRef, useState } from 'react'
import { MODES, gaugeOf, liveItems, modeOf, readSeen, readTab, rowFlags, sizeOf, statusOf, writeSeen, writeTab, type Json, type TabId } from './model.ts'
import { copy, type Copy } from './text.ts'
import { Dot, Fragment, Icon, Tip, h, useAnchor, useDismiss } from './ui.ts'

export const inject = ['slots']

const ROUTE = 'api/tameru'
const DOCK_ID = 'dsh-tameru'
const POLL_OPEN_MS = 2000
const POLL_CLOSED_MS = 5000
const CARD_WIDTH = 380

const STYLE = `
.tameru, .tameru-card { --t-fg1: var(--dsw-alias-label-primary, currentColor); --t-fg2: var(--dsw-alias-label-secondary, currentColor); --t-fg3: var(--dsw-alias-label-tertiary, color-mix(in srgb, currentColor 60%, transparent));
  --t-line: var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent)); --t-hover: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 9%, transparent));
  --t-accent: var(--dsw-static-blue-450, #4d6bfe); --t-warn: color-mix(in srgb, #d9822b 55%, var(--t-fg1)); --t-track: color-mix(in srgb, currentColor 30%, transparent);
  font-size: 13px; line-height: 20px; color: var(--t-fg2); box-sizing: border-box; }
.tameru *, .tameru *::before, .tameru *::after, .tameru-card *, .tameru-card *::before, .tameru-card *::after { box-sizing: border-box; }
.tameru { width: calc(100% - 2 * var(--dsh-composer-side-clearance, 16px) - 4 * var(--dsh-composer-dock-inset, 8px)); margin: 0 auto; container-type: inline-size; }
.tameru button, .tameru-card button { font: inherit; color: inherit; background: transparent; border: 0; cursor: pointer; padding: 0; }
.tameru button:focus-visible, .tameru-card button:focus-visible, .tameru select:focus-visible, .tameru-card input:focus-visible { outline: 2px solid var(--t-accent); outline-offset: 1px; }
.tameru-bar { isolation: isolate; position: relative; width: 100%; max-width: calc(var(--dsh-composer-card-max-width, 952px) - 4 * var(--dsh-composer-dock-inset, 8px)); margin: 0 auto; height: 32px; display: flex; align-items: center; gap: 8px; padding: 2px 4px 2px 12px;
  border-radius: var(--dsw-radius-md, 10px); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-panel); }
.tameru-bar::before { content: ""; position: absolute; inset: 0; z-index: -1; border-radius: inherit; background: var(--dsw-specific-menu, Canvas); backdrop-filter: var(--dsw-menu-backdrop-filter); pointer-events: none; }
.tameru-name { flex: none; font-weight: 600; color: var(--t-fg1); white-space: nowrap; cursor: default; }
.tameru-name small { font-weight: 400; font-size: 11px; color: var(--t-fg3); margin-left: 3px; }
.tameru-dotwrap, .tameru-dot { flex: none; display: inline-flex; }
.tameru-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--t-fg3); }
.tameru-dot.ok { background: #3fb950; } .tameru-dot.warn { background: #d9822b; } .tameru-dot.idle { background: var(--t-accent); }
.tameru-mode { flex: none; position: relative; display: inline-flex; align-items: center; }
.tameru-mode select { appearance: none; color-scheme: light dark; background: transparent; border: 0; font: inherit; font-size: 12px; color: var(--t-fg1); height: 24px; padding: 0 18px 0 6px; border-radius: 6px; cursor: pointer; max-width: 120px; text-overflow: ellipsis; }
.tameru-mode select:hover { background: var(--t-hover); }
.tameru-mode::after { content: ""; position: absolute; right: 7px; top: 50%; margin-top: -2px; border: 3.5px solid transparent; border-top-color: var(--t-fg3); pointer-events: none; }
.tameru-phrase { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--t-fg3); }
.tameru-gauge { flex: none; display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; cursor: default; }
.tameru-meter { position: relative; width: 44px; height: 6px; border-radius: 3px; background: var(--t-track); }
.tameru-meter-fill { position: absolute; inset: 0 auto 0 0; border-radius: 3px; background: var(--t-fg2); }
.tameru-meter-tick { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--t-fg1); } .tameru-meter-tick.soft { top: -1px; bottom: -1px; opacity: .55; }
.tameru-ib { flex: none; position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 3px; min-width: 28px; height: 28px; padding: 0 6px; border-radius: 999px; color: var(--t-fg3); font-size: 12px; font-variant-numeric: tabular-nums; }
.tameru-ib:hover:not(:disabled) { background: var(--t-hover); color: var(--t-fg1); } .tameru-ib:disabled { opacity: .45; cursor: default; } .tameru-ib[aria-pressed="true"], .tameru-ib[aria-expanded="true"] { color: var(--t-fg1); }
.tameru-ib.on { color: var(--t-accent); }
@media (prefers-reduced-motion: no-preference) { .tameru-ib svg { transition: transform .15s ease; } .tameru-meter-fill { transition: width .4s ease; } }
@container (max-width: 560px) { .tameru-meter { display: none; } }
@container (max-width: 440px) { .tameru-name small, .tameru-pct { display: none; } .tameru-mode select { max-width: 76px; } }
.tameru-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.tameru-card { position: fixed; z-index: 1100; display: flex; flex-direction: column; overflow: hidden; border-radius: var(--dsw-radius-lg, 12px); background: var(--dsw-specific-menu, Canvas); backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-prominent); cursor: default; }
.tameru-head { flex: none; display: flex; align-items: center; gap: 2px; padding: 4px 4px 4px 6px; border-bottom: 1px solid var(--t-line); }
.tameru-tab { flex: none; display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 10px; border-radius: 999px; color: var(--t-fg3); font-variant-numeric: tabular-nums; }
.tameru-tab:hover { background: var(--t-hover); } .tameru-tab[aria-selected="true"] { background: var(--t-hover); color: var(--t-fg1); }
.tameru-grow { flex: 1; }
.tameru-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 4px 6px 8px; }
.tameru-note { display: flex; align-items: flex-start; gap: 6px; margin: 4px 4px 6px; color: var(--t-fg3); overflow-wrap: anywhere; }
.tameru-note.warn { color: var(--t-warn); } .tameru-note svg { flex: none; margin-top: 3px; }
.tameru-clamp { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; overflow-wrap: anywhere; }
.tameru-row { display: flex; align-items: center; gap: 2px; border-radius: 8px; } .tameru-row:hover { background: var(--t-hover); }
.tameru-rowmain { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 6px; border-radius: 8px; text-align: left; }
.tameru-rowmain:disabled { cursor: default; opacity: .6; }
.tameru-fresh { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--t-accent); }
.tameru-tool { flex: none; color: var(--t-fg1); font-weight: 500; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tameru-ref { flex: none; color: var(--t-fg3); font-variant-numeric: tabular-nums; }
.tameru-flags { flex: none; display: inline-flex; gap: 4px; color: var(--t-fg3); }
.tameru-size { margin-left: auto; flex: none; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tameru-viewhead { display: flex; align-items: center; gap: 4px; margin: 2px 0 6px; }
.tameru-viewtitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--t-fg1); font-weight: 500; }
.tameru-seg { flex: none; display: inline-flex; border-radius: 8px; background: var(--t-hover); padding: 2px; }
.tameru-seg button { height: 22px; padding: 0 9px; border-radius: 6px; font-size: 12px; color: var(--t-fg3); } .tameru-seg button[aria-pressed="true"] { background: var(--dsw-specific-menu, Canvas); color: var(--t-fg1); box-shadow: 0 0 0 1px var(--t-line); }
.tameru-pre { margin: 0; max-height: min(220px, 32vh); overflow: auto; padding: 8px; border-radius: 8px; background: var(--t-hover); color: var(--t-fg1); font: 11.5px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; max-width: 100%; }
.tameru-pager { display: flex; align-items: center; gap: 4px; margin-top: 4px; font-size: 12px; color: var(--t-fg3); font-variant-numeric: tabular-nums; } .tameru-pager .tameru-grow { text-align: center; }
.tameru-link { margin-top: 6px; padding: 2px 6px !important; min-height: 24px; border-radius: 6px; color: var(--t-fg2); text-decoration: underline; text-underline-offset: 2px; } .tameru-link:hover { color: var(--t-fg1); }
.tameru-pin { display: flex; align-items: flex-start; gap: 2px; padding: 2px 0 2px 8px; border-radius: 8px; } .tameru-pin:hover { background: var(--t-hover); }
.tameru-pin span { flex: 1; min-width: 0; padding: 3px 0; color: var(--t-fg1); overflow-wrap: anywhere; }
.tameru-add { display: flex; gap: 4px; margin-top: 6px; align-items: center; }
.tameru-add input { flex: 1; min-width: 0; font: inherit; color: var(--t-fg1); background: var(--t-hover); border: 0; border-radius: 999px; height: 28px; padding: 0 12px; } .tameru-add input::placeholder { color: var(--t-fg3); }
.tameru-error { color: var(--t-warn); margin: 6px 4px 0; overflow-wrap: anywhere; }
.tameru-help { margin: 8px 4px 0; font-size: 12px; color: var(--t-fg3); }
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

function IconButton(props: { icon: any; label: string; tip?: string; id?: string; pressed?: boolean; expanded?: boolean; disabled?: boolean; on?: boolean; count?: number; onClick: () => void }) {
  const { icon, label, tip, id, pressed, expanded, disabled, on, count, onClick } = props
  return h(Tip, { label: tip ?? label },
    h('button', { type: 'button', id, className: `tameru-ib${on ? ' on' : ''}`, 'aria-label': label, 'aria-pressed': pressed, 'aria-expanded': expanded, disabled, onClick },
      h(Icon, { name: icon }), count !== undefined && count > 0 ? String(count) : null))
}

function Viewer({ item, sessionId, act, onBack, t }: { item: Json; sessionId: string; act: (op: string, ref: number) => void; onBack: () => void; t: Copy }) {
  const [which, setWhich] = useState<'shown' | 'original'>('original')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<Json | null>(null)
  useEffect(() => {
    let live = true
    setPage(null)
    call('view', { sessionId, ref: item.ref, which, offset }).then(r => live && setPage(r), () => live && setPage({ ok: false, error: t.unreachable }))
    return () => { live = false }
  }, [sessionId, item.ref, which, offset, item.state])
  useEffect(() => { document.getElementById('tameru-back')?.focus() }, [])
  const switchTo = (next: 'shown' | 'original') => { setWhich(next); setOffset(0) }
  return h(Fragment, null,
    h('div', { className: 'tameru-viewhead' },
      h(IconButton, { icon: 'left', label: t.back, id: 'tameru-back', onClick: onBack }),
      h('span', { className: 'tameru-viewtitle' }, `${item.tool || t.tool} #${item.ref}`),
      h('div', { className: 'tameru-seg', role: 'group', 'aria-label': t.view },
        h('button', { type: 'button', 'aria-pressed': which === 'original', onClick: () => switchTo('original') }, t.original),
        h('button', { type: 'button', 'aria-pressed': which === 'shown', onClick: () => switchTo('shown') }, t.shortened))),
    page === null ? h('div', { className: 'tameru-note' }, t.loading)
      : !page.ok ? h('div', { className: 'tameru-error' }, page.error)
      : h(Fragment, null,
          h('pre', { className: 'tameru-pre', tabIndex: 0 }, page.text),
          h('div', { className: 'tameru-pager' },
            h(IconButton, { icon: 'left', label: t.previous, disabled: page.offset <= 0, onClick: () => setOffset(Math.max(0, page.offset - 3000)) }),
            h('span', { className: 'tameru-grow' }, t.chars(n(page.offset), n(page.end), n(page.total))),
            h(IconButton, { icon: 'right', label: t.next, disabled: page.end >= page.total, onClick: () => setOffset(page.end) }))),
    item.state === 'shortened' && !item.queued ? h('button', { type: 'button', className: 'tameru-link', onClick: () => act('restore', item.ref) }, t.restore) : null)
}

function Row({ item, fresh, open, act, t }: { item: Json; fresh: boolean; open: () => void; act: (op: string, ref: number) => void; t: Copy }) {
  const tool = item.tool || t.tool
  const f = rowFlags(item)
  const flag = (icon: any, label: string) => h(Tip, { label }, h('span', { role: 'img', 'aria-label': label, style: { display: 'inline-flex' } }, h(Icon, { name: icon, size: 13 })))
  return h('div', { className: 'tameru-row' },
    h('button', { type: 'button', className: 'tameru-rowmain', disabled: f.gone, onClick: open },
      fresh ? h(Fragment, null, h('span', { className: 'tameru-fresh', 'aria-hidden': true }), h('span', { className: 'tameru-sr' }, t.fresh)) : null,
      h('span', { className: 'tameru-tool' }, tool),
      h('span', { className: 'tameru-ref' }, `#${item.ref}`),
      h('span', { className: 'tameru-flags' },
        f.gone ? flag('archive', t.rowGone) : null, f.queued ? flag('clock', t.rowWaiting) : null, f.cut ? flag('info', t.rowCut) : null, f.restored ? flag('refresh', t.rowRestored) : null),
      h('span', { className: 'tameru-size' }, sizeOf(item, t.inFull))),
    f.gone ? null : h(IconButton, { icon: f.kept ? 'eye' : 'eyeOff', on: f.kept, pressed: f.kept, label: f.kept ? t.shortenAgain(tool, item.ref) : t.showFull(tool, item.ref), onClick: () => act(f.kept ? 'unkeep' : 'keep', item.ref) }))
}

function Results({ state, seen, onOpen, act, notice, t }: { state: Json; seen: number; onOpen: (ref: number) => void; act: (op: string, ref: number) => void; notice: string; t: Copy }) {
  const items: Json[] = state.items
  const rows = [...items].reverse().sort((a, b) => Number(b.onSurface) - Number(a.onSurface))
  return h(Fragment, null,
    state.working || state.chat.pending > 0 ? h('div', { className: 'tameru-note' }, h(Icon, { name: 'clock', size: 13 }), t.working) : null,
    notice ? h('div', { className: 'tameru-note', role: 'status' }, notice) : null,
    rows.length === 0
      ? h('div', { className: 'tameru-note' }, state.gauge ? t.emptyStarts(Math.round((state.gauge.startsAt / state.gauge.contextWindow) * 100)) : t.gaugeReason(state.gaugeUnavailable),
          state.chat.lastSkip ? ` ${t.skipReason(state.chat.lastSkip)}` : '')
      : rows.map(item => h(Row, { key: item.ref, item, fresh: item.ref > seen && item.onSurface, open: () => onOpen(item.ref), act, t })))
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
    state.pins.length === 0 ? h('div', { className: 'tameru-note' }, t.pinsEmpty) : state.pins.map((pin: string, i: number) =>
      h('div', { className: 'tameru-pin', key: `${i}:${pin}` }, h('span', null, pin), h(IconButton, { icon: 'trash', label: t.removePin(i + 1), onClick: () => void remove(i + 1) }))),
    h('div', { className: 'tameru-add' },
      h('input', { id: 'tameru-pin-input', type: 'text', value: text, maxLength: state.limits.pinChars, placeholder: full ? t.pinsFull : t.pinPlaceholder, disabled: full, 'aria-label': t.pinPlaceholder, onChange: (e: any) => setText(e.target.value), onKeyDown: (e: any) => { if (e.key === 'Enter') void submit() } }),
      h(IconButton, { icon: 'plus', label: t.pinAdd, disabled: full || !text.trim(), onClick: () => void submit() })),
    error ? h('div', { className: 'tameru-error', role: 'alert' }, error) : null,
    h('div', { className: 'tameru-help' }, t.pinsHelp(state.limits.pinChars)))
}

function Bar(props: Json) {
  const t = copy()
  const sessionId: string | undefined = props.sessionId
  const useProjection: ((name: string) => any) | undefined = props.useProjection
  const pressure = useProjection?.('contextPressure')
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<TabId>(readTab)
  const [viewing, setViewing] = useState<number | null>(null)
  const [stored, setState] = useState<Json | null>(null)
  const state = stored && stored.sessionKey === sessionId ? stored : null
  const [failed, setFailed] = useState(false)
  const [notice, setNotice] = useState('')
  const [seen, setSeen] = useState(-1)
  const [chosen, setChosen] = useState<Json>({})
  const current = useRef<string | undefined>(sessionId)
  const newest = useRef(-1)
  const loading = useRef<string | undefined>(undefined)
  const barRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  current.current = sessionId

  // a different chat is a different state: nothing of the last one is shown for it
  useEffect(() => {
    setState(null); setFailed(false); setNotice(''); setViewing(null); setOpen(false); setChosen({})
    setSeen(sessionId ? readSeen(sessionId) : -1)
    newest.current = -1
  }, [sessionId])

  const load = useCallback(async (signal?: AbortSignal) => {
    const asked = current.current
    if (!asked || loading.current === asked) return
    loading.current = asked
    try {
      const next = await call('state', { sessionId: asked }, signal)
      // the answer is kept with the chat it is for, so a chat switch can never show another chat's numbers
      if (current.current === asked) { setState({ ...next, sessionKey: asked }); setFailed(false) }
    } catch (error: any) {
      if (error?.name !== 'AbortError' && current.current === asked) setFailed(true)
    } finally {
      if (loading.current === asked) loading.current = undefined
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    const timer = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) void load(controller.signal) }, open ? POLL_OPEN_MS : POLL_CLOSED_MS)
    const onVisible = () => { if (!document.hidden) void load(controller.signal) }
    document.addEventListener?.('visibilitychange', onVisible)
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener?.('visibilitychange', onVisible); loading.current = undefined }
  }, [load, open, sessionId])

  const items: Json[] = state?.live ? liveItems(state) : []
  newest.current = items.reduce((max, item) => Math.max(max, item.ref), -1)
  // looking at the results marks them seen when the card is left
  useEffect(() => {
    if (!open || tab !== 'results' || !sessionId) return
    return () => { if (newest.current >= 0) { writeSeen(sessionId, newest.current); setSeen(newest.current) } }
  }, [open, tab, sessionId])

  const close = useCallback(() => { setOpen(false); setViewing(null) }, [])
  useDismiss(open, [cardRef, barRef], close)
  const anchored = useAnchor(open, barRef, CARD_WIDTH)
  // opening moves focus into the card; closing from the keyboard gives it back
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open) document.getElementById(`tameru-tab-${tab}`)?.focus()
    else if (wasOpen.current && cardRef.current === null && document.activeElement === document.body) document.getElementById('tameru-chevron')?.focus()
    wasOpen.current = open
  }, [open])

  const toggle = (nextTab?: TabId) => {
    if (nextTab) { setTab(nextTab); writeTab(nextTab); setViewing(null); setOpen(true); return }
    setOpen(value => !value); setViewing(null)
  }
  const act = async (op: string, ref: number) => {
    if (!sessionId) return
    const r = await call('hold', { sessionId, op, ref }).catch(() => ({ ok: false, error: t.unreachable }))
    setNotice(r.ok ? '' : r.error)
    void load()
  }
  const send = async (patch: Json) => {
    const r = await call('settings', { patch }).catch(() => ({ ok: false, error: t.unreachable }))
    setNotice(r.ok ? '' : r.error)
    await load()
    setChosen({})
  }

  const live = state?.live === true
  const status = statusOf(state, failed, seen)
  const phrase = t.status(status)
  const gauge = gaugeOf(pressure, state)
  const pinCount = live ? state!.pins.length : 0
  const resultCount = items.length
  const paused = live && (chosen.shorten ?? state!.settings.values.shorten) === false
  const mode = live ? (chosen.mode ?? modeOf(state!.settings.values.minConfidence)) : 'balanced'
  const tabs: TabId[] = ['results', 'pins']
  const viewed = viewing === null ? undefined : items.find(item => item.ref === viewing)

  const body = !state ? h('div', { className: 'tameru-note' }, failed ? t.unreachable : t.loading)
    : !live ? h('div', { className: 'tameru-note' }, t.status({ tone: 'off', key: 'notOpen' }))
    : h(Fragment, null,
        status.tone === 'warn' ? h('div', { className: 'tameru-note warn', role: 'status' }, h(Icon, { name: 'warn', size: 13 }), h('span', { className: 'tameru-clamp', title: phrase }, phrase)) : null,
        tab === 'pins' ? h(Pins, { state, sessionId: sessionId!, refresh: () => void load(), t })
          : viewed ? h(Viewer, { item: viewed, sessionId: sessionId!, act, onBack: () => { setViewing(null); setTimeout(() => document.getElementById('tameru-tab-results')?.focus(), 0) }, t })
          : h(Results, { state, seen, onOpen: setViewing, act, notice, t }))

  const card = open && anchored ? createPortal(
    h('div', { ref: cardRef, className: 'tameru-card', role: 'dialog', 'aria-label': t.card, style: { left: anchored.left, bottom: anchored.bottom, width: anchored.width, maxHeight: Math.min(anchored.maxHeight, 420) } },
      h('div', { className: 'tameru-head', role: 'tablist', 'aria-label': t.tabsLabel },
        tabs.map(id => h(Tip, { key: id, label: t.tabs[id] },
          h('button', { type: 'button', id: `tameru-tab-${id}`, role: 'tab', className: 'tameru-tab', 'aria-selected': tab === id, 'aria-label': `${t.tabs[id]}${(id === 'pins' ? pinCount : resultCount) > 0 ? `, ${id === 'pins' ? pinCount : resultCount}` : ''}`, tabIndex: tab === id ? 0 : -1,
            onKeyDown: (e: any) => {
              const next = e.key === 'ArrowRight' || e.key === 'ArrowLeft' ? tabs[(tabs.indexOf(id) + 1) % tabs.length] : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1] : undefined
              if (next) { e.preventDefault(); toggle(next); document.getElementById(`tameru-tab-${next}`)?.focus() }
            },
            onClick: () => toggle(id) },
            h(Icon, { name: id === 'pins' ? 'pin' : 'list' }), (id === 'pins' ? pinCount : resultCount) > 0 ? String(id === 'pins' ? pinCount : resultCount) : null))),
        h('span', { className: 'tameru-grow' }),
        h(IconButton, { icon: 'close', label: t.close, onClick: close })),
      h('div', { className: 'tameru-body', role: 'tabpanel', id: 'tameru-tabpanel' }, body)),
    document.body) : null

  return h('div', { className: 'tameru', role: 'region', 'aria-label': t.name },
    h('div', { className: 'tameru-bar', ref: barRef },
      h(Dot, { tone: status.tone }),
      h(Tip, { label: t.nameTip(state?.version ?? '') }, h('span', { className: 'tameru-name' }, t.name, h('small', null, t.kana))),
      live ? h(Tip, { label: t.modes[mode as keyof typeof t.modes].tip },
        h('label', { className: 'tameru-mode' }, h('span', { className: 'tameru-sr' }, t.mode),
          h('select', { value: mode, onChange: (e: any) => { const next = MODES.find(m => m.id === e.target.value); if (next) { setChosen({ ...chosen, mode: next.id }); void send({ minConfidence: next.minConfidence }) } } },
            MODES.map(m => h('option', { key: m.id, value: m.id }, t.modes[m.id].name)),
            mode === 'custom' ? h('option', { value: 'custom', disabled: true }, t.modes.custom.name) : null))) : null,
      h('span', { className: 'tameru-phrase', title: phrase }, phrase),
      gauge ? h(Tip, { label: t.gaugeTitle(gauge.percent, gauge.starts, gauge.compacts) },
        h('span', { className: 'tameru-gauge' },
          h('span', { className: 'tameru-meter', 'aria-hidden': true },
            h('span', { className: 'tameru-meter-fill', style: { width: `${gauge.percent}%` } }),
            gauge.starts !== undefined ? h('span', { className: 'tameru-meter-tick soft', style: { left: `${gauge.starts * 100}%` } }) : null,
            gauge.compacts !== undefined ? h('span', { className: 'tameru-meter-tick', style: { left: `${gauge.compacts * 100}%` } }) : null),
          h('span', { className: 'tameru-pct' }, `${gauge.percent}%`))) : null,
      live ? h(IconButton, { icon: paused ? 'play' : 'pause', label: paused ? t.resume : t.pause, tip: paused ? t.resumeTip : t.pauseTip, pressed: paused, onClick: () => { setChosen({ ...chosen, shorten: paused }); void send({ shorten: paused }) } }) : null,
      live ? h(IconButton, { icon: pinCount > 0 ? 'pinFill' : 'pin', label: t.pinsTip(pinCount), count: pinCount, onClick: () => toggle('pins') }) : null,
      h(IconButton, { icon: open ? 'down' : 'up', label: open ? t.hide : t.show, id: 'tameru-chevron', expanded: open, onClick: () => toggle() })),
    h('span', { className: 'tameru-sr', role: 'status', 'aria-live': 'polite' }, phrase),
    card)
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
