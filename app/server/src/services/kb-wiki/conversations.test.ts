import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { writeZip } from '../doc-ingest/zip.js'
import {
  conversationChars, detectImportKind, parseChatGptExport, parseClaudeExport, parseSpeakerLines, parseTranscript, renderConversationMarkdown,
} from './conversations.js'

const SAMPLES = path.join(path.dirname(new URL(import.meta.url).pathname), 'sample-data')
const sample = (n: string) => fs.readFileSync(path.join(SAMPLES, n))

describe('detectImportKind', () => {
  it('tells the sample files apart', () => {
    expect(detectImportKind('claude-export-sample.zip', sample('claude-export-sample.zip'))).toBe('claude-export')
    expect(detectImportKind('chatgpt-export-sample.zip', sample('chatgpt-export-sample.zip'))).toBe('chatgpt-export')
    expect(detectImportKind('call-2026-09-14-supplier-review.vtt', sample('call-2026-09-14-supplier-review.vtt'))).toBe('transcript')
    expect(detectImportKind('call-2026-09-28-client-walkthrough.json', sample('call-2026-09-28-client-walkthrough.json'))).toBe('transcript')
  })
  it('recognises an unzipped conversations.json and rejects unknown files', () => {
    expect(detectImportKind('conversations.json', Buffer.from(JSON.stringify([{ mapping: {} }])))).toBe('chatgpt-export')
    expect(detectImportKind('conversations.json', Buffer.from(JSON.stringify([{ chat_messages: [] }])))).toBe('claude-export')
    expect(detectImportKind('photo.png', Buffer.from('x'))).toBeNull()
    expect(detectImportKind('other.zip', writeZip([['a.txt', 'hi']]))).toBeNull()
    expect(detectImportKind('broken.json', Buffer.from('{nope'))).toBeNull()
  })
})

describe('parseClaudeExport', () => {
  const convs = parseClaudeExport(sample('claude-export-sample.zip'))
  it('reads every chat with stable keys and You/Claude speakers', () => {
    expect(convs.map(c => c.key)).toEqual(['c0001', 'c0002', 'c0003', 'c0004', 'c0005', 'c0006'])
    expect(convs[0].title).toBe('Spring opening plan')
    expect(convs[0].origin).toBe('claude')
    expect(convs[0].started_at).toBe('2026-02-03T09:12:00.000Z')
    expect(convs[0].participants).toEqual(['You', 'Claude'])
    expect(convs[0].messages[2].text).toMatch(/Saturday 14 March/)
  })
  it('falls back to content blocks and keeps attached file text', () => {
    expect(convs[2].messages[0].text).toMatch(/Priya Nair does our books/)
    expect(convs[1].messages[0].text).toMatch(/\[Attached file: hillcrest-sites.txt\]\nHillcrest sites: Maple Court/)
  })
  it('drops chats with no text and throws a plain message on a bad zip', () => {
    const z = writeZip([['conversations.json', JSON.stringify([{ uuid: 'x', name: 'empty', chat_messages: [] }, { uuid: 'y', name: '', chat_messages: [{ sender: 'human', text: 'hello' }] }])]])
    const out = parseClaudeExport(z)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ key: 'c0001', title: 'Untitled chat' })
    expect(() => parseClaudeExport(writeZip([['notes.txt', 'x']]))).toThrow(/no conversations.json/)
    expect(() => parseClaudeExport(writeZip([['conversations.json', '[{broken']]))).toThrow(/damaged/)
    expect(() => parseClaudeExport(writeZip([['conversations.json', '{"a":1}']]))).toThrow(/not a list of chats/)
  })
})

describe('parseChatGptExport', () => {
  const convs = parseChatGptExport(sample('chatgpt-export-sample.zip'))
  it('walks current_node back to the root: the edited-away branch and hidden system node are dropped', () => {
    const c = convs[0]
    expect(c.title).toBe('Greenway Growers late deliveries')
    const all = c.messages.map(m => m.text).join('\n')
    expect(all).not.toMatch(/OLD BRANCH/)
    expect(all).not.toMatch(/helpful assistant/)
    expect(c.messages.map(m => m.speaker)).toEqual(['You', 'ChatGPT', 'You', 'ChatGPT'])
    expect(c.messages[2].text).toMatch(/one more month/)
    expect(c.started_at).toBe('2026-03-24T10:00:00.000Z')
  })
  it('skips code-interpreter calls and tool output', () => {
    const sales = convs.find(c => c.title === 'Plant sales by month')!
    const all = sales.messages.map(m => m.text).join('\n')
    expect(all).not.toMatch(/sales = \{/)
    expect(all).toMatch(/August dropped the most/)
    expect(sales.messages).toHaveLength(3)
  })
  it('uses the newest leaf when current_node is missing', () => {
    const conv = {
      id: 'x', title: 'branchy', create_time: 1700000000,
      mapping: {
        r: { id: 'r', message: null, parent: null, children: ['a'] },
        a: { id: 'a', parent: 'r', children: ['b1', 'b2'], message: { author: { role: 'user' }, create_time: 1700000001, content: { content_type: 'text', parts: ['question'] } } },
        b1: { id: 'b1', parent: 'a', children: [], message: { author: { role: 'assistant' }, create_time: 1700000002, content: { content_type: 'text', parts: ['first answer'] } } },
        b2: { id: 'b2', parent: 'a', children: [], message: { author: { role: 'assistant' }, create_time: 1700000009, content: { content_type: 'text', parts: ['regenerated answer'] } } },
      },
    }
    const [c] = parseChatGptExport(Buffer.from(JSON.stringify([conv])))
    expect(c.messages.map(m => m.text)).toEqual(['question', 'regenerated answer'])
  })
})

describe('parseTranscript', () => {
  it('reads .vtt voice tags, merging one speaker across cues', () => {
    const [c] = parseTranscript('call-2026-09-14-supplier-review.vtt', sample('call-2026-09-14-supplier-review.vtt'))
    expect(c.origin).toBe('call')
    expect(c.started_at).toBe('2026-09-14T00:00:00.000Z')
    expect(c.title).toBe('call-2026-09-14-supplier-review')
    expect(c.participants).toEqual(['Rosa Delgado', 'Tom Whitfield', 'Sam Okafor'])
    expect(c.messages[1]).toMatchObject({ speaker: 'Tom Whitfield', at: '0:09' })
    expect(c.messages[1].text).toMatch(/better than March\. The fixed Tuesday slot/)
    expect(c.messages.map(m => m.text).join(' ')).not.toMatch(/<v|WEBVTT|NOTE Supplier/)
  })
  it('reads .srt Name: lines', () => {
    const [c] = parseTranscript('call-2026-09-21-weekly-ops.srt', sample('call-2026-09-21-weekly-ops.srt'))
    expect(c.participants).toContain('Jo Fairweather')
    expect(c.messages[1]).toMatchObject({ speaker: 'Rosa Delgado', at: '0:10' })
    expect(c.messages[1].text).toMatch(/we quoted\. First visit/)
  })
  it('reads the generic JSON format (object or list)', () => {
    const [c] = parseTranscript('call-2026-09-28-client-walkthrough.json', sample('call-2026-09-28-client-walkthrough.json'))
    expect(c.title).toBe('Hillcrest grounds walkthrough')
    expect(c.participants).toEqual(['Rosa Delgado', 'Jo Fairweather', 'Marcus Bell'])
    expect(c.notes).toMatch(/six Hillcrest/)
    expect(c.messages[2]).toMatchObject({ speaker: 'Marcus Bell', at: '0:26' })
    const many = parseTranscript('calls.json', Buffer.from(JSON.stringify([
      { title: 'A', date: '2026-01-02', utterances: [{ speaker_name: 'Ann', raw_text: 'hi', start_time: '01:05' }] },
      { title: 'B', sentences: [{ speaker: { name: 'Bo' }, text: 'yo', start: 3725 }] },
    ])))
    expect(many.map(c => c.key)).toEqual(['c0001', 'c0002'])
    expect(many[0].messages[0]).toEqual({ speaker: 'Ann', text: 'hi', at: '1:05' })
    expect(many[1].messages[0].at).toBe('1:02:05')
    expect(() => parseTranscript('x.json', Buffer.from('{"title":"nothing"}'))).toThrow(/no transcript lines/)
  })
  it('reads .txt in Name:, [time] Name: and Otter styles, with header lines', () => {
    const txt = [
      'Title: Crew huddle',
      'Date: 2026-10-01',
      '',
      '[00:00:05] Jo Fairweather: Morning.',
      '(00:01:10) Sam Okafor: Bulbs arrive Tuesday.',
      'Rosa Delgado: Good.',
      'And one more line from Rosa.',
    ].join('\n')
    const [c] = parseTranscript('huddle.txt', Buffer.from(txt))
    expect(c.title).toBe('Crew huddle')
    expect(c.started_at).toBe('2026-10-01T00:00:00.000Z')
    expect(c.messages).toEqual([
      { speaker: 'Jo Fairweather', text: 'Morning.', at: '0:05' },
      { speaker: 'Sam Okafor', text: 'Bulbs arrive Tuesday.', at: '1:10' },
      { speaker: 'Rosa Delgado', text: 'Good.\nAnd one more line from Rosa.', at: undefined },
    ])
    const otter = parseSpeakerLines('Rosa Delgado  0:03\nHello there.\nSee you at 5:30\n\nSam Okafor  0:10\nHi Rosa.')
    expect(otter.messages.map(m => [m.speaker, m.at])).toEqual([['Rosa Delgado', '0:03'], ['Sam Okafor', '0:10']])
    expect(otter.messages[0].text).toBe('Hello there.\nSee you at 5:30')
  })
  it('reads .md with frontmatter; a body with no speakers becomes notes', () => {
    const md = '---\ntitle: Ops sync\ndate: 2026-10-02\nparticipants: [Rosa Delgado, Sam Okafor]\n---\n# Ops sync\n\n**Rosa Delgado:** Morning.\n**Sam Okafor:** Hi.\n'
    const [c] = parseTranscript('2026-10-02-ops.md', Buffer.from(md))
    expect(c).toMatchObject({ title: 'Ops sync', started_at: '2026-10-02T00:00:00.000Z', participants: ['Rosa Delgado', 'Sam Okafor'] })
    expect(c.messages.map(m => m.speaker)).toEqual(['Rosa Delgado', 'Sam Okafor'])
    const [n] = parseTranscript('2026-10-03 notes.md', Buffer.from('We talked about the bulb display.\nNo decisions yet.'))
    expect(n.messages).toEqual([])
    expect(n.notes).toMatch(/bulb display/)
    expect(n.started_at).toBe('2026-10-03T00:00:00.000Z')
  })
  it('reads .docx through the Word extractor', () => {
    const docx = writeZip([['word/document.xml', '<w:document><w:body>' +
      '<w:p><w:r><w:t>Rosa Delgado: We order on Monday.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Sam Okafor: I will do it.</w:t></w:r></w:p></w:body></w:document>']])
    const [c] = parseTranscript('call.docx', docx)
    expect(c.messages.map(m => m.speaker)).toEqual(['Rosa Delgado', 'Sam Okafor'])
  })
  it('throws plain messages on bad input', () => {
    expect(() => parseTranscript('a.vtt', Buffer.from('WEBVTT\n\n'))).toThrow(/no caption lines/)
    expect(() => parseTranscript('a.txt', Buffer.from('   '))).toThrow(/no text/)
    expect(() => parseTranscript('a.docx', Buffer.from('not a zip'))).toThrow(/Word document/)
    expect(() => parseTranscript('a.pdf', Buffer.from('x'))).toThrow(/\.vtt, \.srt/)
  })
})

describe('rendering', () => {
  it('numbers messages so facts can cite them, and counts characters', () => {
    const [c] = parseClaudeExport(sample('claude-export-sample.zip'))
    const md = renderConversationMarkdown(c)
    expect(md).toMatch(/^\*\*1\. You\*\* · 2026-02-03 09:12/)
    expect(md).toMatch(/\*\*4\. Claude\*\*/)
    expect(conversationChars(c)).toBeGreaterThan(500)
  })
})
