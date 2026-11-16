// The Harness shares a module of UI parts (`@deepseek-ai/dsh-client-ui-primitives`) with plugin bundles. It is not a documented contract, so
// every part is looked up by name and has a plain fallback: a renamed or missing export makes the bar look plainer, never stop working.
import { Fragment, cloneElement, createElement as h, useEffect, useLayoutEffect, useState } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

const P = primitives as unknown as Record<string, any>

/** Our icon names, the Harness's export for each, and a tiny inline drawing for when it is not there (16x16, stroke only). */
const ICONS: Record<string, { name: string; path: string }> = {
  pin: { name: 'IconPinOutlineRegular', path: 'M5.5 2h5M6.5 2v4L4.5 9h7l-2-3V2M8 9v5' },
  pinFill: { name: 'IconPinFillRegular', path: 'M5.5 2h5M6.5 2v4L4.5 9h7l-2-3V2M8 9v5' },
  eye: { name: 'IconEyeOutlineRegular', path: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z' },
  eyeOff: { name: 'IconEyeOffOutlineRegular', path: 'M2 2l12 12M6.5 4a6 6 0 0 1 1.5-.5c4 0 6.5 4.5 6.5 4.5a11 11 0 0 1-2 2.5M4 5.5C2.5 6.8 1.5 8 1.5 8s2.500 4.500 6.500 4.500c1 0 1.900-.3 2.700-.7' },
  close: { name: 'IconCloseOutlineRegular', path: 'M3.5 3.5l9 9M12.5 3.5l-9 9' },
  up: { name: 'IconChevronUpOutlineRegular', path: 'M3.5 10.500 8 6l4.500 4.500' },
  down: { name: 'IconChevronDownOutlineRegular', path: 'M3.5 5.500 8 10l4.500-4.500' },
  left: { name: 'IconChevronLeftOutlineRegular', path: 'M10 3.500 5.500 8l4.500 4.500' },
  right: { name: 'IconChevronRightOutlineRegular', path: 'M6 3.500 10.500 8 6 12.500' },
  plus: { name: 'IconPlusOutlineRegular', path: 'M8 3v10M3 8h10' },
  trash: { name: 'IconTrashOutlineRegular', path: 'M3 4.500h10M6.500 4.500V3h3v1.500M4.500 4.500l.5 8.500h6l.5-8.500' },
  warn: { name: 'IconWarningOutlineRegular', path: 'M8 2.500 14 13H2L8 2.500ZM8 6.500v3M8 11.500v.01' },
  info: { name: 'IconInfoOutlineRegular', path: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM8 7.500v3.500M8 5v.01' },
  pause: { name: 'IconPauseOutlineRegular', path: 'M5.500 3.500v9M10.500 3.500v9' },
  play: { name: 'IconPlayOutlineRegular', path: 'M5 3.500v9l7.500-4.500L5 3.500Z' },
  list: { name: 'IconFlatListOutlineRegular', path: 'M3 4.500h10M3 8h10M3 11.500h10' },
  clock: { name: 'IconClockOutlineRegular', path: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM8 4.500V8l2.500 1.500' },
  archive: { name: 'IconArchiveOutlineRegular', path: 'M2.500 4h11v2.500h-11V4ZM3.500 6.500V13h9V6.500M6.500 9h3' },
  refresh: { name: 'IconRefreshOutlineRegular', path: 'M13 8a5 5 0 1 1-1.500-3.500M13 3v3h-3' },
}

export type IconName = keyof typeof ICONS

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  const entry = ICONS[name]!
  const Native = P[entry.name]
  if (Native) return h(Native, { size })
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true, focusable: false },
    h('path', { d: entry.path, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))
}

/** The Harness's hover card around one element; without it, the browser's own `title`. */
export function Tip({ label, children, side = 'top' }: { label: string; children: any; side?: 'top' | 'bottom' }) {
  if (P.Tooltip && label) return h(P.Tooltip, { label, side, delayMs: 300, portal: true, children })
  return label ? cloneElement(children, { title: label }) : children
}

const DOT_STATES = { ok: 'done', idle: 'idle', warn: 'error', off: 'idle' } as const

/** The Harness's small status dot; without it, a coloured circle. */
export function Dot({ tone }: { tone: 'ok' | 'idle' | 'warn' | 'off' }) {
  if (P.StateDot) return h('span', { className: 'tameru-dotwrap', 'aria-hidden': true }, h(P.StateDot, { state: DOT_STATES[tone] }))
  return h('span', { className: `tameru-dot ${tone}`, 'aria-hidden': true })
}

export interface Anchored {
  left: number
  bottom: number
  width: number
  maxHeight: number
}

/** Where a card goes: above its anchor, as wide as `width` allows, never off the screen. Recomputed on resize and scroll. */
export function useAnchor(open: boolean, anchor: { current: HTMLElement | null }, width: number): Anchored | undefined {
  const [at, setAt] = useState<Anchored | undefined>(undefined)
  useLayoutEffect(() => {
    if (!open) { setAt(undefined); return }
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect()
      if (!rect) return
      const w = Math.min(width, window.innerWidth - 24)
      setAt({ width: w, left: Math.max(12, Math.min(rect.left, window.innerWidth - w - 12)), bottom: window.innerHeight - rect.top + 8, maxHeight: Math.max(160, rect.top - 24) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, anchor, width])
  return at
}

/** Close on a press outside the given elements, or on Escape. */
export function useDismiss(open: boolean, inside: Array<{ current: HTMLElement | null }>, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const onPointer = (event: Event) => {
      const target = event.target as Node | null
      if (target && inside.some(ref => ref.current?.contains(target))) return
      close()
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onPointer, true); document.removeEventListener('keydown', onKey) }
  }, [open, close])
}

export { h, Fragment }
