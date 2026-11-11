import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileAnswer, rewriteCitations } from './answers.js'
import { readPage } from './wiki.js'

let kb: string
beforeEach(() => { kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kbwiki-ans-')) })
afterEach(() => { fs.rmSync(kb, { recursive: true, force: true }) })

function put(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(kb, rel)), { recursive: true })
  fs.writeFileSync(path.join(kb, rel), text)
}
const read = (rel: string) => fs.readFileSync(path.join(kb, rel), 'utf8')

const NOW = new Date('2026-10-31T12:00:00Z')

function seed(): void {
  put('organizations/greenway-growers.md', '---\ntitle: Greenway Growers\ntype: organization\n---\n# Greenway Growers\n\nPlant supplier.\n')
  put('people/sam-okafor.md', '---\ntitle: Sam Okafor\ntype: person\n---\n# Sam Okafor\n\nStore manager.\n')
  put('raw/calls/secret.md', '# raw\n')
}

describe('fileAnswer', () => {
  it('writes the answer page, rewrites citations, links back from used pages, and logs it', () => {
    seed()
    const r = fileAnswer(kb, {
      question: 'Who delivers our plants?',
      answer: 'Greenway Growers delivers on Tuesdays [[organizations/greenway-growers.md]]; Sam checks it in [[people/sam-okafor.md|Sam]]. Unknown: [[organizations/nope.md]].',
      sources: ['organizations/greenway-growers.md', 'people/sam-okafor', 'organizations/missing.md', 'raw/calls/secret.md', '../etc/passwd.md'],
      filedBy: 'Rosa Delgado',
      now: NOW,
    })
    expect(r).toEqual({ rel: 'answers/2026-10-31-who-delivers-our-plants.md', title: 'Who delivers our plants?' })
    const page = read(r.rel)
    expect(page).toMatch(/^---\ntitle: "Who delivers our plants\?"\ntype: answer\nsources: \[organizations\/greenway-growers.md, people\/sam-okafor.md\]\nfiled_by: Rosa Delgado\nupdated: 2026-10-31\ngenerated_by: kb-wiki\n---\n\n# Who delivers our plants\?\n/)
    expect(page).toContain('Tuesdays [[organizations/greenway-growers|Greenway Growers]]; Sam checks it in [[people/sam-okafor|Sam]]. Unknown: [[organizations/nope.md]].')
    expect(page).toContain('## Pages this answer used\n\n- [[organizations/greenway-growers|Greenway Growers]]\n- [[people/sam-okafor|Sam Okafor]]')
    expect(page).not.toContain('raw/calls')
    expect(readPage(kb, 'organizations/greenway-growers.md').backlinks).toEqual([{ rel: r.rel, title: 'Who delivers our plants?' }])
    expect(read('log.md')).toContain('## [2026-10-31 12:00] answer | Saved an answer: Who delivers our plants?')
    expect(read('index.md')).toContain('## Answers (1)')
  })

  it('never overwrites an earlier answer to the same question', () => {
    seed()
    const a = fileAnswer(kb, { question: 'Who is Sam?', answer: 'one', sources: [], now: NOW })
    const b = fileAnswer(kb, { question: 'Who is Sam?', answer: 'two', sources: [], now: NOW })
    expect(a.rel).toBe('answers/2026-10-31-who-is-sam.md')
    expect(b.rel).toBe('answers/2026-10-31-who-is-sam-2.md')
    expect(read(a.rel)).toContain('\none\n')
    expect(read(b.rel)).not.toContain('## Pages this answer used')
  })

  it('rejects an empty question or answer', () => {
    expect(() => fileAnswer(kb, { question: ' ', answer: 'x', sources: [] })).toThrow()
    expect(() => fileAnswer(kb, { question: 'q', answer: ' ', sources: [] })).toThrow()
  })

  it('rewriteCitations keeps unknown targets untouched', () => {
    expect(rewriteCitations('[[a/b.md]] and [[c.md]]', rel => (rel === 'a/b.md' ? 'B' : undefined))).toBe('[[a/b|B]] and [[c.md]]')
  })
})
