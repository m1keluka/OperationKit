import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseMiniYaml, splitFrontMatter } from './mini-yaml.js'
import { loadChatAgents, parseAgentText, normaliseKnowledgeFolder, DEMO_AGENT_SLUG, builtinsEnabled } from './agent-defs.js'

describe('mini YAML reader', () => {
  it('reads the agent-file subset: scalars, flow + block lists, block strings, list of maps', () => {
    const y = parseMiniYaml(`
# comment
name: "Personal assistant"
version: 1.2.0
count: 3
on: true
tools: [search, "read_file", write_doc]
knowledge_folders:
  - notes/personal   # trailing comment
  - 'shared/team docs'
system_prompt: |
  Line one.

  Line three: keeps "quotes" # and hashes
schedules:
  - name: morning
    cron: "0 8 * * 1-5"
    prompt: Summarise my inbox
folded: >
  a
  b
`)
    expect(y.name).toBe('Personal assistant')
    expect(y.version).toBe('1.2.0')
    expect(y.count).toBe(3)
    expect(y.on).toBe(true)
    expect(y.tools).toEqual(['search', 'read_file', 'write_doc'])
    expect(y.knowledge_folders).toEqual(['notes/personal', 'shared/team docs'])
    expect(y.system_prompt).toBe('Line one.\n\nLine three: keeps "quotes" # and hashes\n')
    expect(y.schedules).toEqual([{ name: 'morning', cron: '0 8 * * 1-5', prompt: 'Summarise my inbox' }])
    expect(y.folded).toBe('a b\n')
  })

  it('reports the line of what it cannot read', () => {
    expect(() => parseMiniYaml('name: a\n  bad: indent\n')).toThrow(/line 2/)
    expect(() => parseMiniYaml('name: a\nname: b\n')).toThrow(/duplicate key "name"/)
    expect(() => parseMiniYaml('x: {a: 1}\n')).toThrow(/inline \{maps\}/)
  })

  it('splits markdown front matter', () => {
    expect(splitFrontMatter('---\nname: x\n---\nBody here\n')).toEqual({ front: 'name: x\n', body: 'Body here\n' })
    expect(splitFrontMatter('no front matter')).toBeNull()
  })
})

describe('agent files', () => {
  it('validates required fields and confines knowledge folders', () => {
    const r = parseAgentText('name: X\nsystem_prompt: hi\nknowledge_folders: [/etc, ../up, ok/dir]\ntools: [search, send_email]\nprovider: nope\n', 'agent.yaml', 'x')
    expect(r.agent).toBeNull()
    expect(r.errors.join('\n')).toMatch(/"\/etc" must be a folder inside the knowledge base/)
    expect(r.errors.join('\n')).toMatch(/"\.\.\/up"/)
    expect(r.errors.join('\n')).toMatch(/provider "nope"/)
    expect(r.warnings.join('\n')).toMatch(/send_email/)
    expect(parseAgentText('description: no name\n', 'agent.yaml', 'x').errors).toEqual(
      expect.arrayContaining(['name is required', 'system_prompt (instructions) is required']),
    )
  })

  it('agent.md uses the body as instructions and maps colour names', () => {
    const r = parseAgentText('---\nname: Librarian\ncolor: blue\navatar: 📚\n---\nYou organise the knowledge base.\n', 'agent.md', 'librarian')
    expect(r.errors).toEqual([])
    expect(r.agent).toMatchObject({ slug: 'librarian', name: 'Librarian', colour: 'blue', avatar: '📚', system_prompt: 'You organise the knowledge base.' })
    const odd = parseAgentText('name: A\nsystem_prompt: x\ncolour: "#ff0000"\n', 'agent.yaml', 'a')  // ui-conformance-ignore: fixture proves a hex colour is rejected
    expect(odd.agent?.colour).toBe('grey')
    expect(odd.warnings[0]).toMatch(/not one of/)
  })

  it('normalises folders', () => {
    expect(normaliseKnowledgeFolder('./notes/a/')).toBe('notes/a')
    expect(normaliseKnowledgeFolder('C:/x')).toBeNull()
    expect(normaliseKnowledgeFolder('a/../../b')).toBeNull()
  })

  it('loads agents/<slug>/agent.{yaml,md}, skips flat persona files, reports broken ones, adds the demo only when on', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-defs-'))
    try {
      fs.writeFileSync(path.join(dir, 'cto.md'), '---\nname: legacy\n---\nflat persona, not an agent file')
      fs.mkdirSync(path.join(dir, 'helper'))
      fs.writeFileSync(path.join(dir, 'helper', 'agent.yaml'), 'name: Helper\nsystem_prompt: Help.\ntools: [search]\nknowledge_folders: [notes]\n')
      fs.mkdirSync(path.join(dir, 'broken'))
      fs.writeFileSync(path.join(dir, 'broken', 'agent.yaml'), 'name: [unclosed\n')
      const env = { AGENT_FILES_DIR: dir }
      const off = loadChatAgents({ env })
      expect(off.agents.map(a => a.slug)).toEqual(['helper'])
      expect(off.problems.map(p => p.slug)).toEqual(['broken'])
      const on = loadChatAgents({ env, includeDemo: true })
      expect(on.agents.map(a => a.slug)).toEqual(['helper', DEMO_AGENT_SLUG])
      const demo = on.agents.find(a => a.slug === DEMO_AGENT_SLUG)!
      expect(demo.source).toBe('demo')
      expect(demo.tools).toEqual(expect.arrayContaining(['email', 'calendar', 'create_objective']))
      expect(demo.knowledge_folders).toEqual(['demo/personal-assistant'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ships the built-in Operation Kit Dev bot with an info panel and scoped tools (obj 900672)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-defs-okdev-'))
    try {
      const on = loadChatAgents({ env: { AGENT_FILES_DIR: dir }, includeBuiltins: true })
      expect(on.problems).toEqual([])
      const dev = on.agents.find(a => a.slug === 'operation-kit-dev')!
      expect(dev).toMatchObject({ name: 'Operation Kit Dev', source: 'builtin', version: '1.0.0' })
      // The info panel's content travels in the file itself.
      expect(dev.how_to_use).toMatch(/Integrations/)
      expect(dev.how_to_use).toMatch(/Settings → Secrets/)
      expect(dev.example_prompts.length).toBeGreaterThanOrEqual(5)
      expect(dev.example_prompts.join(' ')).toMatch(/automate/i)
      // It writes only its own business/ notes; everything else it can reach is read + board cards.
      expect(dev.knowledge_folders).toContain('business')
      expect(dev.knowledge_folders).not.toContain('people')
      expect(dev.tools).toEqual(expect.arrayContaining(['search', 'read_file', 'write_doc', 'create_objective', 'board_briefing']))
      expect(dev.tools).not.toContain('email')
      expect(dev.tools).not.toContain('calendar')
      // The four jobs it is for, plus the proactive learning brief.
      for (const topic of ['Settings → Integrations', 'Settings → Email', 'Settings → Branding', 'Paste agent file', 'business/profile.md', 'business/automation-ideas.md']) {
        expect(dev.system_prompt).toContain(topic)
      }
      expect(dev.system_prompt).toMatch(/Never ask for a secret value/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads optional how_to_use / example_prompts and drops bad prompts with a warning (obj 900672)', () => {
    const ok = parseAgentText('---\nname: A\nexample_prompts: [One, Two]\nhow_to_use: |\n  Use me.\n---\nBody.\n', 'a/agent.md', 'aa')
    expect(ok.agent).toMatchObject({ how_to_use: 'Use me.', example_prompts: ['One', 'Two'] })
    const none = parseAgentText('name: B\nsystem_prompt: Hi\n', 'b/agent.yaml', 'bb')
    expect(none.agent).toMatchObject({ how_to_use: '', example_prompts: [] })
    const long = parseAgentText('name: C\nsystem_prompt: Hi\nexample_prompts:\n  - ' + 'x'.repeat(301) + '\n  - Fine\n', 'c/agent.yaml', 'cc')
    expect(long.agent?.example_prompts).toEqual(['Fine'])
    expect(long.warnings.join(' ')).toMatch(/longer than 300/)
  })

  it('lists the built-in Knowledge Base Setup agent on every install; a file agent with the same slug replaces it (obj 900556)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-defs-builtin-'))
    try {
      const env = { AGENT_FILES_DIR: dir }
      expect(loadChatAgents({ env }).agents).toEqual([])
      const on = loadChatAgents({ env, includeBuiltins: true })
      expect(on.problems).toEqual([])
      const kb = on.agents.find(a => a.slug === 'kb-setup')!
      expect(kb).toMatchObject({ name: 'Knowledge Base Setup', source: 'builtin', tools: [], knowledge_folders: [] })
      expect(kb.system_prompt).toContain('/knowledge/setup')
      fs.mkdirSync(path.join(dir, 'kb-setup'))
      fs.writeFileSync(path.join(dir, 'kb-setup', 'agent.yaml'), 'name: Our KB setup\nsystem_prompt: Custom.\nknowledge_folders: [workspaces/acme]\ntools: [search]\n')
      const custom = loadChatAgents({ env, includeBuiltins: true }).agents.filter(a => a.slug === 'kb-setup')
      expect(custom).toHaveLength(1)
      expect(custom[0]).toMatchObject({ name: 'Our KB setup', source: 'file' })
      expect(builtinsEnabled({})).toBe(true)
      expect(builtinsEnabled({ AGENT_CHAT_BUILTINS: '0' })).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
