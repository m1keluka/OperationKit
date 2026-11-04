import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  KB_GUIDE_PER_WORKSPACE_CHARS,
  KB_GUIDE_READ_CAP_BYTES,
  clipGuideText,
  displayPathFor,
  formatKbGuideBlock,
  kbGuideUri,
  normalizeGuideRel,
  readGuideFile,
  workspaceFromKbGuideUri,
  type LoadedGuide,
} from './mcp-kb-guide.js'

const tmpDirs: string[] = []

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-kb-guide-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  delete process.env.SECOND_BRAIN_ROOT
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('normalizeGuideRel', () => {
  it('accepts a relative markdown path and rejects escapes', () => {
    expect(normalizeGuideRel(null)).toEqual({ kind: 'unset' })
    expect(normalizeGuideRel('  ')).toEqual({ kind: 'unset' })
    expect(normalizeGuideRel('off')).toEqual({ kind: 'off' })
    expect(normalizeGuideRel('NONE')).toEqual({ kind: 'off' })
    expect(normalizeGuideRel('-')).toEqual({ kind: 'off' })
    expect(normalizeGuideRel('topics/agent-kb-usage-guide.md')).toEqual({
      kind: 'path',
      rel: 'topics/agent-kb-usage-guide.md',
    })
    expect(normalizeGuideRel('topics\\notes\\guide.md')).toEqual({ kind: 'path', rel: 'topics/notes/guide.md' })
    expect(normalizeGuideRel('/etc/passwd.md').kind).toBe('invalid')
    expect(normalizeGuideRel('../secret.md').kind).toBe('invalid')
    expect(normalizeGuideRel('topics/../../secret.md').kind).toBe('invalid')
    expect(normalizeGuideRel('topics/guide.txt').kind).toBe('invalid')
    expect(normalizeGuideRel('topics/guide.md\0').kind).toBe('invalid')
  })
})

describe('readGuideFile', () => {
  it('reads a markdown file inside the workspace folder', () => {
    const root = tmp()
    const file = path.join(root, 'topics', 'agent-kb-usage-guide.md')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'When to write.\n')
    const got = readGuideFile(root, 'topics/agent-kb-usage-guide.md')
    expect(got?.content).toBe('When to write.')
    expect(got?.fileTruncated).toBe(false)
    expect(got?.absolutePath).toBe(file)
  })

  it('skips a missing file, an empty file, a directory, and a symlink that leaves the folder', () => {
    const root = tmp()
    expect(readGuideFile(root, 'topics/agent-kb-usage-guide.md')).toBeNull()
    const empty = path.join(root, 'empty.md')
    fs.writeFileSync(empty, '  \n')
    expect(readGuideFile(root, 'empty.md')).toBeNull()
    const dir = path.join(root, 'topics')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'nope.md'), 'x')
    expect(readGuideFile(root, 'topics')).toBeNull()

    const outside = path.join(tmp(), 'secret.md')
    fs.writeFileSync(outside, 'SUPER_SECRET_OUTSIDE')
    fs.symlinkSync(outside, path.join(root, 'topics', 'agent-kb-usage-guide.md'))
    expect(readGuideFile(root, 'topics/agent-kb-usage-guide.md')).toBeNull()
  })

  it('caps the bytes read from a huge file', () => {
    const root = tmp()
    const file = path.join(root, 'big.md')
    fs.writeFileSync(file, 'A'.repeat(KB_GUIDE_READ_CAP_BYTES + 50))
    const got = readGuideFile(root, 'big.md')
    expect(got?.fileTruncated).toBe(true)
    expect(got!.content.length).toBeLessThanOrEqual(KB_GUIDE_READ_CAP_BYTES)
    expect(got!.content.startsWith('A')).toBe(true)
  })
})

describe('displayPathFor', () => {
  it('uses the path inside the knowledge base', () => {
    const kb = tmp()
    process.env.SECOND_BRAIN_ROOT = kb
    expect(displayPathFor(
      'weightsupply',
      'topics/agent-kb-usage-guide.md',
      path.join(kb, 'workspaces', 'weightsupply'),
    )).toBe('workspaces/weightsupply/topics/agent-kb-usage-guide.md')
    expect(displayPathFor('acme', 'topics/agent-kb-usage-guide.md', path.join(kb, 'acme')))
      .toBe('acme/topics/agent-kb-usage-guide.md')
    expect(displayPathFor('acme', 'topics/a.md', path.join(tmp(), 'elsewhere')))
      .toBe('workspaces/acme/topics/a.md')
  })
})

describe('formatKbGuideBlock', () => {
  const guide = (workspace: string, content: string, extra: Partial<LoadedGuide> = {}): LoadedGuide => ({
    workspace,
    displayPath: `workspaces/${workspace}/topics/agent-kb-usage-guide.md`,
    absolutePath: `/kb/workspaces/${workspace}/topics/agent-kb-usage-guide.md`,
    content,
    fileTruncated: false,
    ...extra,
  })

  it('returns an empty string when there is no guide', () => {
    expect(formatKbGuideBlock([])).toBe('')
  })

  it('inlines a short guide and clips a long one to the per-workspace cap', () => {
    const short = formatKbGuideBlock([guide('example', 'Read active.md first.')])
    expect(short).toContain('### example')
    expect(short).toContain('Read active.md first.')
    expect(short).not.toContain('truncated')

    const longBody = `START\n${'y'.repeat(KB_GUIDE_PER_WORKSPACE_CHARS + 200)}\nEND_TAIL`
    const long = formatKbGuideBlock([guide('example', longBody)])
    expect(long).toContain('START')
    expect(long).not.toContain('END_TAIL')
    expect(long).toContain('read_file: /kb/workspaces/example/topics/agent-kb-usage-guide.md')
    const appendix = long.replace(/^\n+/, '')
    expect(appendix.length).toBeLessThan(KB_GUIDE_PER_WORKSPACE_CHARS + 800)
  })

  it('lists guides that do not fit the total cap instead of inlining them', () => {
    const guides = ['a', 'b', 'c'].map(workspace => guide(workspace, 'z'.repeat(500)))
    // Smaller than the header, so nothing is inlined and every path is listed.
    const block = formatKbGuideBlock(guides, { perGuide: 100, total: 40 })
    expect(block).toContain('Not inlined')
    expect(block).not.toContain('### a')
    expect(block).toContain('workspaces/a/topics/agent-kb-usage-guide.md')
    expect(block).toContain('workspaces/c/topics/agent-kb-usage-guide.md')
    expect(block).not.toContain('z'.repeat(40))
  })
})

describe('clipGuideText and guide URIs', () => {
  it('leaves a short guide untouched and marks a clipped one', () => {
    expect(clipGuideText('hello', 100, '/kb/a.md', false)).toEqual({ text: 'hello', truncated: false })
    const clipped = clipGuideText('a'.repeat(200), 120, '/k.md', false)
    expect(clipped.truncated).toBe(true)
    expect(clipped.text).toContain('read_file: /k.md')
    expect(clipped.text.length).toBeLessThanOrEqual(120)
  })

  it('round-trips a workspace slug through the resource URI', () => {
    expect(kbGuideUri('example-project')).toBe('operationkit://kb-guide/example-project')
    expect(workspaceFromKbGuideUri('operationkit://kb-guide/example-project')).toBe('example-project')
    expect(workspaceFromKbGuideUri('operationkit://kb-guide/../etc')).toBeNull()
    expect(workspaceFromKbGuideUri('file:///etc/passwd')).toBeNull()
  })
})
