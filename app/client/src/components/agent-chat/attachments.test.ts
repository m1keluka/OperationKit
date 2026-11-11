import { describe, it, expect } from 'vitest'
import { collectImages, rejectReason, toWireImages, humanSize } from './attachments'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const png = (name = 'a.png') => new File([Uint8Array.from(atob(PNG_B64), c => c.charCodeAt(0))], name, { type: 'image/png' })

describe('composer attachments (obj 900157)', () => {
  it('names the reason a file cannot be attached', () => {
    expect(rejectReason(png())).toBeNull()
    expect(rejectReason({ name: 'notes.txt', type: 'text/plain', size: 10 })).toMatch(/not an image/)
    expect(rejectReason({ name: 'huge.png', type: 'image/png', size: 6 * 1024 * 1024 })).toMatch(/too big/)
    expect(rejectReason({ name: 'd.svg', type: 'image/svg+xml', size: 10 })).toMatch(/not an image/)
  })

  it('reads images to data: URLs and keeps the per-message cap', async () => {
    const r = await collectImages([png('1.png'), png('2.png')], 0)
    expect(r.error).toBeNull()
    expect(r.images).toHaveLength(2)
    expect(r.images[0].dataUrl).toBe(`data:image/png;base64,${PNG_B64}`)
    expect(r.images[0].key).not.toBe(r.images[1].key)

    const full = await collectImages([png(), png()], 3)
    expect(full.images).toHaveLength(1)
    expect(full.error).toMatch(/up to 4 images/)
  })

  it('keeps the good images and reports the first thing it skipped', async () => {
    const r = await collectImages([new File(['x'], 'x.pdf', { type: 'application/pdf' }), png('ok.png')], 0)
    expect(r.images.map(i => i.name)).toEqual(['ok.png'])
    expect(r.error).toMatch(/not an image/)
  })

  it('a clipboard image with no name still gets one', async () => {
    const blob = new File([Uint8Array.from(atob(PNG_B64), c => c.charCodeAt(0))], '', { type: 'image/png' })
    const r = await collectImages([blob], 0)
    expect(r.images[0].name).toMatch(/^screenshot-\d+\.png$/)
  })

  it('the wire shape is what the server route expects', async () => {
    const r = await collectImages([png('shot.png')], 0)
    expect(toWireImages(r.images)).toEqual([{ name: 'shot.png', media_type: 'image/png', data: `data:image/png;base64,${PNG_B64}` }])
  })

  it('shows a readable size', () => {
    expect(humanSize(512)).toBe('512 B')
    expect(humanSize(2048)).toBe('2 KB')
    expect(humanSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
