import { useCallback, useRef, useState, type DragEvent } from 'react'

function transferHasFiles(types: readonly string[] | DOMStringList | undefined): boolean {
  if (!types) return false
  return Array.from(types as ArrayLike<string>).includes('Files')
}

/** True when this drag is a file drop, not text/HTML from the page. */
export function dragHasFiles(e: { dataTransfer?: { types?: readonly string[] | DOMStringList | null } | null }): boolean {
  return transferHasFiles(e.dataTransfer?.types ?? undefined)
}

export function filesFromClipboard(e: { clipboardData?: DataTransfer | null }): FileList | null {
  const files = e.clipboardData?.files
  return files && files.length > 0 ? files : null
}

/**
 * Drag-and-drop of files onto a composer (or any attach surface).
 * Uses an enter/leave depth counter so moving across children does not flicker.
 */
export function useFileDrop(onFiles: (files: FileList) => void, enabled = true) {
  const [isDragging, setIsDragging] = useState(false)
  const depth = useRef(0)

  const reset = useCallback(() => {
    depth.current = 0
    setIsDragging(false)
  }, [])

  const onDragEnter = useCallback(
    (e: DragEvent<HTMLElement>) => {
      if (!enabled || !dragHasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      depth.current += 1
      setIsDragging(true)
    },
    [enabled],
  )

  const onDragOver = useCallback(
    (e: DragEvent<HTMLElement>) => {
      if (!enabled || !dragHasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
    },
    [enabled],
  )

  const onDragLeave = useCallback(
    (e: DragEvent<HTMLElement>) => {
      if (!enabled) return
      e.preventDefault()
      e.stopPropagation()
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setIsDragging(false)
    },
    [enabled],
  )

  const onDrop = useCallback(
    (e: DragEvent<HTMLElement>) => {
      if (!enabled) return
      e.preventDefault()
      e.stopPropagation()
      reset()
      const files = e.dataTransfer?.files
      if (files && files.length > 0) onFiles(files)
    },
    [enabled, onFiles, reset],
  )

  return {
    isDragging,
    dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}
