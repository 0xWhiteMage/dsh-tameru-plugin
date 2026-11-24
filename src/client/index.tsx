// Tameru's bar, docked above the message box (the Harness's `conversation.input.dock`): one solid line built the way the Harness's own goal
// bar is, with the strength and the two launchers in it. Its details open as a floating card above it, so the chat and the message box never
// move. The rules are docs/PLUGIN-UI.md in the engine repository, shared with the Hermes plugin. Every class is `tameru-*`.
import { createPortal } from 'react-dom'
import { Component, useCallback, useEffect, useRef, useState } from 'react'
import { gaugeOf, groupsOf, emptyReasonKey, isBeta, readTab, sizeCells, statusOf, strengthOf, strengthPatch, writeTab, type Json, type StrengthId, type TabId } from './model.ts'
import { copy, type Copy } from './text.ts'
import { Drawn, Fragment, Icon, Ring, Tip, focusables, h, useAnchor, useDismiss } from './ui.ts'

export const inject = ['slots']

const ROUTE = 'api/tameru'
const DOCK_ID = 'dsh-tameru'
const POLL_OPEN_MS = 2000
const POLL_CLOSED_MS = 5000
const CARD_WIDTH = 480
const CARD_HEIGHT = 320
const MENU_WIDTH = 264
const PROBLEM_SEEN_MS = 10_000
const UNDO_MS = 5000
const NOTICE_MS = 5000

const STYLE = `
.tameru, .tameru-card, .tameru-menu { --t-fs: var(--dsh-content-font-size-secondary, 13px); --t-lh: calc(20px + var(--dsh-content-font-delta-secondary, 0px)); --t-fs-s: calc(var(--t-fs) - 1px); --t-lh-s: calc(18px + var(--dsh-content-font-delta-secondary, 0px));
  --t-fg1: var(--dsw-alias-label-primary, currentColor); --t-fg2: var(--dsw-alias-label-secondary, currentColor); --t-fg3: color-mix(in srgb, var(--dsw-alias-label-tertiary, color-mix(in srgb, currentColor 62%, transparent)) 70%, var(--t-fg1));
  --t-line: var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent)); --t-hover: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 9%, transparent));
  --t-accent: var(--dsw-static-blue-450, #4d6bfe); --t-error: var(--dsw-alias-state-error-primary, #d9534f);
  --t-ring-track: var(--dsw-alias-border-l3, color-mix(in srgb, currentColor 22%, transparent)); --t-ring-fill: var(--t-fg2);
  --t-mono: var(--dsw-font-family-mono, ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace);
  font-size: var(--t-fs); line-height: var(--t-lh); color: var(--t-fg2); box-sizing: border-box; }
.tameru *, .tameru *::before, .tameru *::after, .tameru-card *, .tameru-card *::before, .tameru-card *::after, .tameru-menu *, .tameru-menu *::before, .tameru-menu *::after { box-sizing: border-box; }
:where(.tameru, .tameru-card, .tameru-menu) button { font: inherit; color: inherit; background: transparent; border: 0; cursor: pointer; padding: 0; }
.tameru button:focus-visible, .tameru-card button:focus-visible, .tameru-card input:focus-visible, .tameru-menu button:focus-visible, .tameru-card pre:focus-visible { outline: 2px solid var(--t-accent); outline-offset: 1px; }
.tameru { width: calc(100% - 2 * var(--dsh-composer-side-clearance, 16px) - 4 * var(--dsh-composer-dock-inset, 8px)); margin: 0 auto; container-type: inline-size; }
.tameru-bar { isolation: isolate; position: relative; display: flex; align-items: center; gap: 10px; width: 100%; max-width: calc(var(--dsh-composer-card-max-width, 952px) - 4 * var(--dsh-composer-dock-inset, 8px)); margin: 0 auto; min-height: 36px; padding: 4px 5px 4px 12px;
  border-radius: var(--dsw-radius-md, 10px); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-panel); }
.tameru-bar::before { content: ""; position: absolute; inset: 0; z-index: -1; border-radius: inherit; background: var(--dsw-specific-menu, Canvas); backdrop-filter: var(--dsw-menu-backdrop-filter); pointer-events: none; }
.tameru-id { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; }
.tameru-star { flex: none; display: inline-flex; color: var(--t-fg3); } .tameru-star.working { color: var(--t-accent); animation: tameru-pulse 1.1s ease-in-out infinite alternate; } .tameru-star.off { opacity: .45; } .tameru-star.problem { color: var(--t-error); }
@keyframes tameru-pulse { from { opacity: 1; } to { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .tameru-star.working { animation: none; } }
.tameru-name { flex: none; white-space: nowrap; font-weight: 600; color: var(--t-fg1); cursor: default; }
.tameru-name small { font-size: var(--t-fs-s); line-height: var(--t-lh-s); font-weight: 400; color: var(--t-fg3); margin-left: 4px; }
.tameru-phrase { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; color: var(--t-fg3); padding: 2px 6px; border-radius: 6px; }
.tameru-phrase:hover { background: var(--t-hover); color: var(--t-fg2); }
.tameru-gauge { flex: none; display: inline-flex; align-items: center; gap: 6px; cursor: default; font-variant-numeric: tabular-nums; }
.tameru-gauge b { font-weight: 500; color: var(--t-fg1); } .tameru-gauge small { font-size: var(--t-fs-s); line-height: var(--t-lh-s); color: var(--t-fg3); }
.tameru-sep { flex: none; width: 1px; height: 16px; background: var(--dsw-alias-border-l2, var(--t-line)); }
.tameru-controls { flex: none; display: flex; align-items: center; gap: 4px; }
.tameru-strength, .tameru-launch, .tameru-ib { flex: none; display: inline-flex; align-items: center; justify-content: center; min-height: 28px; border-radius: 999px; color: var(--t-fg3); }
.tameru-strength { gap: 4px; padding: 0 8px 0 10px; font-size: var(--t-fs-s); line-height: var(--t-lh-s); } .tameru-strength svg { flex: none; }
.tameru-launch { gap: 4px; min-width: 28px; padding: 0 8px; font-size: var(--t-fs-s); line-height: var(--t-lh-s); font-variant-numeric: tabular-nums; }
.tameru-ib { width: 28px; padding: 0; }
.tameru-beta { flex: none; padding: 0 6px; border: 1px solid var(--t-line); border-radius: 999px; font-size: var(--t-fs-s); line-height: var(--t-lh-s); color: var(--t-fg2); cursor: default; }
.tameru-effective { color: var(--t-fg3); font-size: var(--t-fs-s); }
.tameru-strength:hover, .tameru-launch:hover, .tameru-ib:hover:not(:disabled) { color: var(--t-fg2); }
.tameru-strength[aria-expanded="true"], .tameru-launch.on { background: var(--t-hover); color: var(--t-fg1); } .tameru-ib:disabled { cursor: default; }
@container (max-width: 600px) { .tameru-word { display: none; } }
@container (max-width: 500px) { .tameru-figure { display: none; } }
.tameru-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.tameru-card, .tameru-menu { position: fixed; z-index: 1100; display: flex; flex-direction: column; overflow: hidden; border-radius: var(--dsw-radius-lg, 12px); background: var(--dsw-specific-menu, Canvas); backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-prominent); cursor: default; }
.tameru-head { flex: none; display: flex; align-items: center; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--t-line); }
.tameru-tabs { display: flex; gap: 4px; }
.tameru-tab { display: inline-flex; align-items: center; gap: 5px; min-height: 28px; min-width: 44px; padding: 0 10px; border-radius: 999px; color: var(--t-fg3); font-variant-numeric: tabular-nums; }
.tameru-tab:hover { color: var(--t-fg2); } .tameru-tab[aria-selected="true"] { background: var(--t-hover); color: var(--t-fg1); }
.tameru-grow { flex: 1; min-width: 0; }
.tameru-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; overflow-x: hidden; padding: 8px; }
.tameru-line { margin: 0 8px 8px; color: var(--t-fg3); overflow-wrap: anywhere; } .tameru-line.problem { color: var(--t-error); display: flex; gap: 8px; align-items: flex-start; } .tameru-line.problem svg { flex: none; margin-top: 3px; }
.tameru-line small { display: block; color: var(--t-fg3); font-size: var(--t-fs-s); line-height: var(--t-lh-s); }
.tameru-row { display: flex; align-items: center; min-height: 32px; margin-bottom: 2px; }
.tameru-rowmain { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; min-height: 32px; padding: 0 8px; border-radius: 8px; text-align: left; align-items: center; }
.tameru-rowmain:hover { background: var(--t-hover); }
.tameru-rowgo { flex: none; display: inline-flex; width: 12px; color: var(--t-fg3); opacity: 0; } .tameru-rowmain:hover .tameru-rowgo, .tameru-rowmain:focus-visible .tameru-rowgo { opacity: 1; }
.tameru-tool { flex: none; max-width: 14ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: var(--t-fg1); }
.tameru-arg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 400 var(--t-fs-s)/var(--t-lh-s) var(--t-mono); color: var(--t-fg2); }
.tameru-sizes { flex: none; width: 96px; display: grid; grid-template-columns: 40px 16px 40px; align-items: center; font-variant-numeric: tabular-nums; text-align: right; }
.tameru-sizes .from { font-weight: 400; color: var(--t-fg3); } .tameru-sizes .to { font-weight: 500; color: var(--t-fg1); } .tameru-sizes .arrow { display: inline-flex; justify-content: center; color: var(--t-fg3); }
.tameru-act { flex: none; width: 72px; display: flex; justify-content: flex-end; }
.tameru-act .next { font-size: var(--t-fs-s); line-height: var(--t-lh-s); color: var(--t-fg3); padding-right: 8px; }
.tameru-keep { display: inline-flex; align-items: center; gap: 4px; min-height: 28px; padding: 0 8px; border-radius: 999px; font-size: var(--t-fs-s); line-height: var(--t-lh-s); color: var(--t-fg3); }
.tameru-keep:hover { background: var(--t-hover); color: var(--t-fg2); } .tameru-keep.on { color: var(--t-fg1); }
.tameru-cap { display: flex; align-items: center; margin-bottom: 2px; font-size: var(--t-fs-s); line-height: var(--t-lh-s); color: var(--t-fg3); }
.tameru-cap span:first-child { flex: 1; } .tameru-cap .cell { flex: none; width: 96px; text-align: right; margin-right: 28px; } .tameru-cap .spacer { flex: none; width: 72px; }
.tameru-divider { margin: 8px 8px 4px; color: var(--t-fg3); font-size: var(--t-fs-s); line-height: var(--t-lh-s); }
.tameru-viewhead { flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--t-line); }
.tameru-viewtitle { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.tameru-viewtitle .tool { flex: none; font-weight: 500; color: var(--t-fg1); max-width: 14ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tameru-viewtitle .arg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 400 var(--t-fs-s)/var(--t-lh-s) var(--t-mono); color: var(--t-fg2); }
.tameru-viewtitle .ref { flex: none; font-size: var(--t-fs-s); line-height: var(--t-lh-s); font-weight: 400; color: var(--t-fg3); font-variant-numeric: tabular-nums; }
.tameru-seg { flex: none; display: inline-flex; border-radius: 999px; background: var(--t-hover); padding: 2px; }
.tameru-seg button { min-height: 24px; padding: 0 10px; border-radius: 999px; font-size: var(--t-fs-s); line-height: var(--t-lh-s); color: var(--t-fg3); } .tameru-seg button[aria-pressed="true"] { background: var(--dsw-specific-menu, Canvas); color: var(--t-fg1); box-shadow: 0 0 0 1px var(--t-line); }
.tameru-pre { flex: 1; min-height: 0; margin: 0; overflow: auto; padding: 8px; border-radius: 8px; background: var(--t-hover); color: var(--t-fg1); font: 400 var(--t-fs-s)/var(--t-lh-s) var(--t-mono); font-variant-ligatures: none; tab-size: 4; white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; }
.tameru-more { align-self: flex-start; margin-top: 6px; min-height: 28px; padding: 0 10px !important; border-radius: 999px; color: var(--t-fg2); font-size: var(--t-fs-s); line-height: var(--t-lh-s); } .tameru-more:hover { background: var(--t-hover); color: var(--t-fg1); }
.tameru-pin { display: flex; align-items: flex-start; gap: 4px; min-height: 32px; padding-left: 8px; border-radius: 8px; } .tameru-pin:hover { background: var(--t-hover); }
.tameru-pin span { flex: 1; min-width: 0; padding: 4px 0; color: var(--t-fg1); overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.tameru-pin .tameru-ib:hover { color: var(--t-error); }
.tameru-add { display: flex; align-items: center; gap: 4px; margin-top: 6px; position: relative; }
.tameru-add input { flex: 1; min-width: 0; font: inherit; color: var(--t-fg1); background: var(--t-hover); border: 0; border-radius: 999px; min-height: 28px; padding: 0 12px; } .tameru-add input::placeholder { color: var(--t-fg3); }
.tameru-count { position: absolute; right: 40px; font-size: var(--t-fs-s); color: var(--t-fg3); font-variant-numeric: tabular-nums; }
.tameru-undo { display: flex; align-items: center; gap: 4px; margin: 4px 8px; color: var(--t-fg3); }
.tameru-undo button { text-decoration: underline; text-underline-offset: 2px; padding: 2px 6px; min-height: 24px; border-radius: 6px; } .tameru-undo button:hover { color: var(--t-fg1); }
.tameru-menu { padding: 6px; }
.tameru-item { display: flex; align-items: flex-start; gap: 8px; width: 100%; padding: 6px 8px; border-radius: 8px; text-align: left; }
.tameru-item:hover, .tameru-item:focus-visible { background: var(--t-hover); } .tameru-item .check { flex: none; width: 14px; margin-top: 3px; color: var(--t-fg1); }
.tameru-item .name { display: block; color: var(--t-fg1); font-weight: 500; } .tameru-item .line { display: block; font-size: var(--t-fs-s); line-height: var(--t-lh-s); color: var(--t-fg3); }
.tameru-scope { margin: 4px 8px 2px; padding-top: 6px; border-top: 1px solid var(--t-line); font-size: var(--t-fs-s); line-height: var(--t-lh-s); color: var(--t-fg3); }
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

/** Which side of the viewer was last chosen: remembered for the session, so a reader of originals reaches them in one click. */
let lastSide: 'shown' | 'original' = 'shown'

function IconButton(props: { icon: any; label: string; tip?: string; id?: string; disabled?: boolean; onClick: () => void }) {
  return h(Tip, { label: props.tip ?? props.label },
    h('button', { type: 'button', id: props.id, className: 'tameru-ib', 'aria-label': props.label, disabled: props.disabled, onClick: props.onClick }, h(Icon, { name: props.icon })))
}

/** The one Keep control: lock plus word, and the same in the row and the viewer. */
function KeepButton({ item, t, act }: { item: Json; t: Copy; act: (op: string, ref: number) => void }) {
  const kept = item.state === 'kept' || item.state === 'restored'
  const button = h('button', { type: 'button', className: `tameru-keep${kept ? ' on' : ''}`, 'aria-label': kept ? `${t.kept}: ${t.releaseTip}` : `${t.keep} ${item.tool}`, onClick: () => act(kept ? 'unkeep' : 'keep', item.ref) },
    h(Drawn, { name: kept ? 'lockFilled' : 'lock' }), kept ? t.kept : t.keep)
  return kept ? h(Tip, { label: t.releaseTip }, button) : button
}

function Sizes({ item, t }: { item: Json; t: Copy }) {
  const cells = sizeCells(item)
  const group = h('span', { className: 'tameru-sizes' },
    h('span', { className: 'from' }, cells.from),
    h('span', { className: 'arrow' }, cells.held ? null : h(Drawn, { name: 'arrow' })),
    h('span', { className: 'to' }, cells.to))
  return item.cutByHarness ? h(Tip, { label: t.trimmed }, group) : group
}

function Row({ item, t, act, open }: { item: Json; t: Copy; act: (op: string, ref: number) => void; open: () => void }) {
  return h('div', { className: 'tameru-row' },
    h('button', { type: 'button', className: 'tameru-rowmain', onClick: open },
      h('span', { className: 'tameru-tool' }, item.tool || '—'),
      item.label ? h('span', { className: 'tameru-arg', title: item.label }, item.label) : h('span', { className: 'tameru-arg' }),
      h(Sizes, { item, t }),
      h('span', { className: 'tameru-rowgo', 'aria-hidden': true }, h(Icon, { name: 'right', size: 12 }))),
    h('span', { className: 'tameru-act' },
      item.queued ? h(Tip, { label: t.waitingTip }, h('span', { className: 'next' }, t.nextStep)) : h(KeepButton, { item, t, act })))
}

function Viewer({ item, sessionId, t, act, notice, problem, onBack, onClose }: { item: Json; sessionId: string; t: Copy; act: (op: string, ref: number) => void; notice: string; problem: any; onBack: () => void; onClose: () => void }) {
  const [side, setSide] = useState<'shown' | 'original'>(lastSide)
  const [pages, setPages] = useState<Json[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const sideRef = useRef(side)
  sideRef.current = side
  const fetchPage = useCallback((offset: number, replace: boolean) => {
    const which = side
    setLoading(true)
    return call('view', { sessionId, ref: item.ref, which, offset }).then(
      r => { if (sideRef.current !== which) return; if (r.ok) { setError(''); setPages(replace ? [r] : previous => [...previous, r]) } else setError(r.error); setLoading(false) },
      () => { if (sideRef.current !== which) return; setError(t.unreachable); setLoading(false) },
    )
  }, [sessionId, item.ref, side, t.unreachable])
  useEffect(() => { void fetchPage(0, true) }, [fetchPage, item.state])
  useEffect(() => { document.getElementById('tameru-back')?.focus() }, [])
  const choose = (next: 'shown' | 'original') => { lastSide = next; setSide(next) }
  const last = pages[pages.length - 1]
  const text = pages.map(page => page.text).join('')
  return h(Fragment, null,
    h('div', { className: 'tameru-viewhead' },
      h(IconButton, { icon: 'left', label: t.back, id: 'tameru-back', onClick: onBack }),
      h('span', { className: 'tameru-viewtitle' }, h('span', { className: 'tool' }, item.tool || '—'), item.label ? h('span', { className: 'arg', title: item.label }, item.label) : null, h('span', { className: 'ref' }, `#${item.ref}`)),
      h('div', { className: 'tameru-seg', role: 'group', 'aria-label': t.aiSees },
        h('button', { type: 'button', 'aria-pressed': side === 'shown', onClick: () => choose('shown') }, t.aiSees),
        h('button', { type: 'button', 'aria-pressed': side === 'original', onClick: () => choose('original') }, t.original)),
      item.queued ? null : h(KeepButton, { item, t, act }),
      h(IconButton, { icon: 'close', label: t.close, onClick: onClose })),
    h('div', { className: 'tameru-body' },
      problem,
      notice ? h('div', { className: 'tameru-line', role: 'status' }, notice) : null,
      error ? h('div', { className: 'tameru-line problem' }, h(Icon, { name: 'warn', size: 13 }), error)
        : h('pre', { className: 'tameru-pre', tabIndex: 0, 'aria-label': `${side === 'shown' ? t.aiSees : t.original}: ${item.tool} #${item.ref}` }, loading && !text ? t.loading : text),
      last && last.end < last.total ? h('button', { type: 'button', className: 'tameru-more', disabled: loading, onClick: () => void fetchPage(last.end, false) }, t.loadMore) : null))
}

function Pins({ state, sessionId, refresh, t, onProblem }: { state: Json; sessionId: string; refresh: () => void; t: Copy; onProblem: (raw: string) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [removed, setRemoved] = useState<string | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const limit: number = state.limits.pins
  const max: number = state.limits.pinChars
  const full = state.pins.length >= limit
  const add = async (value: string) => {
    if (!value.trim() || busy) return false
    setBusy(true)
    const r = await call('pin', { sessionId, text: value }).catch(() => ({ ok: false, error: t.unreachable }))
    setBusy(false)
    if (r.ok) { refresh(); return true }
    onProblem(String(r.error))
    return false
  }
  const submit = async () => { if (await add(text)) { setText(''); document.getElementById('tameru-pin-input')?.focus() } }
  const remove = async (position: number, value: string) => {
    const r = await call('unpin', { sessionId, position }).catch(() => ({ ok: false, error: t.unreachable }))
    if (!r.ok) { onProblem(String(r.error)); return }
    refresh()
    setRemoved(value)
    clearTimeout(undoTimer.current)
    undoTimer.current = setTimeout(() => setRemoved(null), UNDO_MS)
    document.getElementById('tameru-pin-input')?.focus()
  }
  useEffect(() => { document.getElementById('tameru-pin-input')?.focus(); return () => clearTimeout(undoTimer.current) }, [])
  return h(Fragment, null,
    state.pins.length === 0 ? h('div', { className: 'tameru-line' }, t.pinsEmpty) : state.pins.map((pin: string, i: number) =>
      h('div', { className: 'tameru-pin', key: `${i}:${pin}` }, h('span', { title: pin }, pin), h(IconButton, { icon: 'trash', label: `${t.removed}: ${pin}`, tip: t.removed, onClick: () => void remove(i + 1, pin) }))),
    removed !== null ? h('div', { className: 'tameru-undo', role: 'status' }, t.removed, h('button', { type: 'button', onClick: () => { const value = removed; setRemoved(null); void add(value) } }, t.undo)) : null,
    full ? h('div', { className: 'tameru-line' }, t.pinsLimit(state.pins.length, limit))
      : h('div', { className: 'tameru-add' },
          h('input', { id: 'tameru-pin-input', type: 'text', value: text, maxLength: max, placeholder: t.pinPlaceholder, 'aria-label': t.pinPlaceholder, onChange: (e: any) => setText(e.target.value),
            onKeyDown: (e: any) => { if (e.key === 'Enter' && !e.nativeEvent?.isComposing && e.keyCode !== 229) { e.preventDefault(); void submit() } } }),
          text.length >= max * 0.8 ? h('span', { className: 'tameru-count' }, `${text.length}/${max}`) : null,
          h(IconButton, { icon: 'plus', label: t.pinPlaceholder, disabled: busy || !text.trim(), onClick: () => void submit() })),
    h('div', { className: 'tameru-line', style: { margin: '6px 8px 0' } }, t.pinsWarning))
}

function StrengthMenu({ current, t, onPick }: { current: StrengthId | 'custom'; t: Copy; onPick: (id: StrengthId) => void }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement | null>(null)
  const menu = useRef<HTMLDivElement | null>(null)
  const anchored = useAnchor(open, button, MENU_WIDTH, 6, true)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, [button, menu], close)
  useEffect(() => {
    if (!open || !anchored) return
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])]
    // the checked item may be disabled (Custom): then focus the first enabled one so arrow keys reach onMenuKey
    ;(items.find(item => item.getAttribute('aria-checked') === 'true' && !item.hasAttribute('disabled')) ?? items.find(item => !item.hasAttribute('disabled')))?.focus()
  }, [open, !!anchored])
  const ids: Array<StrengthId | 'custom'> = ['off', 'less', 'normal', 'more', ...(current === 'custom' ? ['custom' as const] : [])]
  const onMenuKey = (e: any) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not([disabled])') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const move = (index: number) => { e.preventDefault(); items[(index + items.length) % items.length]?.focus() }
    if (e.key === 'ArrowDown') move(at + 1)
    else if (e.key === 'ArrowUp') move(at - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(items.length - 1)
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); button.current?.focus() }
    else if (e.key === 'Tab') setOpen(false)
  }
  const choose = (id: StrengthId) => { setOpen(false); button.current?.focus(); if (id !== current) onPick(id) }
  return h(Fragment, null,
    h('button', { ref: button, id: 'tameru-strength', type: 'button', className: 'tameru-strength', 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-label': `${t.strengthLabel}: ${t.strengths[current].name}`,
      onClick: () => setOpen(value => !value), onKeyDown: (e: any) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true) } } },
      t.strengths[current].name, h(Icon, { name: 'down', size: 12 })),
    open && anchored ? createPortal(
      h('div', { ref: menu, className: 'tameru-menu', role: 'menu', 'aria-label': t.strengthLabel, onKeyDown: onMenuKey, style: { left: anchored.left, bottom: anchored.bottom, width: anchored.width } },
        ids.filter(id => id !== 'custom' || current === 'custom').map(id => {
          const entry = t.strengths[id]
          return h('button', { key: id, type: 'button', role: 'menuitemradio', 'aria-checked': current === id, className: 'tameru-item', disabled: id === 'custom', tabIndex: -1, onClick: () => id !== 'custom' && choose(id as StrengthId) },
            h('span', { className: 'check' }, current === id ? h(Icon, { name: 'check' }) : null), h('span', null, h('span', { className: 'name' }, entry.name), h('span', { className: 'line' }, entry.line)))
        }),
        h('div', { className: 'tameru-scope' }, t.scopeAll)),
      document.body) : null)
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
  const [problem, setProblem] = useState<{ kind: string; raw: string } | null>(null)
  const [chosen, setChosen] = useState<Json>({})
  const current = useRef<string | undefined>(sessionId)
  const loading = useRef<Promise<void> | undefined>(undefined)
  const loadingFor = useRef<string | undefined>(undefined)
  const barRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  current.current = sessionId

  // a different chat is a different state: nothing of the last one is shown for it
  useEffect(() => { setState(null); setFailed(false); setNotice(''); setProblem(null); setViewing(null); setOpen(false); setChosen({}) }, [sessionId])

  const load = useCallback(async (signal?: AbortSignal, force = false) => {
    const asked = current.current
    if (!asked) return
    if (loading.current && loadingFor.current === asked) {
      if (!force) return
      await loading.current // a change made while a refresh was running: wait for it, then fetch again so the answer is newer than the change
    }
    loadingFor.current = asked
    const run = (async () => {
      try {
        const next = await call('state', { sessionId: asked }, signal)
        // the answer is kept with the chat it is for, so a chat switch can never show another chat's numbers
        if (current.current === asked) { setState({ ...next, sessionKey: asked }); setFailed(false) }
      } catch (error: any) {
        if (error?.name !== 'AbortError' && current.current === asked) setFailed(true)
      }
    })()
    loading.current = run
    await run
    if (loading.current === run) { loading.current = undefined; loadingFor.current = undefined }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    const timer = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) void load(controller.signal) }, open ? POLL_OPEN_MS : POLL_CLOSED_MS)
    const onVisible = () => { if (!document.hidden) void load(controller.signal) }
    document.addEventListener?.('visibilitychange', onVisible)
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener?.('visibilitychange', onVisible); loading.current = undefined; loadingFor.current = undefined }
  }, [load, open, sessionId])

  // a problem clears on the next success of the same kind, or ten seconds after the person has had the card open to see it
  useEffect(() => {
    if (!open || !problem) return
    const timer = setTimeout(() => setProblem(null), PROBLEM_SEEN_MS)
    return () => clearTimeout(timer)
  }, [open, problem])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])
  const close = useCallback(() => { setOpen(false); setViewing(null); setNotice('') }, [])
  useDismiss(open, [cardRef, barRef], close)
  const anchored = useAnchor(open, barRef, CARD_WIDTH)
  const opened = useRef(false)
  useEffect(() => {
    if (open && anchored && !opened.current) { opened.current = true; document.getElementById(`tameru-tab-${tab}`)?.focus() }
    if (!open) opened.current = false
  }, [open, !!anchored])

  const launch = (next: TabId) => {
    if (open && tab === next && viewing === null) { close(); return }
    setTab(next); writeTab(next); setViewing(null); setNotice(''); setOpen(true)
  }
  const goBack = (id: string) => { close(); setTimeout(() => document.getElementById(id)?.focus(), 0) }

  const act = async (op: string, ref: number) => {
    if (!sessionId) return
    const r = await call('hold', { sessionId, op, ref }).catch(() => ({ ok: false, error: t.unreachable }))
    if (r.ok) { setProblem(previous => (previous?.kind === 'hold' ? null : previous)); setNotice(op === 'unkeep' ? t.releaseConfirm : t.keepConfirm) } else { setNotice(''); setProblem({ kind: 'hold', raw: String(r.error) }) }
    await load(undefined, true)
  }
  const send = async (patch: Json, revert: () => void) => {
    const r = await call('settings', { patch }).catch(() => ({ ok: false, error: t.unreachable }))
    if (r.ok) setProblem(previous => (previous?.kind === 'settings' ? null : previous))
    else { setProblem({ kind: 'settings', raw: String(r.error) }); revert() }
    await load(undefined, true)
    setChosen({})
  }
  const pick = (id: StrengthId) => { setChosen({ strength: id }); void send(strengthPatch(id), () => setChosen({})) }

  const live = state?.live === true
  // the label comes from the host's resolved `effective` object only; without one there is no strength to show
  const resolved = live ? strengthOf(state!.effective) : null
  const strength: StrengthId | 'custom' | null = resolved === null ? null : (chosen.strength ?? resolved)
  const beta = live && isBeta(state!.effective)
  const status = statusOf(state, failed, problem !== null)
  const phrase = t.status(status)
  const gauge = gaugeOf(pressure, state)
  const { shortened, kept } = groupsOf(state)
  const pinCount = live ? state!.pins.length : 0
  const viewed = viewing === null ? undefined : [...shortened, ...kept].find(item => item.ref === viewing)
  const tabs: TabId[] = ['results', 'pins']

  const problemLine = status.tone === 'problem' && live || status.key === 'notConnected' || status.key === 'notRunning' || status.key === 'notRunningRetrying'
    ? h('div', { className: 'tameru-line problem' }, h(Icon, { name: 'warn', size: 13 }), h('span', null,
        status.key === 'notRunning' ? t.problems.notRunning : status.key === 'notRunningRetrying' ? t.problems.notRunningRetrying : status.key === 'notConnected' ? t.problems.notConnected : t.problems.problem,
        status.key === 'problem' ? h('small', null, `${t.problems.details} ${problem?.raw ?? state?.failure ?? ''}`) : null))
    : null

  const results = !live ? null : (shortened.length === 0 && kept.length === 0)
    ? h('div', { className: 'tameru-line' }, state!.gauge ? t.empty[emptyReasonKey(state!.chat.lastSkip, state!.gauge.tokens < state!.gauge.startsAt)] : t.gaugeReason(state!.gaugeUnavailable))
    : h(Fragment, null,
        shortened.length > 0 ? h('div', { className: 'tameru-cap' }, h('span', null), h('span', { className: 'cell' }, t.characters), h('span', { className: 'spacer' })) : null,
        [...shortened].reverse().map(item => h(Row, { key: item.ref, item, t, act, open: () => setViewing(item.ref) })),
        kept.length > 0 ? h('div', { className: 'tameru-divider' }, t.keptDivider(kept.length)) : null,
        [...kept].reverse().map(item => h(Row, { key: item.ref, item, t, act, open: () => setViewing(item.ref) })))

  const onCardKey = (e: any) => {
    if (e.key === 'Escape') { setTimeout(() => document.getElementById(`tameru-launch-${tab}`)?.focus(), 0); return }
    if (e.key !== 'Tab') return
    const items = focusables(cardRef.current)
    const edge = e.shiftKey ? items[0] : items[items.length - 1]
    if (items.length === 0 || document.activeElement === edge) { e.preventDefault(); goBack(`tameru-launch-${tab}`) }
  }

  const card = open && anchored ? createPortal(
    h('div', { ref: cardRef, id: 'tameru-card', className: 'tameru-card', role: 'dialog', 'aria-modal': 'false', 'aria-label': t.card, onKeyDown: onCardKey,
      style: { left: anchored.left, bottom: anchored.bottom, width: anchored.width, height: Math.min(CARD_HEIGHT, anchored.maxHeight || CARD_HEIGHT) } },
      viewed ? h(Viewer, { item: viewed, sessionId: sessionId!, t, act, notice, problem: problemLine, onBack: () => setViewing(null), onClose: close })
        : h(Fragment, null,
            h('div', { className: 'tameru-head' },
              h('div', { className: 'tameru-tabs', role: 'tablist', 'aria-label': t.tabsLabel },
                tabs.map(id => {
                  const count = id === 'pins' ? pinCount : shortened.length
                  const word = id === 'pins' ? t.tabPins : t.tabShortened
                  return h('button', { key: id, type: 'button', id: `tameru-tab-${id}`, role: 'tab', className: 'tameru-tab', 'aria-selected': tab === id, 'aria-controls': 'tameru-tabpanel', tabIndex: tab === id ? 0 : -1,
                    onKeyDown: (e: any) => {
                      const next = e.key === 'ArrowRight' || e.key === 'ArrowLeft' ? tabs[(tabs.indexOf(id) + 1) % tabs.length] : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1] : undefined
                      if (next) { e.preventDefault(); setTab(next); writeTab(next); document.getElementById(`tameru-tab-${next}`)?.focus() }
                    },
                    onClick: () => { setTab(id); writeTab(id) } }, h(Icon, { name: id === 'pins' ? 'pin' : 'list' }), h('span', null, word), h('span', null, String(count)))
                })),
              h('span', { className: 'tameru-grow' }),
              h(IconButton, { icon: 'close', label: t.close, onClick: () => goBack(`tameru-launch-${tab}`) })),
            h('div', { className: 'tameru-body', role: 'tabpanel', id: 'tameru-tabpanel', 'aria-labelledby': `tameru-tab-${tab}` },
              !state ? h('div', { className: 'tameru-line' }, failed ? t.unreachable : t.loading) : h(Fragment, null,
                problemLine,
                tab === 'pins' && live ? h(Pins, { state, sessionId: sessionId!, refresh: () => void load(undefined, true), t, onProblem: raw => setProblem({ kind: 'pins', raw }) })
                  : h(Fragment, null, notice ? h('div', { className: 'tameru-line', role: 'status' }, notice) : null, results,
                      live && state!.effective ? h('div', { className: 'tameru-line tameru-effective' }, t.effectiveLine(state!.effective)) : null))))),
    document.body) : null

  const fullParts = gauge ? t.full(gauge.percent) : null
  const launcherKey = (id: TabId) => (e: any) => {
    if (e.key === 'Tab' && !e.shiftKey && open && cardRef.current && tab === id) { const first = focusables(cardRef.current)[0]; if (first) { e.preventDefault(); first.focus() } }
  }

  return h('div', { className: 'tameru', role: 'region', 'aria-label': t.name },
    h('div', { className: 'tameru-bar', ref: barRef },
      h('div', { className: 'tameru-id' },
        h('span', { className: `tameru-star ${status.tone}`, 'aria-hidden': true }, h(Drawn, { name: 'star' })),
        h(Tip, { label: t.nameTip(state?.version ?? '') }, h('span', { className: 'tameru-name' }, t.name, h('small', { lang: 'ja' }, t.kana))),
        phrase ? h('button', { type: 'button', className: 'tameru-phrase', onClick: () => (live ? launch('results') : undefined), title: phrase }, h('span', { 'aria-live': 'polite' }, phrase)) : h('span', { className: 'tameru-phrase' })),
      fullParts ? h(Tip, { label: t.gaugeTitle(gauge!.percent, gauge!.starts, gauge!.compacts) },
        h('span', { className: 'tameru-gauge' }, h(Ring, { percent: gauge!.percent, ...(gauge!.starts !== undefined ? { starts: gauge!.starts } : {}) }),
          h('span', { className: 'tameru-figure' }, fullParts.before ? h('small', { className: 'tameru-word' }, `${fullParts.before} `) : null, h('b', null, fullParts.figure), fullParts.after ? h('small', { className: 'tameru-word' }, ` ${fullParts.after}`) : null))) : null,
      live ? h(Fragment, null,
        h('span', { className: 'tameru-sep', 'aria-hidden': true }),
        h('div', { className: 'tameru-controls' },
          beta ? h(Tip, { label: t.betaTip }, h('span', { className: 'tameru-beta' }, t.beta)) : null,
          strength !== null ? h(StrengthMenu, { current: strength, t, onPick: pick }) : null,
          h('button', { type: 'button', id: 'tameru-launch-results', className: `tameru-launch${open && tab === 'results' ? ' on' : ''}`, 'aria-expanded': open && tab === 'results', 'aria-controls': open ? 'tameru-card' : undefined, 'aria-label': `${t.tabShortened}, ${shortened.length}`, onKeyDown: launcherKey('results'), onClick: () => launch('results') },
            h(Icon, { name: 'list' }), String(shortened.length)),
          h('button', { type: 'button', id: 'tameru-launch-pins', className: `tameru-launch${open && tab === 'pins' ? ' on' : ''}`, 'aria-expanded': open && tab === 'pins', 'aria-controls': open ? 'tameru-card' : undefined, 'aria-label': `${t.tabPins}, ${pinCount}`, onKeyDown: launcherKey('pins'), onClick: () => launch('pins') },
            h(Icon, { name: 'pin' }), String(pinCount)))) : null),
    card)
}

/** A bar that fails to draw must never take the chat's message box with it: a plain name and a quiet line stand in. */
class Boundary extends Component<{ children?: any }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (!this.state.failed) return this.props.children
    const t = copy()
    return h('div', { className: 'tameru' }, h('div', { className: 'tameru-bar' }, h('div', { className: 'tameru-id' },
      h('span', { className: 'tameru-star problem', 'aria-hidden': true }, h(Drawn, { name: 'star' })), h('span', { className: 'tameru-name' }, t.name, h('small', { lang: 'ja' }, t.kana)), h('span', { className: 'tameru-phrase' }, t.status({ key: 'problem', tone: 'problem' })))))
  }
}

function Dock(props: Json) {
  return h(Boundary, null, h(Bar, props))
}

export function apply(ctx: any) {
  ctx.effect(() => installStyle(), 'tameru: styles')
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({ name: 'conversation.input.dock', id: DOCK_ID, order: 30, inject: (sessionId: string) => ({ sessionId }) }, Dock)),
    'tameru: dock bar',
  )
}
