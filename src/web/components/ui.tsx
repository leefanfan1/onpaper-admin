/**
 * Shared UI pieces.
 *
 * Dialogs are native `<dialog>` opened with `showModal()`. The browser supplies
 * the focus trap, the top layer, `Esc`, the back gesture and focus return, so
 * none of that is reimplemented here — a hand-built focus trap is the usual
 * place these panels break for keyboard users.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  title: string
  message: ComponentChildren
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

/**
 * A confirmation dialog.
 *
 * Returns `[element, confirm]`. `confirm(options)` resolves true when the user
 * chooses the destructive action. Cancel is focused by default, so Enter on a
 * destructive dialog does not destroy anything.
 */
export function useConfirm(): [ComponentChildren, (options: ConfirmOptions) => Promise<boolean>] {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const resolver = useRef<((value: boolean) => void) | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const returnValue = useRef<string>('')

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (options && !dialog.open) dialog.showModal()
    if (!options && dialog.open) dialog.close()
  }, [options])

  const confirm = (next: ConfirmOptions): Promise<boolean> => {
    return new Promise(resolve => {
      resolver.current?.(false)
      resolver.current = resolve
      returnValue.current = ''
      setOptions(next)
    })
  }

  const settle = (value: boolean) => {
    resolver.current?.(value)
    resolver.current = null
    setOptions(null)
  }

  const element = (
    <dialog
      ref={dialogRef}
      class="modal"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-message"
      onClose={() => settle(returnValue.current === 'confirm')}
      onCancel={(event) => {
        // Escape is a close request. Resolve false rather than leaving the
        // promise pending until another confirm replaces it.
        event.preventDefault()
        settle(false)
      }}
    >
      {options && (
        <div class="modal__body">
          <h2 id="confirm-title" class="modal__title">{options.title}</h2>
          <div id="confirm-message" class="modal__message">{options.message}</div>
          <div class="modal__actions">
            {/* Cancel takes focus: Enter on a destructive dialog must not delete. */}
            <button
              type="button"
              class="btn"
              autofocus
              onClick={() => { returnValue.current = 'cancel'; dialogRef.current?.close() }}
            >
              {options.cancelLabel ?? '取消'}
            </button>
            <button
              type="button"
              class={options.danger ? 'btn btn--danger' : 'btn btn--primary'}
              onClick={() => { returnValue.current = 'confirm'; dialogRef.current?.close() }}
            >
              {options.confirmLabel ?? '确定'}
            </button>
          </div>
        </div>
      )}
    </dialog>
  )

  return [element, confirm]
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export interface Toast {
  id: number
  tone: 'ok' | 'warn' | 'danger' | 'info'
  message: string
}

let toastSeq = 0

export function useToasts(): {
  toasts: Toast[]
  push: (tone: Toast['tone'], message: string) => void
  dismiss: (id: number) => void
} {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = (id: number) => setToasts(list => list.filter(toast => toast.id !== id))

  const push = (tone: Toast['tone'], message: string) => {
    const id = ++toastSeq
    setToasts(list => [...list, { id, tone, message }])
    // A confirmation is also visible in the row it changed; the toast is the
    // cross-check, so it goes away on its own. Errors stay until dismissed.
    if (tone !== 'danger') {
      setTimeout(() => dismiss(id), 4000)
    }
  }

  return { toasts, push, dismiss }
}

export function ToastStack({ toasts, dismiss }: { toasts: Toast[], dismiss: (id: number) => void }): ComponentChildren {
  return (
    <div class="toasts" role="region" aria-label="通知">
      {toasts.map(toast => (
        <div key={toast.id} class={`toast toast--${toast.tone}`} role="status">
          <span class="toast__text">{toast.message}</span>
          <button type="button" class="toast__close" aria-label="关闭通知" onClick={() => dismiss(toast.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Status marks
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  in_progress: '进行中',
  success: '成功',
  failure: '失败',
  cancelled: '已取消',
  unknown: '待确认',
}

const STATUS_TONE: Record<string, string> = {
  queued: 'warn',
  in_progress: 'info',
  success: 'ok',
  failure: 'danger',
  cancelled: 'muted',
  unknown: 'warn',
}

/**
 * A status as a seal, not a pill.
 *
 * The theme's world is printed matter; a square mark with a rule above it reads
 * as a stamp in the margin, and it carries the same information a coloured dot
 * would without relying on colour alone (the label is always there).
 */
export function StatusMark({ status }: { status: string }): ComponentChildren {
  return (
    <span class={`mark mark--${STATUS_TONE[status] ?? 'muted'}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

export function Empty({
  title,
  children,
  action,
}: {
  title: string
  children?: ComponentChildren
  action?: ComponentChildren
}): ComponentChildren {
  return (
    <div class="empty">
      <p class="empty__title">{title}</p>
      {children && <div class="empty__body">{children}</div>}
      {action && <div class="empty__action">{action}</div>}
    </div>
  )
}

export function Loading({ label = '读取中' }: { label?: string }): ComponentChildren {
  return <p class="loading" role="status">{label}…</p>
}

export function ErrorBox({ error, onRetry }: { error: Error, onRetry?: () => void }): ComponentChildren {
  return (
    <div class="error-box" role="alert">
      <p>{error.message}</p>
      {onRetry && <button type="button" class="btn btn--sm" onClick={onRetry}>重试</button>}
    </div>
  )
}

/** A date as the site writes it: `2026-11-18`. */
export function formatDate(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** A relative time, for task rows where "3 分钟前" matters more than a stamp. */
export function relativeTime(value?: string): string {
  if (!value) return '—'
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return value
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return '刚刚'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天前`
  return formatDate(value)
}

export function duration(between?: number): string {
  if (!between || between < 0) return ''
  const seconds = Math.round(between / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes} 分 ${rest} 秒`
}

export { DialogShell as Dialog }

/**
 * A plain modal dialog for forms and previews (not confirmations).
 *
 * Same native element and the same reason: focus containment, top layer and
 * `Esc` come from the browser.
 */
function DialogShell({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ComponentChildren
  footer?: ComponentChildren
  wide?: boolean
}): ComponentChildren {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      class={wide ? 'modal modal--wide' : 'modal'}
      aria-labelledby="dialog-title"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      {open && (
        <div class="modal__body">
          <div class="modal__head">
            <h2 id="dialog-title" class="modal__title">{title}</h2>
            <button type="button" class="btn btn--ghost btn--sm" onClick={onClose} aria-label="关闭">×</button>
          </div>
          <div class="modal__content">{children}</div>
          {footer && <div class="modal__actions">{footer}</div>}
        </div>
      )}
    </dialog>
  )
}
