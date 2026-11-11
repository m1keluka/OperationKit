interface AttachmentChipProps {
  name: string
  size: number
  mimetype?: string
  onRemove?: () => void
}

export function AttachmentChip({ name, size, mimetype, onRemove }: AttachmentChipProps) {
  const isImage = mimetype?.startsWith('image/')
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-gray-300">
      {isImage ? <ImageIcon className="h-3 w-3 shrink-0 text-gray-500" /> : <PaperclipIcon className="h-3 w-3 shrink-0 text-gray-500" />}
      <span className="truncate max-w-[150px]" title={name}>{name}</span>
      <span className="shrink-0 text-gray-500">{formatSize(size)}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded text-gray-500 hover:text-red-400"
          aria-label={`Remove ${name}`}
        >
          ×
        </button>
      )}
    </span>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function PaperclipIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
    </svg>
  )
}

function ImageIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  )
}
