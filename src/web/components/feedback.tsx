/**
 * Progress and status primitives.
 *
 * The panel's earlier state showed nothing while a request was in flight: a
 * click did its work invisibly and either the row changed or a toast appeared
 * much later. On a phone that reads as "nothing happened", so this module gives
 * every async action three visible states — idle, working, done or failed — and
 * a spinner that respects reduced motion.
 */

import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'

/** A spinner. Motion is the only thing that says "working", so it is labelled. */
export function Spinner({ label = '处理中' }: { label?: string }): ComponentChildren {
  return (
    <span class="spinner" role="status" aria-label={label}>
      <span class="spinner__ring" aria-hidden="true" />
      <span class="sr-only">{label}</span>
    </span>
  )
}

/**
 * A button that shows its own progress.
 *
 * `onRun` may return a promise; the button disables itself and swaps its label
 * for a spinner until it settles. A failure re-enables it and leaves the error
 * to the caller's toast — the button's job is only to show that it is working.
 */
export function ActionButton({
  children,
  onRun,
  variant = 'default',
  label,
  className,
  disabled,
  ariaLabel,
}: {
  children: ComponentChildren
  onRun: () => Promise<unknown> | unknown
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  /** Shown while running, replacing the children. */
  label?: string
  className?: string
  disabled?: boolean
  ariaLabel?: string
}): ComponentChildren {
  const [running, setRunning] = useState(false)
  const classes = [
    'btn',
    variant === 'primary' ? 'btn--primary' : '',
    variant === 'danger' ? 'btn--danger' : '',
    variant === 'ghost' ? 'btn--ghost' : '',
    className ?? '',
  ].filter(Boolean).join(' ')

  return (
    <button
      type="button"
      class={classes}
      aria-label={ariaLabel}
      aria-busy={running}
      disabled={disabled || running}
      onClick={async () => {
        if (running) return
        setRunning(true)
        try {
          await onRun()
        }
        finally {
          setRunning(false)
        }
      }}
    >
      {running ? (<><Spinner label={label ?? '处理中'} />{label ?? '处理中'}</>) : children}
    </button>
  )
}

/**
 * A page-level progress bar.
 *
 * Used for loads that replace the whole view, where a spinner in the middle of
 * an empty page feels like a stall. It is a thin rule under the top bar, the
 * way a browser shows a page load.
 */
export function ProgressBar({ active }: { active: boolean }): ComponentChildren {
  if (!active) return null
  return (
    <div class="progress" role="progressbar" aria-label="正在读取">
      <div class="progress__bar" />
    </div>
  )
}

/**
 * A skeleton block, for lists that are about to have rows.
 *
 * Content-shaped placeholders are better than a centred spinner on a phone:
 * nothing jumps when the data arrives, because the space already has the right
 * height.
 */
export function SkeletonRows({ rows = 5 }: { rows?: number }): ComponentChildren {
  return (
    <div class="skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} class="skeleton__row">
          <span class="skeleton__bar" style={{ inlineSize: `${72 - (index % 3) * 12}%` }} />
        </div>
      ))}
    </div>
  )
}
