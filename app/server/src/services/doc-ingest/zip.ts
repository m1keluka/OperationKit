import zlib from 'zlib'

/**
 * Minimal ZIP reader + writer (obj 719936).
 *
 * .xlsx and .docx are ZIP archives of XML. Reading them needs nothing beyond
 * Node's built-in zlib, so the document-ingest starter pack adds no npm
 * dependency and no image rebuild — it works on a fresh install as shipped.
 *
 * Reader: walks the central directory (authoritative sizes, works even when
 * local headers use data descriptors). Supports STORED (0) and DEFLATE (8),
 * which is everything Excel, Word, LibreOffice and Google export.
 * Writer: STORED-or-DEFLATE, used only by tests and the sample-data builder.
 */

const EOCD_SIG = 0x06054b50
const CDH_SIG = 0x02014b50
const LFH_SIG = 0x04034b50

/** Hard caps so a hostile upload (zip bomb) cannot exhaust server memory. */
const MAX_ENTRIES = 5000
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

export class ZipError extends Error {}

export function readZip(buf: Buffer): Map<string, Buffer> {
  // End-of-central-directory sits in the last 22..(22+65535) bytes.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new ZipError('not a zip archive (no end-of-central-directory record)')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  if (count > MAX_ENTRIES) throw new ZipError(`zip has too many entries (${count})`)

  const out = new Map<string, Buffer>()
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDH_SIG) throw new ZipError('corrupt central directory')
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue
    if (size > MAX_ENTRY_BYTES) throw new ZipError(`zip entry too large: ${name}`)
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LFH_SIG) throw new ZipError(`corrupt local header: ${name}`)
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28)
    const raw = buf.subarray(dataStart, dataStart + compSize)
    if (method === 0) out.set(name, Buffer.from(raw))
    else if (method === 8) out.set(name, zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }))
    else throw new ZipError(`unsupported zip compression method ${method} in ${name}`)
  }
  return out
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Build a ZIP from name → content. Deterministic (fixed timestamp). */
export function writeZip(files: Array<[string, string | Buffer]>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const comp = zlib.deflateRawSync(data)
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(LFH_SIG, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(0x0800, 6) // utf-8 names
    lfh.writeUInt16LE(8, 8)
    lfh.writeUInt16LE(0, 10)
    lfh.writeUInt16LE(0x5821, 12) // 2024-01-01
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(comp.length, 18)
    lfh.writeUInt32LE(data.length, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28)
    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(CDH_SIG, 0)
    cdh.writeUInt16LE(20, 4)
    cdh.writeUInt16LE(20, 6)
    cdh.writeUInt16LE(0x0800, 8)
    cdh.writeUInt16LE(8, 10)
    cdh.writeUInt16LE(0, 12)
    cdh.writeUInt16LE(0x5821, 14)
    cdh.writeUInt32LE(crc, 16)
    cdh.writeUInt32LE(comp.length, 20)
    cdh.writeUInt32LE(data.length, 24)
    cdh.writeUInt16LE(nameBuf.length, 28)
    cdh.writeUInt32LE(offset, 42)
    locals.push(lfh, nameBuf, comp)
    centrals.push(cdh, nameBuf)
    offset += 30 + nameBuf.length + comp.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}
