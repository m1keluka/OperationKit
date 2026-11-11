// ── Chat agents: read agent files from disk (obj 719987) ──
//
// An agent is ONE file — <agents dir>/<slug>/agent.yaml, or agent.md with YAML
// front matter (the markdown body becomes the instructions when the front
// matter has no system_prompt). Fields, shared with the agent-templates card:
//   name, slug, description, avatar, colour (or color), system_prompt,
//   knowledge_folders, tools, model, provider, schedules, version, author
//
// The agents dir is AGENT_FILES_DIR, else <AI_WORKSPACE_DIR>/agents. Legacy flat
// persona files (agents/cto.md) are not agent files and are ignored.
//
// The built-in demo agent ("demo-assistant", fake inbox + calendar) lives next
// to this file in ./demo and is listed only when the demo is switched on.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { AI_WORKSPACE_DIR } from '../../config.js'
import { parseMiniYaml, splitFrontMatter, type YamlValue } from './mini-yaml.js'
import { KNOWN_TOOL_NAMES } from './tool-names.js'

export const CHAT_PROVIDERS = ['claude', 'anthropic', 'openai', 'xai', 'openai-compatible', 'demo'] as const
export type ChatProviderId = (typeof CHAT_PROVIDERS)[number]

/** Named colours → the agent-* design tokens on the client. */
export const AGENT_COLOURS = ['blue', 'pink', 'green', 'amber', 'grey'] as const
export type AgentColour = (typeof AGENT_COLOURS)[number]

export interface AgentSchedule { name: string; cron: string; prompt: string }

export interface ChatAgent {
  slug: string
  name: string
  description: string
  avatar: string
  colour: AgentColour
  system_prompt: string
  knowledge_folders: string[]
  tools: string[]
  model: string | null
  provider: ChatProviderId | null
  schedules: AgentSchedule[]
  version: string | null
  author: string | null
  /** Where it came from: an agent file on disk, or the built-in demo. */
  source: 'file' | 'demo'
  file: string
}

export interface AgentLoadProblem { slug: string; file: string; errors: string[] }

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEMO_DIR = path.join(HERE, 'demo')
export const DEMO_AGENT_SLUG = 'demo-assistant'

export function agentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return (env.AGENT_FILES_DIR || '').trim() || path.join(AI_WORKSPACE_DIR, 'agents')
}

function str(v: YamlValue | undefined): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

function strList(v: YamlValue | undefined, field: string, errors: string[]): string[] {
  if (v === null || v === undefined) return []
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean)
  if (!Array.isArray(v)) {
    errors.push(`${field} must be a list`)
    return []
  }
  const out: string[] = []
  for (const x of v) {
    if (typeof x === 'string' || typeof x === 'number') out.push(String(x).trim())
    else errors.push(`${field} must be a list of names`)
  }
  return out.filter(Boolean)
}

/**
 * A knowledge folder is a path RELATIVE to the knowledge-base root. Absolute
 * paths and any ".." segment are rejected here so a file can never point an
 * agent outside the knowledge base.
 */
export function normaliseKnowledgeFolder(raw: string): string | null {
  const s = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!s || s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null
  const parts = s.split('/').filter(p => p !== '' && p !== '.')
  if (parts.length === 0 || parts.some(p => p === '..')) return null
  return parts.join('/')
}

/** Validate + normalise a parsed agent definition. */
export function toChatAgent(
  data: Record<string, YamlValue>,
  opts: { slugHint: string; file: string; body?: string; source?: 'file' | 'demo' },
): { agent: ChatAgent | null; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []

  const slug = str(data.slug).trim() || opts.slugHint
  if (!SLUG_RE.test(slug)) errors.push(`slug "${slug}" must be lowercase letters, digits and dashes`)
  else if (str(data.slug) && opts.slugHint && str(data.slug) !== opts.slugHint) {
    warnings.push(`slug "${str(data.slug)}" differs from its folder "${opts.slugHint}"; the folder name is used`)
  }
  const finalSlug = opts.slugHint && SLUG_RE.test(opts.slugHint) ? opts.slugHint : slug

  const name = str(data.name).trim()
  if (!name) errors.push('name is required')

  const system_prompt = (str(data.system_prompt) || str(data.instructions) || opts.body || '').trim()
  if (!system_prompt) errors.push('system_prompt (instructions) is required')

  const folders: string[] = []
  for (const f of strList(data.knowledge_folders, 'knowledge_folders', errors)) {
    const n = normaliseKnowledgeFolder(f)
    if (n) folders.push(n)
    else errors.push(`knowledge_folders entry "${f}" must be a folder inside the knowledge base (no leading "/" and no "..")`)
  }

  const tools = strList(data.tools, 'tools', errors)
  for (const t of tools) if (!KNOWN_TOOL_NAMES.has(t)) warnings.push(`tool "${t}" is not available in chat and will be ignored`)

  const providerRaw = str(data.provider).trim()
  let provider: ChatProviderId | null = null
  if (providerRaw) {
    if ((CHAT_PROVIDERS as readonly string[]).includes(providerRaw)) provider = providerRaw as ChatProviderId
    else errors.push(`provider "${providerRaw}" must be one of: ${CHAT_PROVIDERS.join(', ')}`)
  }

  const colourRaw = (str(data.colour) || str(data.color)).trim().toLowerCase()
  let colour: AgentColour = 'grey'
  if (colourRaw) {
    const c = colourRaw === 'gray' ? 'grey' : colourRaw
    if ((AGENT_COLOURS as readonly string[]).includes(c)) colour = c as AgentColour
    else warnings.push(`colour "${colourRaw}" is not one of ${AGENT_COLOURS.join(', ')}; using grey`)
  }

  const avatarRaw = str(data.avatar).trim()
  const avatar = avatarRaw ? Array.from(avatarRaw).slice(0, 2).join('') : (name || finalSlug).slice(0, 1).toUpperCase()

  const schedules: AgentSchedule[] = []
  if (Array.isArray(data.schedules)) {
    for (const s of data.schedules) {
      if (s && typeof s === 'object' && !Array.isArray(s)) {
        const o = s as Record<string, YamlValue>
        schedules.push({ name: str(o.name), cron: str(o.cron), prompt: str(o.prompt) })
      }
    }
  }

  const agent: ChatAgent | null = errors.length
    ? null
    : {
        slug: finalSlug,
        name,
        description: str(data.description).trim(),
        avatar,
        colour,
        system_prompt,
        knowledge_folders: folders,
        tools,
        model: str(data.model).trim() || null,
        provider,
        schedules,
        version: str(data.version).trim() || null,
        author: str(data.author).trim() || null,
        source: opts.source ?? 'file',
        file: opts.file,
      }
  return { agent, errors, warnings }
}

/** Parse one agent file's text (agent.yaml or agent.md). */
export function parseAgentText(text: string, file: string, slugHint: string, source: 'file' | 'demo' = 'file') {
  try {
    if (file.endsWith('.md')) {
      const fm = splitFrontMatter(text)
      if (!fm) return { agent: null, errors: ['agent.md must start with a --- front matter block'], warnings: [] }
      return toChatAgent(parseMiniYaml(fm.front), { slugHint, file, body: fm.body, source })
    }
    return toChatAgent(parseMiniYaml(text), { slugHint, file, source })
  } catch (err) {
    return { agent: null, errors: [err instanceof Error ? err.message : String(err)], warnings: [] }
  }
}

function readAgentDir(dir: string, slug: string, source: 'file' | 'demo') {
  for (const name of ['agent.yaml', 'agent.yml', 'agent.md']) {
    const file = path.join(dir, name)
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    return parseAgentText(text, file, slug, source)
  }
  return null
}

export function demoEnabled(env: NodeJS.ProcessEnv = process.env, setting?: string | null): boolean {
  if (/^(1|true|on|yes)$/i.test((env.AGENT_CHAT_DEMO || '').trim())) return true
  return setting === '1'
}

/** Every agent on this install, plus the files that failed to load. */
export function loadChatAgents(opts: { env?: NodeJS.ProcessEnv; includeDemo?: boolean } = {}): {
  agents: ChatAgent[]
  problems: AgentLoadProblem[]
} {
  const agents: ChatAgent[] = []
  const problems: AgentLoadProblem[] = []
  const dir = agentsDir(opts.env)
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    /* no agents dir yet → no file agents */
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || !SLUG_RE.test(e.name)) continue
    const r = readAgentDir(path.join(dir, e.name), e.name, 'file')
    if (!r) continue
    if (r.agent) agents.push(r.agent)
    else problems.push({ slug: e.name, file: path.join(dir, e.name), errors: r.errors })
  }
  if (opts.includeDemo && !agents.some(a => a.slug === DEMO_AGENT_SLUG)) {
    const r = readAgentDir(path.join(DEMO_DIR, 'agents', DEMO_AGENT_SLUG), DEMO_AGENT_SLUG, 'demo')
    if (r?.agent) agents.push(r.agent)
    else if (r) problems.push({ slug: DEMO_AGENT_SLUG, file: DEMO_DIR, errors: r.errors })
  }
  return { agents, problems }
}
