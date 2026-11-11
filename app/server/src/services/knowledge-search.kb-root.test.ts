import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// obj 720348: search reads the ONE knowledge base — including an install whose
// knowledge base is the /app/data layout (<root>/<workspace>/…) written by imports.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-kb-search-'))
process.env.SECOND_BRAIN_ROOT = ROOT

const { searchKnowledge, searchKnowledgeGrep } = await import('./knowledge-search.js')

fs.mkdirSync(path.join(ROOT, 'acme', 'suppliers'), { recursive: true })
fs.mkdirSync(path.join(ROOT, 'other', 'suppliers'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'acme', 'suppliers', 'greenway-growers.md'), '# Greenway Growers\n\nOur produce supplier, delivers on Tuesdays.\n')
fs.writeFileSync(path.join(ROOT, 'other', 'suppliers', 'greenway-other.md'), '# Greenway\n\nA produce supplier note from another workspace.\n')

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

describe('knowledge search over the one knowledge base', () => {
  it('finds imported pages under the knowledge base root', () => {
    const hits = searchKnowledge('greenway produce supplier')
    expect(hits.map(h => h.path)).toContain(path.join(ROOT, 'acme', 'suppliers', 'greenway-growers.md'))
  })

  it('ranks the asking workspace\'s folder first in the data layout (grep path)', () => {
    const hits = searchKnowledgeGrep('greenway produce supplier', 'other')
    expect(hits[0]?.path).toBe(path.join(ROOT, 'other', 'suppliers', 'greenway-other.md'))
  })
})
