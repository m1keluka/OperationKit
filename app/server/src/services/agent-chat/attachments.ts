// ── Images in the built-in agent chat (obj 900157) ──
//
// Casey pasted a screenshot into the chat and the agent answered that it could
// not open screenshots. Nothing was broken in an upload endpoint — the chat had
// no image path at all: the composer was a bare textarea, the POST route read
// only `text`, and the history the model saw was plain strings.
//
// An image arrives as base64 on the message POST (a screenshot paste has no file
// on disk to point at, so there is nothing to multipart). It is validated here —
// declared type must be in the allowlist AND must match the actual magic bytes —
// then stored as bytes in this install's own database next to the message it
// belongs to, exactly like the message text. It is handed back to the browser
// through one owner-checked route and handed to the model as a real image
// content block.
import { getDb } from '../../db/index.js'
import { lanePredicate, laneThreadId, MAIN_LANE, type ChatLane } from './threads.js'

export const MAX_IMAGES_PER_MESSAGE = 4
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** Types every vision model we talk to accepts, and a browser renders inline. */
export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number]

/** What the browser sends: base64 (bare or as a data: URL). */
export interface IncomingImage {
  name: string
  media_type: AllowedImageType
  /** Bare base64, no data: prefix. */
  data: string
  bytes: Buffer
}

/** What the browser gets back, and what the UI renders. */
export interface StoredImage {
  id: number
  name: string
  media_type: string
  size: number
  url: string
}

/** A rejected attachment — the route turns this into a 400 the person can act on. */
export class ImageRejected extends Error {}

const DATA_URL = /^data:([a-zA-Z0-9.+/-]+);base64,/

/** The real type of these bytes, by magic number — never the caller's word for it. */
export function sniffImageType(b: Buffer): AllowedImageType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && b.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/)) return 'image/gif'
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

function cleanName(raw: unknown, fallback: string): string {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return fallback
  // A name is only ever shown as a label; strip anything path-like.
  return s.replace(/[\\/]/g, '_').slice(0, 120)
}

function parseOne(raw: unknown, index: number): IncomingImage {
  if (!raw || typeof raw !== 'object') throw new ImageRejected('Each image must be an object with a data field.')
  const o = raw as Record<string, unknown>
  let b64 = typeof o.data === 'string' ? o.data.trim() : ''
  if (!b64) throw new ImageRejected('An attached image had no data.')
  let declared = typeof o.media_type === 'string' ? o.media_type.trim().toLowerCase() : ''
  const m = DATA_URL.exec(b64)
  if (m) {
    if (!declared) declared = m[1].toLowerCase()
    b64 = b64.slice(m[0].length)
  }
  b64 = b64.replace(/\s+/g, '')
  if (declared === 'image/jpg') declared = 'image/jpeg'
  if (declared && !(ALLOWED_IMAGE_TYPES as readonly string[]).includes(declared)) {
    throw new ImageRejected(`${cleanName(o.name, `Image ${index + 1}`)} is a ${declared}. Attach a PNG, JPEG, GIF or WebP.`)
  }
  // Reject before decoding: base64 is ~4/3 of the bytes, so this also caps memory.
  if (b64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) {
    throw new ImageRejected(`${cleanName(o.name, `Image ${index + 1}`)} is too big (5 MB max).`)
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new ImageRejected('An attached image was not valid base64.')
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.length === 0) throw new ImageRejected('An attached image was empty.')
  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageRejected(`${cleanName(o.name, `Image ${index + 1}`)} is too big (5 MB max).`)
  const sniffed = sniffImageType(bytes)
  if (!sniffed) throw new ImageRejected(`${cleanName(o.name, `Image ${index + 1}`)} is not a PNG, JPEG, GIF or WebP image.`)
  if (declared && declared !== sniffed) {
    throw new ImageRejected(`${cleanName(o.name, `Image ${index + 1}`)} says it is ${declared} but the file is a ${sniffed}.`)
  }
  const ext = sniffed.split('/')[1].replace('jpeg', 'jpg')
  return {
    name: cleanName(o.name, `screenshot-${index + 1}.${ext}`),
    media_type: sniffed,
    // Re-encode from the decoded bytes so what we store, serve and send to the
    // model is byte-identical and canonically padded.
    data: bytes.toString('base64'),
    bytes,
  }
}

/** Validate the `images` field of a message POST. Throws ImageRejected. */
export function parseIncomingImages(raw: unknown): IncomingImage[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new ImageRejected('images must be a list.')
  if (raw.length > MAX_IMAGES_PER_MESSAGE) {
    throw new ImageRejected(`Attach up to ${MAX_IMAGES_PER_MESSAGE} images per message.`)
  }
  return raw.map(parseOne)
}

export function attachmentUrl(id: number): string {
  return `/api/agent-chat/attachments/${id}`
}

function toStored(r: Record<string, unknown>): StoredImage {
  const id = Number(r.id)
  return { id, name: String(r.name ?? 'image'), media_type: String(r.media_type), size: Number(r.size ?? 0), url: attachmentUrl(id) }
}

export function saveImages(
  messageId: number,
  userId: number,
  slug: string,
  images: IncomingImage[],
  /** The lane the owning message is in (obj 900370). Main conversation by default. */
  lane: ChatLane = MAIN_LANE,
): StoredImage[] {
  if (images.length === 0) return []
  const db = getDb()
  const insert = db.prepare(
    'INSERT INTO agent_chat_attachments (message_id, user_id, agent_slug, name, media_type, size, bytes, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const out: StoredImage[] = []
  for (const img of images) {
    const info = insert.run(messageId, userId, slug, img.name, img.media_type, img.bytes.length, img.bytes, laneThreadId(lane))
    out.push({ id: Number(info.lastInsertRowid), name: img.name, media_type: img.media_type, size: img.bytes.length, url: attachmentUrl(Number(info.lastInsertRowid)) })
  }
  return out
}

/** Metadata (never the bytes) for a page of messages, keyed by message id. */
export function imagesForMessages(messageIds: number[]): Map<number, StoredImage[]> {
  const out = new Map<number, StoredImage[]>()
  if (messageIds.length === 0) return out
  const ph = messageIds.map(() => '?').join(',')
  const rows = getDb()
    .prepare(`SELECT id, message_id, name, media_type, size FROM agent_chat_attachments WHERE message_id IN (${ph}) ORDER BY id`)
    .all(...messageIds) as Record<string, unknown>[]
  for (const r of rows) {
    const mid = Number(r.message_id)
    const list = out.get(mid) ?? []
    list.push(toStored(r))
    out.set(mid, list)
  }
  return out
}

/** The bytes, for the one route that serves them. Owner check is the caller's. */
export function getAttachment(id: number): { id: number; user_id: number; name: string; media_type: string; bytes: Buffer } | null {
  const r = getDb().prepare('SELECT id, user_id, name, media_type, bytes FROM agent_chat_attachments WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  if (!r) return null
  return {
    id: Number(r.id),
    user_id: Number(r.user_id),
    name: String(r.name ?? 'image'),
    media_type: String(r.media_type),
    bytes: Buffer.isBuffer(r.bytes) ? r.bytes : Buffer.from(r.bytes as Uint8Array),
  }
}

/** base64 for the model, for one message's images. */
export function imageDataForMessage(messageId: number): { media_type: string; data: string; name: string }[] {
  const rows = getDb()
    .prepare('SELECT name, media_type, bytes FROM agent_chat_attachments WHERE message_id = ? ORDER BY id')
    .all(messageId) as Record<string, unknown>[]
  return rows.map(r => ({
    name: String(r.name ?? 'image'),
    media_type: String(r.media_type),
    data: (Buffer.isBuffer(r.bytes) ? r.bytes : Buffer.from(r.bytes as Uint8Array)).toString('base64'),
  }))
}

/**
 * Drop the images of ONE lane (obj 900370) — the main conversation unless a side
 * thread is named. Scoped by the same lane predicate the messages use, so
 * "Clear this conversation" in a side thread cannot take the main chat's
 * screenshots with it.
 */
export function deleteAttachmentsForChat(userId: number, slug: string, lane: ChatLane = MAIN_LANE): number {
  const { sql, params } = lanePredicate(lane)
  return getDb()
    .prepare(`DELETE FROM agent_chat_attachments WHERE user_id = ? AND agent_slug = ? AND ${sql}`)
    .run(userId, slug, ...params).changes
}
