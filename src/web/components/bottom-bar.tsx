/**
 * Phone navigation.
 *
 * A horizontally scrolling tab strip is a desktop pattern that reads badly on a
 * phone: half the sections are off-screen, the scroll position resets on every
 * navigation, and the current section can scroll out of view. The panel's real
 * job on a phone is a handful of frequent actions — read the list, write, run a
 * task, change a setting — so those get a fixed bottom bar, and the rest lives
 * behind a "More" sheet.
 *
 * The bar is portalled to `document.body` rather than rendered in place. A
 * `position: fixed` element is anchored to the nearest ancestor that establishes
 * a containing block, and the panel's grid layout does that: rendered inline, the
 * bar floated in the middle of long pages instead of sitting on the viewport
 * edge. Portalling removes the question entirely.
 */

import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { createPortal } from 'preact/compat'
import { hrefOf, type Route } from '../lib/router'

export interface NavItem {
  key: string
  label: string
  route: Route
  /** A short glyph — the theme's own icon language is inline SVG, so this is text. */
  glyph: string
}

/** The four a person reaches for on a phone, plus everything else. */
export function BottomBar({
  items,
  more,
  current,
  moreLabel = 'More',
  sectionsLabel = 'Sections',
  currentLabel = 'Current',
  closeLabel = 'Close',
}: {
  items: NavItem[]
  more: NavItem[]
  /** The route key that should read as current, or '' when none does. */
  current: string
  /** The word on the button that opens the sheet. */
  moreLabel?: string
  sectionsLabel?: string
  currentLabel?: string
  closeLabel?: string
}): ComponentChildren {
  const [open, setOpen] = useState(false)
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)

  // A portal needs a DOM node, which does not exist during the first render.
  useEffect(() => { setPortalTarget(document.body) }, [])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  // Navigating closes the sheet; so does the back gesture, via `close`.
  useEffect(() => { setOpen(false) }, [current])

  const moreActive = more.some(item => item.key === current)

  const content = (
    <>
      <nav class="bottombar" aria-label={sectionsLabel}>
        {items.map(item => (
          <a
            key={item.key}
            class="bottombar__item"
            href={hrefOf(item.route)}
            aria-current={current === item.key ? 'page' : undefined}
          >
            <span class="bottombar__glyph" aria-hidden="true">{item.glyph}</span>
            <span class="bottombar__label">{item.label}</span>
          </a>
        ))}
        <button
          type="button"
          class="bottombar__item"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-current={moreActive && !open ? 'page' : undefined}
          onClick={() => setOpen(true)}
        >
          <span class="bottombar__glyph" aria-hidden="true">⋯</span>
          <span class="bottombar__label">{moreLabel}</span>
        </button>
      </nav>

      <dialog
        ref={dialogRef}
        class="sheet"
        aria-labelledby="sheet-title"
        onClose={() => setOpen(false)}
        onCancel={(event) => { event.preventDefault(); setOpen(false); dialogRef.current?.close() }}
      >
        {open && (
          <div class="sheet__body">
            <div class="sheet__grab" aria-hidden="true" />
            <h2 id="sheet-title" class="sheet__title">{moreLabel}</h2>
            <ul class="sheet__list">
              {more.map(item => (
                <li key={item.key}>
                  <a
                    class="sheet__item"
                    href={hrefOf(item.route)}
                    aria-current={current === item.key ? 'page' : undefined}
                    onClick={() => setOpen(false)}
                  >
                    <span class="sheet__glyph" aria-hidden="true">{item.glyph}</span>
                    <span>{item.label}</span>
                    {current === item.key && <span class="mark mark--info">{currentLabel}</span>}
                  </a>
                </li>
              ))}
            </ul>
            <button type="button" class="btn sheet__close" onClick={() => setOpen(false)}>
              {closeLabel}
            </button>
          </div>
        )}
      </dialog>
    </>
  )

  return portalTarget ? createPortal(content, portalTarget) : null
}
