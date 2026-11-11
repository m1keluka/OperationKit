import { useCallback, useRef, useState, type ReactNode } from 'react'
import { Modal } from './Modal'
import { Button } from './Button'

/* ─────────────────────────────────────────────────────────
   ConfirmDialog + useConfirm — the in-app, themed replacement for
   native window.confirm() (audit OK-28). The native OS dialog blocks
   the thread and looks nothing like Mission Control; this renders the
   same question on a token-bound Modal with proper focus/Esc handling.

   Drop-in usage (turns the imperative `if (confirm(...))` into await):

     const { confirm, confirmDialog } = useConfirm()
     ...
     if (await confirm({ title: 'Delete objective?', message: '…', danger: true }))
       doDelete()
     ...
     return (<>{ ...page... }{confirmDialog}</>)
   ───────────────────────────────────────────────────────── */

export interface ConfirmOptions {
  title: string
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

interface State extends ConfirmOptions {
  open: boolean
}

export function useConfirm() {
  const [state, setState] = useState<State>({ open: false, title: '' })
  const resolver = useRef<((v: boolean) => void) | null>(null)

  const confirm = useCallback((opts: ConfirmOptions) => {
    setState({ ...opts, open: true })
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
    })
  }, [])

  const settle = useCallback((v: boolean) => {
    resolver.current?.(v)
    resolver.current = null
    setState((s) => ({ ...s, open: false }))
  }, [])

  const confirmDialog = (
    <ConfirmDialog
      {...state}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  )

  return { confirm, confirmDialog }
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  onConfirm,
  onCancel,
}: State & { onConfirm: () => void; onCancel: () => void }) {
  return (
    <Modal open={open} onClose={onCancel} variant="center" labelledBy="confirm-title" describedBy={message ? 'confirm-desc' : undefined} panelClassName="max-w-sm">
      <div className="p-5">
        <h2 id="confirm-title" className="font-display text-[15px] font-semibold tracking-[-0.01em] text-fg-0">
          {title}
        </h2>
        {message && <p id="confirm-desc" className="mt-2 text-[13px] leading-relaxed text-fg-2">{message}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} size="sm" onClick={onConfirm} data-autofocus>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
