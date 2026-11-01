import { describe, it, expect } from 'vitest'
import { DATA_KB_DIR, defaultWorkspaceKbDir, inWorkspaceFolder, knowledgeBaseRoot } from './knowledge-base-root.js'

// obj 720348: one knowledge base per install — every caller resolves the same folder.
describe('knowledgeBaseRoot', () => {
  it('uses the vault when one is configured', () => {
    expect(knowledgeBaseRoot({ SECOND_BRAIN_DIR: '/srv/vault' }, false)).toBe('/srv/vault')
    expect(knowledgeBaseRoot({ SECOND_BRAIN_ROOT: '/srv/v2', SECOND_BRAIN_DIR: '/srv/vault' }, false)).toBe('/srv/v2')
  })

  it('uses the vault on its default path when it exists on this host', () => {
    expect(knowledgeBaseRoot({}, true)).toBe('/home/operator/second-brain')
  })

  it('falls back to /app/data/knowledge-base on an install without a vault', () => {
    expect(knowledgeBaseRoot({}, false)).toBe(DATA_KB_DIR)
    expect(knowledgeBaseRoot({ DOC_INGEST_KB_DIR: '/data/kb' }, false)).toBe('/data/kb')
  })
})

describe('defaultWorkspaceKbDir — a workspace is a folder inside the one knowledge base', () => {
  it('vault layout keeps workspaces under workspaces/<slug>', () => {
    expect(defaultWorkspaceKbDir('acme', { SECOND_BRAIN_DIR: '/srv/vault' }, false)).toBe('/srv/vault/workspaces/acme')
  })

  it('data layout keeps the folder installs already have on disk (<root>/<slug>)', () => {
    expect(defaultWorkspaceKbDir('acme', {}, false)).toBe(`${DATA_KB_DIR}/acme`)
  })
})

describe('inWorkspaceFolder', () => {
  it('matches both layouts and nothing else', () => {
    expect(inWorkspaceFolder('/srv/vault/workspaces/acme/a.md', 'acme', '/srv/vault')).toBe(true)
    expect(inWorkspaceFolder(`${DATA_KB_DIR}/acme/people/x.md`, 'acme', DATA_KB_DIR)).toBe(true)
    expect(inWorkspaceFolder(`${DATA_KB_DIR}/acme-two/x.md`, 'acme', DATA_KB_DIR)).toBe(false)
    expect(inWorkspaceFolder(`${DATA_KB_DIR}/other/x.md`, 'acme', DATA_KB_DIR)).toBe(false)
  })
})
