/**
 * Agent file format (obj 719986): parser, validation messages, serializer
 * round-trip, and the shipped starter templates.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  parseAgentFile,
  parseYamlSubset,
  serializeAgentYaml,
  renderAgentInstructions,
  type AgentFileDef,
} from './agent-file.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STARTERS = path.resolve(HERE, '../agent-templates')

const MINIMAL = `name: Test helper
slug: test-helper
description: A helper for tests.
version: 1.2.3
author: Sample Co
system_prompt: |
  Line one.

  # A heading inside the prompt is not a comment
  Line three: with a colon.
`

function ok(text: string, filename?: string): AgentFileDef {
  const r = parseAgentFile(text, { filename })
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.agent
}

function errs(text: string, filename?: string): string[] {
  const r = parseAgentFile(text, { filename })
  expect(r.ok).toBe(false)
  return r.ok ? [] : r.errors.map(e => `${e.field}: ${e.message}`)
}

describe('YAML subset', () => {
  it('reads maps, block lists, flow lists, quoted scalars and comments', () => {
    const v = parseYamlSubset(`# comment
a: plain text # trailing comment
b: "quoted # not a comment"
c: 'it''s'
d: [one, "two, three", four]
e:
  - x
  - y
f:
- same-indent list
g:
  - name: first
    cron: "0 8 * * *"
  - name: second
    cron: "0 9 * * *"
`)
    expect(v).toEqual({
      a: 'plain text',
      b: 'quoted # not a comment',
      c: "it's",
      d: ['one', 'two, three', 'four'],
      e: ['x', 'y'],
      f: ['same-indent list'],
      g: [{ name: 'first', cron: '0 8 * * *' }, { name: 'second', cron: '0 9 * * *' }],
    })
  })

  it('keeps blank lines and # lines inside | block text', () => {
    const a = ok(MINIMAL)
    expect(a.system_prompt).toBe('Line one.\n\n# A heading inside the prompt is not a comment\nLine three: with a colon.')
  })

  it('reports the line number for unsupported syntax', () => {
    expect(() => parseYamlSubset('a: 1\nb: &anchor x\n')).toThrow(/line 2/)
    expect(() => parseYamlSubset('a: 1\n\tb: 2\n')).toThrow(/tabs/)
    expect(() => parseYamlSubset('a: 1\na: 2\n')).toThrow(/appears twice/)
  })
})

describe('parseAgentFile', () => {
  it('accepts a minimal valid file and fills defaults', () => {
    const a = ok(MINIMAL)
    expect(a).toMatchObject({
      name: 'Test helper', slug: 'test-helper', version: '1.2.3', author: 'Sample Co',
      knowledge_folders: [], tools: [], schedules: [], model: null, provider: null, colour: null,
    })
  })

  it('reads .md with front matter; the body is the system prompt', () => {
    const a = ok('---\nname: Md agent\nslug: md-agent\nversion: 1.0.0\nauthor: X\ncolor: Blue\n---\n\nYou are helpful.\n', 'agents/md-agent/agent.md')
    expect(a.system_prompt).toBe('You are helpful.')
    expect(a.colour).toBe('blue')
  })

  it('gives clear, field-named errors', () => {
    const e = errs(`slug: Bad Slug
version: one
provider: skynet
knowledge_folders:
  - /etc
  - ../secrets
tools: [search, "Bad Tool"]
schedules:
  - name: nightly
    cron: "every night"
`)
    const joined = e.join('\n')
    expect(joined).toMatch(/^name: is required/m)
    expect(joined).toMatch(/^slug: must be 2–41 characters/m)
    expect(joined).toMatch(/^system_prompt: is required/m)
    expect(joined).toMatch(/^version: "one" must look like 1.0.0/m)
    expect(joined).toMatch(/^provider: "skynet" is not supported/m)
    expect(joined).toMatch(/knowledge_folders\[0\]: "\/etc" must be a folder inside the knowledge base/)
    expect(joined).toMatch(/knowledge_folders\[1\]: "..\/secrets" is not a valid folder name/)
    expect(joined).toMatch(/tools\[1\]: "Bad Tool" is not a valid tool name/)
    expect(joined).toMatch(/schedules\[0\].cron: "every night" must be a 5-part schedule/)
    expect(joined).toMatch(/schedules\[0\].prompt: is required/)
  })

  it('checks the slug matches its folder', () => {
    expect(errs(MINIMAL, 'agents/other-name/agent.yaml').join()).toMatch(/must match its folder name "other-name"/)
    expect(ok(MINIMAL, 'agents/test-helper/agent.yaml').slug).toBe('test-helper')
    // A downloaded export (<slug>.agent.yaml) has no folder to check.
    expect(ok(MINIMAL, 'Downloads/test-helper.agent.yaml').slug).toBe('test-helper')
  })

  it('warns (not fails) on unknown tools, unknown fields, bad colour, missing version/author', () => {
    const r = parseAgentFile('name: W\nslug: warn-me\ncolour: "#ff0000"\nmood: happy\ntools: [crm_sync]\nsystem_prompt: hi\n')
    expect(r.ok).toBe(true)
    const fields = r.warnings.map(w => w.field)
    expect(fields).toEqual(expect.arrayContaining(['mood', 'colour', 'tools[0]', 'version', 'author', 'description']))
    if (r.ok) {
      expect(r.agent.colour).toBeNull()
      expect(r.agent.version).toBe('0.1.0')
    }
  })

  it('refuses files that contain a secret value', () => {
    const e = errs(`${MINIMAL}model: "sk-ant-api03-${'a'.repeat(40)}"\n`)
    expect(e.join()).toMatch(/appears to contain a secret value \(ANTHROPIC_KEY/)
    // Naming a secret is fine.
    ok(`${MINIMAL.replace('Line one.', 'Use the CRM_API_KEY secret by name.')}`)
  })

  it('rejects empty and non-map files', () => {
    expect(errs('').join()).toMatch(/empty/)
    expect(errs('- a\n- b\n').join()).toMatch(/"key: value" fields/)
    expect(errs('# just text\n', 'x/agent.md').join()).toMatch(/front matter/)
  })
})

describe('serializeAgentYaml', () => {
  it('round-trips every field', () => {
    const def: AgentFileDef = {
      name: 'Round: trip',
      slug: 'round-trip',
      description: 'Has "quotes", # hashes and: colons',
      avatar: '📚',
      colour: 'pink',
      system_prompt: 'First\n\n  indented line\n# heading',
      knowledge_folders: ['notes/clients', 'Shared Docs'],
      tools: ['search', 'write_doc'],
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      schedules: [{ name: 'Daily', cron: '0 8 * * 1-5', prompt: 'Do the thing.\nThen the other.' }],
      version: '2.0.0',
      author: 'Example Partners',
    }
    const text = serializeAgentYaml(def)
    const back = parseAgentFile(text, { filename: 'agents/round-trip/agent.yaml' })
    expect(back.ok).toBe(true)
    if (back.ok) {
      expect(back.agent).toEqual(def)
      expect(back.warnings).toEqual([])
    }
  })
})

describe('starter templates', () => {
  const slugs = fs.readdirSync(STARTERS).sort()

  it('ships exactly the three generic starters', () => {
    expect(slugs).toEqual(['knowledge-librarian', 'operator', 'personal-assistant'])
  })

  for (const slug of ['knowledge-librarian', 'operator', 'personal-assistant']) {
    it(`${slug} is valid with no warnings and has version + author`, () => {
      const p = path.join(STARTERS, slug, 'agent.yaml')
      const r = parseAgentFile(fs.readFileSync(p, 'utf-8'), { filename: p })
      if (!r.ok) throw new Error(JSON.stringify(r.errors))
      expect(r.warnings).toEqual([])
      expect(r.agent.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(r.agent.author).toBeTruthy()
      expect(r.agent.description).toBeTruthy()
    })
  }

  it('personal assistant is drafts-only', () => {
    const r = parseAgentFile(fs.readFileSync(path.join(STARTERS, 'personal-assistant/agent.yaml'), 'utf-8'))
    expect(r.ok && r.agent.system_prompt).toMatch(/NEVER send/)
    expect(r.ok && r.agent.tools).toEqual(expect.arrayContaining(['email', 'calendar']))
  })

  it('operator can create board cards', () => {
    const r = parseAgentFile(fs.readFileSync(path.join(STARTERS, 'operator/agent.yaml'), 'utf-8'))
    expect(r.ok && r.agent.tools).toContain('create_objective')
  })
})

describe('renderAgentInstructions', () => {
  it('states folder and tool limits', () => {
    const a = ok(`${MINIMAL}knowledge_folders: [notes]\ntools: [search]\n`)
    const s = renderAgentInstructions(a)
    expect(s).toContain('# Test helper')
    expect(s).toContain('- notes')
    expect(s).toContain('- search')
  })
})
