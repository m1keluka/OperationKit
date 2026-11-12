/**
 * The one agent + skill roster behind Agents → Registry (obj 900684).
 *
 * WHY THIS EXISTS. The roster used to be `fs.readdirSync(AGENTS_DIR)` filtered to
 * `*.md`, i.e. only the flat persona files (agents/cto.md). The app knows about
 * agents from four other places, and every one of them was invisible there:
 *
 *   source         where it lives                                   example
 *   ─────────────  ───────────────────────────────────────────────  ───────────────
 *   persona        <agents dir>/<slug>.md                           cto, general
 *   chat           <agents dir>/<slug>/agent.md|agent.yaml          any Bots agent
 *   builtin        app/server/src/services/agent-chat/builtin/<slug> kb-setup
 *   registry       a row in the `agents` table with no persona file  seed slugs
 *   starter-pack   starter-packs/<id>/pack.json, pack switched OFF   kb-librarian
 *
 * The Knowledge Base Setup agent ("kb-setup") ships with the app as a BUILT-IN
 * chat agent (obj 900556): a folder, not a flat .md, and not under the agents dir
 * at all — so the roster never listed it, though Bots did. The Librarian
 * ("kb-librarian") belongs to the Knowledge-import starter pack: its persona file
 * is only copied into the agents dir when the pack is switched on, and there is no
 * UI to switch it on, so on an install where nobody ran scripts/starter-pack.sh
 * it did not exist anywhere a person could see.
 *
 * Skills had the same blind spot one level down: sub-skills
 * (skills/<parent>/<child>/SKILL.md, addressed `parent/child`) were counted as
 * files of their parent and never listed.
 *
 * Every entry says where it came from (`source`) and, when it is not usable yet,
 * how to make it usable (`note`). The old fields are unchanged so older clients
 * keep working.
 */
import fs from 'fs'
import path from 'path'
import { AI_WORKSPACE_DIR, AGENTS_DIR, SKILLS_DIR } from '../config.js'
import { listAgents as listRegistryAgents } from './agent-registry.js'
import { builtinsEnabled, loadChatAgents, type ChatAgent } from './agent-chat/agent-defs.js'
import { isPackEnabled, listPacks, type StarterPack } from './starter-packs.js'
import type { AgentKind, AgentRow } from '@operationkit/shared'

export type RosterSource = 'persona' | 'chat' | 'builtin' | 'registry' | 'starter-pack'

export interface RosterAgent {
  /** Unique across sources: `${source}:${slug}`. */
  id: string
  name: string
  /** Kept for older clients; '' when the agent has no file in the agents dir. */
  filename: string
  slug: string
  size: number
  modifiedAt: string | null
  assignable: boolean
  kind: AgentKind
  label: string
  source: RosterSource
  description: string
  /** Path relative to the ai-workspace dir, readable through GET /admin/file. */
  file_path: string | null
  /** The definition itself, for agents that live outside the ai-workspace dir. */
  definition: string | null
  /** Where a person uses it, when that is a page (chat agents → /chat/<slug>). */
  open_href: string | null
  pack: { id: string; name: string; enabled: boolean } | null
  /** Plain-language reason it is shown the way it is (e.g. how to switch it on). */
  note: string | null
}

export interface RosterSkill {
  /** Directory slug; `parent/child` for a sub-skill. */
  name: string
  description: string
  dirname: string
  size: number
  fileCount: number
  parent: string | null
}

export interface RosterOptions {
  aiWorkspaceDir?: string
  agentsDir?: string
  skillsDir?: string
  env?: NodeJS.ProcessEnv
  registry?: () => AgentRow[]
  packs?: () => StarterPack[]
  packEnabled?: (id: string) => boolean
  chatAgents?: () => ChatAgent[]
}

const MAX_INLINE_DEFINITION = 64 * 1024

function relToWorkspace(abs: string, workspaceDir: string): string | null {
  const rel = path.relative(workspaceDir, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

function readSmall(file: string): string | null {
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > MAX_INLINE_DEFINITION) return null
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function firstParagraph(md: string): string {
  const body = md.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '')
  for (const block of body.split(/\n\s*\n/)) {
    const t = block.trim()
    if (t && !t.startsWith('#')) return t.replace(/\s+/g, ' ').slice(0, 280)
  }
  return ''
}

function frontmatterDescription(md: string): string {
  const fm = md.match(/^---\s*\n([\s\S]*?)\n---/)
  const d = fm?.[1].match(/^description:\s*(.+)$/m)
  return d ? d[1].trim().replace(/^["']|["']$/g, '') : ''
}

export function buildAgentRoster(opts: RosterOptions = {}): RosterAgent[] {
  const wsDir = opts.aiWorkspaceDir ?? AI_WORKSPACE_DIR
  const agentsDir = opts.agentsDir ?? AGENTS_DIR
  const env = opts.env ?? process.env
  const registry = (opts.registry ?? (() => listRegistryAgents()))()
  const regBySlug = new Map(registry.map(r => [r.slug, r]))
  const out: RosterAgent[] = []
  const seen = new Set<string>()

  const push = (a: RosterAgent) => {
    out.push(a)
    seen.add(a.slug)
  }

  // 1. Flat persona files — unchanged behaviour, now with a source + description.
  let personaFiles: string[] = []
  try { personaFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')).sort() } catch { /* no dir */ }
  for (const filename of personaFiles) {
    const full = path.join(agentsDir, filename)
    let st: fs.Stats
    try { st = fs.statSync(full) } catch { continue }
    if (!st.isFile()) continue
    const slug = filename.replace(/\.md$/, '')
    const meta = regBySlug.get(slug)
    const text = readSmall(full) ?? ''
    push({
      id: `persona:${slug}`,
      name: slug.replace(/-/g, ' '),
      filename,
      slug,
      size: st.size,
      modifiedAt: st.mtime.toISOString(),
      // A persona on disk but absent from the registry is shown routing-only +
      // non-assignable so nothing is silently mislabeled.
      assignable: meta ? meta.assignable : false,
      kind: meta ? meta.kind : 'routing-only',
      label: meta ? meta.label : slug,
      source: 'persona',
      description: frontmatterDescription(text) || firstParagraph(text),
      file_path: relToWorkspace(full, wsDir),
      definition: null,
      open_href: null,
      pack: null,
      note: meta ? null : 'Not in the agent registry yet, so it cannot be picked for a card.',
    })
  }

  // 2. Chat agents: folder agents in the agents dir and the built-ins that ship
  //    with the app (Knowledge Base Setup). Same loader the Bots page uses.
  const chat = opts.chatAgents
    ? opts.chatAgents()
    : loadChatAgents({ env, includeBuiltins: builtinsEnabled(env) }).agents
  for (const c of chat) {
    if (c.source === 'demo') continue
    let size = 0
    let modifiedAt: string | null = null
    try { const st = fs.statSync(c.file); size = st.size; modifiedAt = st.mtime.toISOString() } catch { /* gone */ }
    const rel = relToWorkspace(c.file, wsDir)
    const builtin = c.source === 'builtin'
    const meta = regBySlug.get(c.slug)
    out.push({
      id: `${builtin ? 'builtin' : 'chat'}:${c.slug}`,
      name: c.name,
      filename: rel ? path.basename(c.file) : '',
      slug: c.slug,
      size,
      modifiedAt,
      assignable: meta ? meta.assignable : false,
      kind: meta ? meta.kind : 'routing-only',
      label: c.name,
      source: builtin ? 'builtin' : 'chat',
      description: c.description,
      file_path: rel,
      definition: rel ? null : readSmall(c.file),
      open_href: `/chat/${encodeURIComponent(c.slug)}`,
      pack: null,
      note: builtin
        ? 'Ships with the app. Talk to it from Bots. To customise it, put an agent file with the same slug in the agents folder.'
        : 'A chat agent. Talk to it from Bots.',
    })
    seen.add(c.slug)
  }

  // 3. Registry rows with no persona file: selectable on a card, but the session
  //    would run on a missing prompt. Show them so the gap is visible.
  for (const r of registry) {
    if (seen.has(r.slug)) continue
    const fileName = (r.prompt_file || r.slug).replace(/\.md$/, '') + '.md'
    const full = path.join(agentsDir, fileName)
    if (fs.existsSync(full)) continue
    push({
      id: `registry:${r.slug}`,
      name: r.slug.replace(/-/g, ' '),
      filename: '',
      slug: r.slug,
      size: 0,
      modifiedAt: null,
      assignable: r.assignable,
      kind: r.kind,
      label: r.label,
      source: 'registry',
      description: '',
      file_path: null,
      definition: null,
      open_href: null,
      pack: null,
      note: `Registered, but there is no ${fileName} in the agents folder. Sessions for this agent start without its instructions until the file is added.`,
    })
  }

  // 4. Starter-pack agents that are not installed yet (pack switched off).
  const packs = (opts.packs ?? (() => listPacks(env)))()
  const packEnabled = opts.packEnabled ?? isPackEnabled
  for (const p of packs) {
    const m = p.manifest
    const enabled = packEnabled(m.id)
    for (const a of m.agents ?? []) {
      if (seen.has(a.slug)) continue
      const src = path.join(p.dir, a.prompt_file ?? `agents/${a.slug}.md`)
      const text = readSmall(src) ?? ''
      push({
        id: `starter-pack:${a.slug}`,
        name: a.slug.replace(/-/g, ' '),
        filename: '',
        slug: a.slug,
        size: text.length,
        modifiedAt: null,
        assignable: false,
        kind: a.kind ?? 'executive',
        label: a.label ?? a.slug,
        source: 'starter-pack',
        description: firstParagraph(text),
        file_path: null,
        definition: text || null,
        open_href: null,
        pack: { id: m.id, name: m.name, enabled },
        note: enabled
          ? `The "${m.name}" starter pack is on, but this agent's file is missing from the agents folder. Switch the pack off and on again to restore it.`
          : `Comes with the "${m.name}" starter pack, which is switched off on this install. Switch it on (POST /api/starter-packs/${m.id}/enable, or scripts/starter-pack.sh) to add this agent.`,
      })
    }
  }

  return out
}

export function buildSkillRoster(opts: { skillsDir?: string } = {}): RosterSkill[] {
  const skillsDir = opts.skillsDir ?? SKILLS_DIR
  const isDir = (p: string) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
  const describe = (dir: string) => {
    let description = ''
    let size = 0
    try {
      const file = path.join(dir, 'SKILL.md')
      size = fs.statSync(file).size
      description = frontmatterDescription(fs.readFileSync(file, 'utf8'))
    } catch { /* no SKILL.md */ }
    return { description, size }
  }
  const countFiles = (dir: string, skipSkillDirs: boolean): number => {
    let n = 0
    const walk = (d: string, depth: number) => {
      let entries: string[] = []
      try { entries = fs.readdirSync(d) } catch { return }
      for (const e of entries) {
        const full = path.join(d, e)
        if (isDir(full)) {
          // A sub-skill is listed on its own row, so its files are not the parent's.
          if (skipSkillDirs && depth === 0 && fs.existsSync(path.join(full, 'SKILL.md'))) continue
          walk(full, depth + 1)
        } else n++
      }
    }
    walk(dir, 0)
    return n
  }

  let top: string[] = []
  try { top = fs.readdirSync(skillsDir).filter(d => isDir(path.join(skillsDir, d))).sort() } catch { /* no dir */ }
  const out: RosterSkill[] = []
  for (const dirname of top) {
    const dir = path.join(skillsDir, dirname)
    out.push({ name: dirname, dirname, parent: null, ...describe(dir), fileCount: countFiles(dir, true) })
    let children: string[] = []
    try { children = fs.readdirSync(dir).filter(c => isDir(path.join(dir, c)) && fs.existsSync(path.join(dir, c, 'SKILL.md'))).sort() } catch { /* none */ }
    for (const child of children) {
      const cdir = path.join(dir, child)
      const slug = `${dirname}/${child}`
      out.push({ name: slug, dirname: slug, parent: dirname, ...describe(cdir), fileCount: countFiles(cdir, false) })
    }
  }
  return out
}
