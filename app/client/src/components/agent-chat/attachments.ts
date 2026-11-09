// ── Picking images for the chat composer (obj 900157) ──
//
// A screenshot usually arrives on the clipboard, not as a file the person
// chose, so the composer takes images three ways — paste, drag-and-drop and the
// attach button — and they all land here. The file is read to a data: URL,
// which is both the preview the person sees and (minus the prefix) what goes up
// with the message.
import { ACCEPTED_IMAGE_TYPES, MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES } from './types'

export interface PendingImage {
  /** Local id, so React keys and removal don't depend on the file name. */
  key: string
  name: string
  media_type: string
  size: number
  /** data:<type>;base64,<…> — preview src and wire payload in one. */
  dataUrl: string
}

export function isAcceptedImage(file: { type?: string }): boolean {
  return ACCEPTED_IMAGE_TYPES.includes((file.type || '').toLowerCase())
}

/** Why this file can't be attached, in words the person can act on. */
export function rejectReason(file: { name?: string; type?: string; size?: number }): string | null {
  const label = file.name || 'That file'
  if (!isAcceptedImage(file)) return `${label} is not an image. Attach a PNG, JPEG, GIF or WebP.`
  if ((file.size ?? 0) > MAX_IMAGE_BYTES) return `${label} is too big (5 MB max).`
  return null
}

export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(new Error('That image could not be read.'))
    r.onload = () => resolve(String(r.result ?? ''))
    r.readAsDataURL(file)
  })
}

let seq = 0

/**
 * Turn a FileList (or any File array) into attachments, keeping the first
 * `MAX_IMAGES_PER_MESSAGE - alreadyAttached` images and reporting the first
 * reason anything was left out.
 */
export async function collectImages(
  files: ArrayLike<File>,
  alreadyAttached: number,
): Promise<{ images: PendingImage[]; error: string | null }> {
  const all = Array.from(files)
  const images: PendingImage[] = []
  let error: string | null = null
  let room = Math.max(0, MAX_IMAGES_PER_MESSAGE - alreadyAttached)
  for (const f of all) {
    const why = rejectReason(f)
    if (why) {
      error ??= why
      continue
    }
    if (room === 0) {
      error ??= `You can attach up to ${MAX_IMAGES_PER_MESSAGE} images per message.`
      continue
    }
    room -= 1
    try {
      const dataUrl = await readAsDataUrl(f)
      seq += 1
      images.push({
        key: `img-${Date.now()}-${seq}`,
        // A clipboard paste often has no name at all ("image.png" at best).
        name: f.name || `screenshot-${seq}.png`,
        media_type: (f.type || 'image/png').toLowerCase(),
        size: f.size ?? 0,
        dataUrl,
      })
    } catch {
      error ??= `${f.name || 'That image'} could not be read.`
      room += 1
    }
  }
  return { images, error }
}

/** What POST /agents/:slug/messages wants. */
export function toWireImages(images: PendingImage[]): { name: string; media_type: string; data: string }[] {
  return images.map(i => ({ name: i.name, media_type: i.media_type, data: i.dataUrl }))
}

export function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}
