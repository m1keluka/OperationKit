import type { DesignPin } from './designReview'

export function DesignPins({
  pins,
  onNote,
  onRemove,
  onSend,
  sending,
}: {
  pins: DesignPin[]
  onNote: (id: string, note: string) => void
  onRemove: (id: string) => void
  onSend: () => void
  sending: boolean
}) {
  return (
    <div className="cc-design-pins">
      <div className="cc-design-pins-head">
        <span>{pins.length === 0 ? 'No pins yet' : `${pins.length} queued`}</span>
        <button
          type="button"
          disabled={pins.length === 0 || sending}
          onClick={onSend}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
      <ul>
        {pins.map(p => (
          <li key={p.id}>
            <div className="cc-design-pin-meta">
              <span className="cc-design-pin-kind">{p.kind === 'text' ? 'Text' : 'Comment'}</span>
              <code>{p.selector || p.tag}</code>
              <button type="button" onClick={() => onRemove(p.id)} aria-label="Remove pin">×</button>
            </div>
            {p.kind === 'text' ? (
              <p className="cc-design-pin-text">
                {p.before} → {p.after}
              </p>
            ) : (
              <textarea
                value={p.note}
                onChange={e => onNote(p.id, e.target.value)}
                placeholder="What should change?"
                rows={2}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
