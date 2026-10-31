import zlib from 'zlib'

/**
 * Reading big chat exports without big strings (obj 720117).
 *
 * A Claude or ChatGPT export with thousands of chats has a conversations.json
 * of hundreds of MB — past doc-ingest's 64 MB per-entry zip cap, and close to
 * V8's ~512 MB string limit. So here we inflate only the one entry we need
 * (with a far higher cap, ZIP64 sizes included) and walk the top-level JSON
 * array byte by byte, parsing one chat at a time. Peak memory is the inflated
 * buffer plus one chat, never one giant string or one giant object tree.
 */

const EOCD_SIG = 0x06054b50
const CDH_SIG = 0x02014b50
const LFH_SIG = 0x04034b50
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50
const ZIP64_EOCD_SIG = 0x06064b50

/** 1 GB: the largest inflated conversations.json we will hold in memory (a zip bomb stops here). */
export const MAX_EXPORT_ENTRY_BYTES = 1024 * 1024 * 1024

export class ExportReadError extends Error {}

interface CentralEntry { name: string; method: number; compSize: number; size: number; localOff: number }

function readU64(buf: Buffer, off: number): number {
  return Number(buf.readBigUInt64LE(off))
}

function centralDirectory(buf: Buffer): { count: number; offset: number } {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new ExportReadError('not a zip archive')
  let count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  // ZIP64: the classic record holds 0xFFFF/0xFFFFFFFF and a locator sits just before it.
  const loc = eocd - 20
  if ((count === 0xffff || offset === 0xffffffff) && loc >= 0 && buf.readUInt32LE(loc) === ZIP64_EOCD_LOCATOR_SIG) {
    const z = readU64(buf, loc + 8)
    if (z + 56 <= buf.length && buf.readUInt32LE(z) === ZIP64_EOCD_SIG) {
      count = readU64(buf, z + 32)
      offset = readU64(buf, z + 48)
    }
  }
  return { count, offset }
}

function listEntries(buf: Buffer): CentralEntry[] {
  const { count, offset } = centralDirectory(buf)
  const out: CentralEntry[] = []
  let p = offset
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDH_SIG) throw new ExportReadError('corrupt zip directory')
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    let size = buf.readUInt32LE(p + 24)
    let compSize = buf.readUInt32LE(p + 20)
    let localOff = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    // ZIP64 extra field (id 0x0001) carries whichever sizes overflowed, in this order.
    for (let e = p + 46 + nameLen; e + 4 <= p + 46 + nameLen + extraLen;) {
      const id = buf.readUInt16LE(e)
      const len = buf.readUInt16LE(e + 2)
      if (id === 0x0001) {
        let q = e + 4
        if (size === 0xffffffff) { size = readU64(buf, q); q += 8 }
        if (compSize === 0xffffffff) { compSize = readU64(buf, q); q += 8 }
        if (localOff === 0xffffffff) { localOff = readU64(buf, q) }
      }
      e += 4 + len
    }
    out.push({ name, method: buf.readUInt16LE(p + 10), compSize, size, localOff })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** Names of the files inside a zip. */
export function zipEntryNames(buf: Buffer): string[] {
  return listEntries(buf).map(e => e.name).filter(n => !n.endsWith('/'))
}

/** Inflate ONE entry (the shortest path whose name matches). Null when none matches. */
export function readZipEntry(buf: Buffer, match: (name: string) => boolean, maxBytes = MAX_EXPORT_ENTRY_BYTES): { name: string; data: Buffer } | null {
  const hit = listEntries(buf).filter(e => !e.name.endsWith('/') && match(e.name)).sort((a, b) => a.name.length - b.name.length)[0]
  if (!hit) return null
  if (hit.size > maxBytes) throw new ExportReadError(`${hit.name} is too large to read (${Math.round(hit.size / 1048576)} MB)`)
  if (hit.localOff + 30 > buf.length || buf.readUInt32LE(hit.localOff) !== LFH_SIG) throw new ExportReadError(`corrupt zip entry: ${hit.name}`)
  const start = hit.localOff + 30 + buf.readUInt16LE(hit.localOff + 26) + buf.readUInt16LE(hit.localOff + 28)
  const raw = buf.subarray(start, start + hit.compSize)
  if (hit.method === 0) return { name: hit.name, data: Buffer.from(raw) }
  if (hit.method === 8) return { name: hit.name, data: zlib.inflateRawSync(raw, { maxOutputLength: maxBytes }) }
  throw new ExportReadError(`unsupported zip compression in ${hit.name}`)
}

const WS = new Set([0x20, 0x09, 0x0a, 0x0d])

/**
 * Yield each element of a top-level JSON array, parsed one at a time.
 * Throws ExportReadError when the buffer is not a JSON array or is cut short.
 */
export function* jsonArrayElements(buf: Buffer): Generator<unknown> {
  let i = 0
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3 // UTF-8 BOM
  while (i < buf.length && WS.has(buf[i])) i++
  if (buf[i] !== 0x5b /* [ */) throw new ExportReadError('not a JSON list')
  i++
  for (;;) {
    while (i < buf.length && (WS.has(buf[i]) || buf[i] === 0x2c /* , */)) i++
    if (i >= buf.length) throw new ExportReadError('the file ends in the middle of the list')
    if (buf[i] === 0x5d /* ] */) return
    const start = i
    let depth = 0
    let inStr = false
    for (; i < buf.length; i++) {
      const c = buf[i]
      if (inStr) {
        if (c === 0x5c) i++
        else if (c === 0x22) inStr = false
        continue
      }
      if (c === 0x22) inStr = true
      else if (c === 0x7b || c === 0x5b) depth++
      else if (c === 0x7d || c === 0x5d) {
        if (depth === 0) break // end of the outer array right after a scalar
        if (--depth === 0) { i++; break }
      } else if (depth === 0 && c === 0x2c) break
    }
    if (depth !== 0 || inStr) throw new ExportReadError('the file ends in the middle of a chat')
    const text = buf.subarray(start, i).toString('utf8').trim()
    try { yield JSON.parse(text) } catch { throw new ExportReadError('a chat in the list is damaged') }
  }
}
