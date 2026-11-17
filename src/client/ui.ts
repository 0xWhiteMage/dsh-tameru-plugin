// The Harness shares a module of UI parts (`@deepseek-ai/dsh-client-ui-primitives`) with plugin bundles. It is not a documented contract, so
// every part is looked up by name, must be a real component, and has a plain fallback: a renamed, missing or odd export makes the bar look
// plainer, never stop working. Tameru's own drawings (star, lock, undo, arrow) come from the shared file and are the same in every plugin.
import { Fragment, cloneElement, createElement as h, useEffect, useLayoutEffect, useState } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import shared from '../shared/ui-icons.json' with { type: 'json' }

const P = primitives as unknown as Record<string, unknown>

/** A function component, or a wrapped one (memo, forwardRef): anything React can draw. Not a string, a plain object or a number. */
export const isComponent = (value: unknown): boolean => typeof value === 'function' || (value !== null && typeof value === 'object' && '$$typeof' in (value as object))
const hostPart = (name: string): any => (isComponent(P[name]) ? P[name] : undefined)

/** The host's generic icons, each with a plain drawing for when it is not there (16 x 16, stroke only). */
const GENERIC: Record<string, { host: string; path: string }> = {
  close: { host: 'IconCloseOutlineRegular', path: 'M3.5 3.5l9 9M12.5 3.5l-9 9' },
  down: { host: 'IconChevronDownOutlineRegular', path: 'M3.5 5.5 8 10l4.5-4.5' },
  left: { host: 'IconChevronLeftOutlineRegular', path: 'M10 3.5 5.5 8l4.5 4.5' },
  right: { host: 'IconChevronRightOutlineRegular', path: 'M6 3.5 10.5 8 6 12.5' },
  plus: { host: 'IconPlusOutlineRegular', path: 'M8 3v10M3 8h10' },
  trash: { host: 'IconTrashOutlineRegular', path: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5' },
  warn: { host: 'IconWarningOutlineRegular', path: 'M8 2.5 14 13H2L8 2.5ZM8 6.5v3M8 11.5v.01' },
  info: { host: 'IconInfoOutlineRegular', path: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM8 7.5v3.5M8 5v.01' },
  clock: { host: 'IconClockOutlineRegular', path: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM8 4.5V8l2.5 1.5' },
  check: { host: 'IconCheckOutlineRegular', path: 'M3 8.5l3.5 3.5L13 4.5' },
  list: { host: 'IconFlatListOutlineRegular', path: 'M3 4.5h10M3 8h10M3 11.5h10' },
  pin: { host: 'IconPinOutlineRegular', path: 'M5.5 2h5M6.5 2v4L4.5 9h7l-2-3V2M8 9v5' },
}

export type IconName = keyof typeof GENERIC

const svgPaths = (paths: Array<{ d: string; fill?: boolean }>, stroke: number) =>
  paths.map((p, i) => h('path', { key: i, d: p.d, fill: p.fill ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round', strokeLinejoin: 'round' }))

/** One of the host's generic icons at `size` px. */
export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  const entry = GENERIC[name]!
  const Native = hostPart(entry.host)
  if (Native) return h(Native, { size })
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true, focusable: false }, svgPaths([{ d: entry.path }], 1.4))
}

export type DrawnName = keyof typeof shared.icons

/** One of Tameru's own drawings (star, lock, lockFilled, undo, arrow), the same in every plugin. */
export function Drawn({ name, size }: { name: DrawnName; size?: number }) {
  const icon = shared.icons[name] as { size?: number; paths: Array<{ d: string; fill?: boolean }> }
  const px = size ?? icon.size ?? shared.size
  return h('svg', { width: px, height: px, viewBox: `0 0 ${shared.grid} ${shared.grid}`, 'aria-hidden': true, focusable: false }, svgPaths(icon.paths, shared.stroke))
}

/** The context ring: 14 px, r 6, stroke 2, filling clockwise from 12 o'clock, with one notch where Tameru starts. */
export function Ring({ percent, starts }: { percent: number; starts?: number }) {
  const r = 6
  const c = 2 * Math.PI * r
  const angle = starts === undefined ? 0 : starts * 2 * Math.PI - Math.PI / 2
  return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true, focusable: false, className: 'tameru-ring' },
    h('circle', { cx: 8, cy: 8, r, fill: 'none', stroke: 'var(--t-ring-track)', strokeWidth: 2 }),
    h('circle', { cx: 8, cy: 8, r, fill: 'none', stroke: 'var(--t-ring-fill)', strokeWidth: 2, strokeLinecap: 'round', strokeDasharray: `${(c * Math.max(0, Math.min(100, percent))) / 100} ${c}`, transform: 'rotate(-90 8 8)' }),
    starts === undefined ? null : h('line', { x1: 8 + 4.5 * Math.cos(angle), y1: 8 + 4.5 * Math.sin(angle), x2: 8 + 7.5 * Math.cos(angle), y2: 8 + 7.5 * Math.sin(angle), stroke: 'var(--t-fg1)', strokeWidth: 1.5 }))
}

/** The Harness's hover card around one element; without it, the browser's own `title`. */
export function Tip({ label, children, side = 'top' }: { label: string; children: any; side?: 'top' | 'bottom' }) {
  const Tooltip = hostPart('Tooltip')
  if (Tooltip && label) return h(Tooltip, { label, side, delayMs: 300, portal: true, children })
  return label ? cloneElement(children, { title: label }) : children
}

export interface Anchored {
  left: number
  bottom: number
  width: number
  maxHeight: number
}

/** Where a card goes: above its anchor with their right edges level, as wide as `width` allows, never off the screen. While the card is open
 *  the anchor is watched every frame: a collapsing sidebar or a growing message box moves it without any resize or scroll event. */
export function useAnchor(open: boolean, anchor: { current: HTMLElement | null }, width: number, gap = 6, exact = false): Anchored | undefined {
  const [at, setAt] = useState<Anchored | undefined>(undefined)
  useLayoutEffect(() => {
    if (!open) { setAt(undefined); return }
    let frame = 0
    let last = ''
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect()
      if (rect) {
        // a card is as wide as its anchor up to `width`; a menu (`exact`) is exactly `width`
        const w = Math.min(width, exact ? width : rect.width, window.innerWidth - 24)
        const next = { width: w, left: Math.max(12, Math.min(rect.right - w, window.innerWidth - w - 12)), bottom: Math.round(window.innerHeight - rect.top + gap), maxHeight: Math.max(0, Math.round(rect.top - gap - 12)) }
        const key = `${next.width}|${Math.round(next.left)}|${next.bottom}|${next.maxHeight}`
        if (key !== last) { last = key; setAt(next) }
      }
      frame = window.requestAnimationFrame(place)
    }
    place()
    return () => window.cancelAnimationFrame(frame)
  }, [open, anchor, width, gap, exact])
  return at
}

/** Close on a press outside the given elements, or on Escape: but only an Escape that nothing else has handled and that happens where the
 *  user is (inside one of the elements, or with nothing focused), so the message box's own Escape still reaches the message box. */
export function useDismiss(open: boolean, inside: Array<{ current: HTMLElement | null }>, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const within = (node: Node | null): boolean => !!node && inside.some(ref => ref.current?.contains(node))
    const onPointer = (event: Event) => { if (!within(event.target as Node | null)) close() }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const active = document.activeElement
      if (within(active) || active === document.body || active === null) close()
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onPointer, true); document.removeEventListener('keydown', onKey) }
  }, [open, close])
}

/** The focusable elements inside a container, in tab order. */
export function focusables(root: HTMLElement | null): HTMLElement[] {
  return root ? [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"]), pre[tabindex]')].filter(el => el.offsetParent !== null || el === document.activeElement) : []
}

export { h, Fragment }
