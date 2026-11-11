import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.JWT_SECRET = 'test-secret-attachments-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-chat-attach-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../../db/index.js')
const {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGES_PER_MESSAGE,
  deleteAttachmentsForChat,
  getAttachment,
  imageDataForMessage,
  ImageRejected,
  imagesForMessages,
  parseIncomingImages,
  saveImages,
  sniffImageType,
} = await import('./attachments.js')

/** Smallest real PNG: 1×1 transparent. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})

describe('sniffImageType', () => {
  it('knows the four types we accept and nothing else', () => {
    expect(sniffImageType(PNG)).toBe('image/png')
    expect(sniffImageType(GIF)).toBe('image/gif')
    expect(sniffImageType(JPEG)).toBe('image/jpeg')
    expect(sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('image/webp')
    expect(sniffImageType(Buffer.from('<svg/>'))).toBeNull()
    expect(sniffImageType(Buffer.from('%PDF-1.4'))).toBeNull()
    expect(ALLOWED_IMAGE_TYPES).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
  })
})

describe('parseIncomingImages', () => {
  it('takes a bare base64 string and a data: URL alike', () => {
    const [a] = parseIncomingImages([{ name: 'shot.png', media_type: 'image/png', data: PNG_B64 }])
    const [b] = parseIncomingImages([{ name: 'shot.png', data: `data:image/png;base64,${PNG_B64}` }])
    expect(a.media_type).toBe('image/png')
    expect(b.media_type).toBe('image/png')
    expect(b.data).toBe(a.data)
    expect(a.bytes.equals(PNG)).toBe(true)
  })

  it('no images at all is not an error — a text-only message still works', () => {
    expect(parseIncomingImages(undefined)).toEqual([])
    expect(parseIncomingImages(null)).toEqual([])
    expect(parseIncomingImages([])).toEqual([])
  })

  it('believes the bytes, not the caller: a mislabelled or non-image file is rejected', () => {
    expect(() => parseIncomingImages([{ name: 'x.png', media_type: 'image/png', data: GIF.toString('base64') }]))
      .toThrow(/says it is image\/png but the file is a image\/gif/)
    expect(() => parseIncomingImages([{ name: 'evil.svg', media_type: 'image/svg+xml', data: Buffer.from('<svg onload=alert(1)>').toString('base64') }]))
      .toThrow(/PNG, JPEG, GIF or WebP/)
    // No declared type at all: still has to BE an image.
    expect(() => parseIncomingImages([{ name: 'notes.txt', data: Buffer.from('hello').toString('base64') }]))
      .toThrow(/not a PNG, JPEG, GIF or WebP image/)
  })

  it('caps the count and the size, and names the file that was too big', () => {
    const one = { name: 'a.png', media_type: 'image/png', data: PNG_B64 }
    expect(() => parseIncomingImages(Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => one)))
      .toThrow(/up to 4 images/)
    const huge = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]).toString('base64')
    expect(() => parseIncomingImages([{ name: 'huge.png', media_type: 'image/png', data: huge }])).toThrow(/too big/)
  })

  it('rejects junk shapes with ImageRejected, never a crash', () => {
    expect(() => parseIncomingImages('nope')).toThrow(ImageRejected)
    expect(() => parseIncomingImages([42])).toThrow(ImageRejected)
    expect(() => parseIncomingImages([{ name: 'a.png', data: '' }])).toThrow(ImageRejected)
    expect(() => parseIncomingImages([{ name: 'a.png', media_type: 'image/png', data: 'not base64 !!!' }])).toThrow(ImageRejected)
  })

  it('a clipboard paste with no usable name still gets one, and a path-like name is flattened', () => {
    const [a] = parseIncomingImages([{ data: PNG_B64 }])
    expect(a.name).toMatch(/^screenshot-1\.png$/)
    const [b] = parseIncomingImages([{ name: '../../etc/passwd.png', media_type: 'image/png', data: PNG_B64 }])
    expect(b.name).not.toContain('/')
  })
})

describe('storage', () => {
  it('round-trips bytes, hands back metadata only, and clears with the chat', () => {
    const imgs = parseIncomingImages([{ name: 'shot.png', media_type: 'image/png', data: PNG_B64 }])
    const stored = saveImages(101, 2, 'pa', imgs)
    expect(stored).toHaveLength(1)
    expect(stored[0].url).toBe(`/api/agent-chat/attachments/${stored[0].id}`)
    expect(stored[0].size).toBe(PNG.length)
    expect(stored[0]).not.toHaveProperty('bytes')

    const byMessage = imagesForMessages([101, 999])
    expect(byMessage.get(101)).toHaveLength(1)
    expect(byMessage.has(999)).toBe(false)

    const raw = getAttachment(stored[0].id)!
    expect(raw.user_id).toBe(2)
    expect(raw.bytes.equals(PNG)).toBe(true)

    expect(imageDataForMessage(101)[0]).toEqual({ name: 'shot.png', media_type: 'image/png', data: PNG_B64 })

    expect(deleteAttachmentsForChat(2, 'pa')).toBe(1)
    expect(getAttachment(stored[0].id)).toBeNull()
  })
})
