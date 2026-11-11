/**
 * Keyboard shortcuts cheatsheet — extracted from DevelopmentPage.tsx
 * (behavior frozen).
 */
import { Modal } from '../ui'

export function KeyboardHelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} variant="center" panelClassName="max-w-md">
      <div className="p-4">
        <h2 className="mb-3 font-display text-[16px] font-semibold text-fg-0">Keyboard shortcuts</h2>
        <dl className="grid grid-cols-[70px_1fr] gap-y-1.5 text-[12.5px]">
          {[
            ['j / k', 'Move row selection'],
            ['enter / o', 'Open the drawer'],
            ['esc', 'Close drawer, then clear selection'],
            ['x', 'Toggle the row checkbox'],
            ['1–6', 'Jump to a tab'],
            ['/', 'Focus search'],
            ['t', 'Triage the focused row (rank from impact/effort)'],
            ['p', 'Promote to an objective'],
            ['e', 'Decline (confirm)'],
            ['⌘/ctrl+enter', 'Post a note in the drawer'],
            ['?', 'This cheatsheet'],
          ].map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-[11.5px] text-accent-hover">{k}</dt>
              <dd className="text-fg-1">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-[11.5px] text-fg-3">Shortcuts are suppressed while a text field has focus.</p>
      </div>
    </Modal>
  )
}
