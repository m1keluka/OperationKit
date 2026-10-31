import { describe, it, expect } from 'vitest'
import { writeZip } from '../doc-ingest/zip.js'
import { jsonArrayElements, readZipEntry, zipEntryNames, ExportReadError } from './export-reader.js'

describe('jsonArrayElements', () => {
  it('yields each element without parsing the whole list at once', () => {
    const items = [{ a: 1, s: 'x, ] } [ "quoted"' }, [1, [2]], 'str,ing', 3, null, { nested: { deep: ['}'] } }]
    const buf = Buffer.from(`﻿  ${JSON.stringify(items, null, 2)}\n`)
    expect([...jsonArrayElements(buf)]).toEqual(items)
  })
  it('handles an empty list and escaped quotes', () => {
    expect([...jsonArrayElements(Buffer.from('[]'))]).toEqual([])
    expect([...jsonArrayElements(Buffer.from('[{"t":"say \\"hi\\""}]'))]).toEqual([{ t: 'say "hi"' }])
  })
  it('rejects things that are not a list, and lists cut short', () => {
    expect(() => [...jsonArrayElements(Buffer.from('{"a":1}'))]).toThrow(ExportReadError)
    expect(() => [...jsonArrayElements(Buffer.from('[{"a":1},{"b":'))]).toThrow(ExportReadError)
  })
  it('streams thousands of chats', () => {
    const many = Array.from({ length: 5000 }, (_, n) => ({ uuid: `u${n}`, name: `Chat ${n}`, chat_messages: [{ sender: 'human', text: `hello ${n}` }] }))
    let count = 0
    for (const el of jsonArrayElements(Buffer.from(JSON.stringify(many)))) { expect((el as { uuid: string }).uuid).toBe(`u${count}`); count++ }
    expect(count).toBe(5000)
  })
})

describe('readZipEntry', () => {
  it('inflates only the matching entry, shortest path first', () => {
    const zip = writeZip([['nested/conversations.json', '[1]'], ['conversations.json', '[2]'], ['users.json', '{}']])
    expect(zipEntryNames(zip).sort()).toEqual(['conversations.json', 'nested/conversations.json', 'users.json'])
    const hit = readZipEntry(zip, n => /(^|\/)conversations\.json$/.test(n))
    expect(hit?.name).toBe('conversations.json')
    expect(hit?.data.toString()).toBe('[2]')
    expect(readZipEntry(zip, n => n === 'missing.json')).toBeNull()
  })
  it('reads an entry larger than the 64 MB document cap', () => {
    const big = Buffer.alloc(70 * 1024 * 1024, 0x20)
    big.write('[{"ok":true}]', 0)
    const zip = writeZip([['conversations.json', big]])
    const hit = readZipEntry(zip, n => n === 'conversations.json')!
    expect(hit.data.length).toBe(big.length)
    expect([...jsonArrayElements(hit.data)]).toEqual([{ ok: true }])
  })
  it('refuses an entry over the cap', () => {
    const zip = writeZip([['conversations.json', Buffer.alloc(2048, 0x20)]])
    expect(() => readZipEntry(zip, () => true, 1024)).toThrow(/too large/)
  })
})
