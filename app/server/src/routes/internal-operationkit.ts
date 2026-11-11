/**
 * OperationKit authoring API — /api/internal/operationkit (localhost-only).
 *
 * The "add a tool/skill/agent over HTTP" half of the OperationKit three-layer
 * restructure (Tools -> Skills -> Agents, see ~/ai-workspace/docs/operationkit-architecture.md).
 * Every route is a thin, non-interactive wrapper over the `okit` CLI at
 * ~/ai-workspace/scripts/okit, which owns schema validation, template rendering
 * and registry generation. The server deliberately holds NO copy of that logic:
 * one implementation, driven from either a terminal or this API.
 *
 *   GET  /registry   merged tools+skills+agents inventory  (okit inventory --json)
 *   POST /validate   {kind,name,frontmatter,body} -> {valid,errors[]}  (okit check --json)
 *   POST /scaffold   {kind,name,frontmatter,body,dry_run} -> path + content  (okit new --json)
 *
 * SUB-SKILLS. The skills layer nests exactly one level: a sub-skill lives at
 * `skills/<parent>/<child>/SKILL.md` and is addressed by the COMPOUND SLUG
 * `parent/child`. Top-level skills keep their bare slug. Each segment
 * individually satisfies the ordinary slug rule, and the compound form is
 * exactly two such segments joined by a single `/`. Only `kind=skill` may be
 * compound — agents and tools stay single-segment. A sub-skill's frontmatter
 * carries `name: <child>` (bare, matching its own directory) plus
 * `parent: <parent>`; the parent lists its children under `subskills:`.
 * `GET /registry` keys a sub-skill by its compound slug and makes both sides of
 * that edge visible.
 *
 * Because a `name` value becomes a filesystem path, `parseSlug()` — the one
 * place the rule lives — is written so traversal is impossible BY CONSTRUCTION
 * rather than by blacklist: the input is split on `/` and every segment must
 * match the slug regex, whose character class contains no `.`, no separator and
 * no empty match. `..`, `a//b`, `/abs`, `a/`, `a/b/c` and `..%2f`-style decodes
 * therefore all fail without being special-cased.
 *
 * Auth: localhost origin for every route (defense in depth), PLUS the
 * X-Internal-Secret shared secret on /scaffold, which is the only route that
 * writes to disk — same split internal-vault.ts (read-only, no secret) and
 * internal-routines.ts (mutating, secret) already use.
 *
 * Secrets: this surface never carries a credential VALUE. Tool frontmatter
 * references credentials by environment-variable NAME, and `okit registry`
 * drops even the storage `source` when it builds tools/registry.json.
 */
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { isLocalhost } from '../lib/is-localhost.js'
import { requireInternalSecret } from '../middleware/internal-secret.js'

const router = Router()

const LAYERS = ['tool', 'skill', 'agent'] as const
type Layer = (typeof LAYERS)[number]
/** Slug rule shared with okit: lowercase alphanumerics/underscore, hyphen-separated. */
const SLUG_RE = /^[a-z0-9_]+(-[a-z0-9_]+)*$/
/** Sub-skill nesting depth. `parent/child` and nothing deeper. */
const MAX_SEGMENTS = 2
const OKIT_TIMEOUT_MS = 60_000
/** The merged inventory is ~80 skills of prose; give stdout real headroom. */
const OKIT_MAX_BUFFER = 32 * 1024 * 1024
/** Skill dirs excluded from the layer graph, so never treated as a sub-skill parent. */
const GRAPH_EXCLUDED = new Set(['ghl-lead-loader'])

export function workspaceRoot(): string {
  return process.env.AI_WORKSPACE || '/home/operator/ai-workspace'
}

export function okitBin(): string {
  return process.env.OKIT_BIN || path.join(workspaceRoot(), 'scripts', 'okit')
}

/** A resolved `{kind,name}` address. `slug` is what the caller sent; `leaf` is the directory. */
export interface SlugTarget {
  kind: Layer
  /** Address form: `child` for a top-level entry, `parent/child` for a sub-skill. */
  slug: string
  /** Own directory name — what frontmatter `name:` must equal. */
  leaf: string
  /** Present only for a sub-skill. */
  parent?: string
}

/**
 * Parse a `{kind,name}` address into a traversal-proof target.
 *
 * Returns a string on rejection (the 400 message) and never a partially-trusted
 * value. Compound (two-segment) addresses are accepted for `skill` only.
 */
export function parseSlug(kind: Layer, raw: unknown): SlugTarget | string {
  if (typeof raw !== 'string' || raw.length === 0) {
    return 'name required: lowercase slug, e.g. my-tool'
  }
  // Split first, THEN test each segment. Every rejection below falls out of the
  // slug regex itself — there is no blacklist to forget an entry in.
  const segments = raw.split('/')
  if (segments.length > MAX_SEGMENTS) {
    return `name: at most ${MAX_SEGMENTS} slash-separated segments (skills/<parent>/<child>)`
  }
  if (!segments.every(seg => SLUG_RE.test(seg))) {
    return 'name required: lowercase slug, e.g. my-tool (a sub-skill is parent/child)'
  }
  if (segments.length === 1) {
    return { kind, slug: raw, leaf: segments[0] }
  }
  if (kind !== 'skill') {
    return `name: a compound parent/child slug is only valid for kind=skill, not ${kind}`
  }
  const [parent, leaf] = segments
  if (parent === leaf) {
    return 'name: a sub-skill may not be named after its parent'
  }
  return { kind, slug: raw, leaf, parent }
}

interface OkitResult {
  code: number
  stdout: string
  stderr: string
}

/** Run the okit CLI. Never throws on a non-zero exit — the exit code is data. */
export function runOkit(args: string[], stdin?: string): Promise<OkitResult> {
  return new Promise((resolve, reject) => {
    const bin = okitBin()
    if (!fs.existsSync(bin)) {
      reject(new Error(`okit CLI not found at ${bin}`))
      return
    }
    const child = execFile(
      bin,
      args,
      { timeout: OKIT_TIMEOUT_MS, maxBuffer: OKIT_MAX_BUFFER, env: { ...process.env, AI_WORKSPACE: workspaceRoot() } },
      (err, stdout, stderr) => {
        // execFile reports a non-zero exit as an error carrying `code`. okit uses
        // exit 1 to mean "invalid", which is a normal answer, not a failure.
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 0
        if (err && typeof (err as { code?: unknown }).code !== 'number') {
          reject(err)
          return
        }
        resolve({ code, stdout, stderr })
      }
    )
    if (stdin !== undefined) {
      child.stdin?.end(stdin)
    }
  })
}

function parseJson(result: OkitResult, what: string): unknown {
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(
      `${what}: okit did not return JSON (exit ${result.code}): ${(result.stderr || result.stdout).slice(0, 500)}`
    )
  }
}

/** Validate the {kind,name} pair every write/validate route shares. */
function readTarget(req: Request, res: Response): SlugTarget | null {
  const body = (req.body || {}) as { kind?: string; layer?: string; name?: string }
  const kind = (body.kind || body.layer) as Layer | undefined
  if (!kind || !LAYERS.includes(kind)) {
    res.status(400).json({ error: `kind required, one of ${LAYERS.join(', ')}` })
    return null
  }
  const parsed = parseSlug(kind, body.name)
  if (typeof parsed === 'string') {
    res.status(400).json({ error: parsed })
    return null
  }
  return parsed
}

/**
 * Frontmatter okit is handed for a target: `name` is always the target's OWN
 * directory (bare, never the compound address — the skill schema's `name`
 * pattern rejects a `/`), and a sub-skill declares its `parent` unless the
 * caller already did.
 */
function frontmatterFor(target: SlugTarget, supplied: unknown): Record<string, unknown> {
  const fm: Record<string, unknown> = { ...(supplied as Record<string, unknown> | undefined) }
  fm.name = target.leaf
  if (target.parent !== undefined && fm.parent === undefined) fm.parent = target.parent
  return fm
}

type InventoryEntry = Record<string, unknown>

/**
 * Guarantee that a sub-skill in the okit inventory is addressable by its
 * compound slug and that its parent edge is visible from both ends.
 *
 * okit already keys a sub-skill by its S2 compound slug and copies `parent` /
 * `subskills` out of frontmatter. This is a NON-DESTRUCTIVE backstop, not a
 * second implementation: it only fills in what is absent, deriving it from the
 * compound KEY itself, and never overwrites a value okit stated. That keeps the
 * response correct against an older okit (or a skill whose frontmatter forgot
 * one side of the edge) without the server owning the nesting rule.
 *
 * Top-level entries are returned untouched apart from the additive `subskills`
 * list, which appears only on a parent that actually has children.
 */
export function annotateInventory(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const root = payload as Record<string, unknown>
  const skills = root.skills
  if (!skills || typeof skills !== 'object' || Array.isArray(skills)) return payload
  const table = skills as Record<string, InventoryEntry>
  const children: Record<string, string[]> = {}
  let subskills = 0

  for (const [key, entry] of Object.entries(table)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    if (!key.includes('/')) continue
    const parsed = parseSlug('skill', key)
    // A key we cannot parse is left exactly as okit emitted it — annotating is
    // additive, never a filter, so an unexpected key is still reachable.
    if (typeof parsed === 'string' || !parsed.parent) continue
    entry.slug = key
    if (entry.parent === undefined) entry.parent = parsed.parent
    subskills += 1
    if (GRAPH_EXCLUDED.has(parsed.parent) || parsed.parent.startsWith('_')) continue
    ;(children[parsed.parent] ||= []).push(parsed.leaf)
  }

  for (const [parent, kids] of Object.entries(children)) {
    const entry = table[parent]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const declared = Array.isArray(entry.subskills) ? (entry.subskills as unknown[]).map(String) : []
    entry.subskills = [...new Set([...declared, ...kids])].sort()
  }

  if (subskills > 0 && root.counts && typeof root.counts === 'object' && !Array.isArray(root.counts)) {
    const counts = root.counts as Record<string, unknown>
    if (counts.subskills === undefined) counts.subskills = subskills
  }
  return root
}

// Localhost guard for the whole router. Mutating routes add the shared secret below.
router.use((req: Request, res: Response, next: NextFunction) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  next()
})

/**
 * GET /api/internal/operationkit/registry
 * Merged tools + skills + agents inventory, read live from the workspace.
 * Read-only: does not regenerate registry.json (use ?rebuild=1 for that).
 * Sub-skills appear under their compound `parent/child` key, carrying `parent`;
 * the parent entry carries the reciprocal `subskills` list.
 */
router.get('/registry', async (req: Request, res: Response) => {
  try {
    if (req.query.rebuild === '1' || req.query.rebuild === 'true') {
      if (!requireInternalSecret(req, res)) return
      const rebuild = await runOkit(['registry', '--json'])
      if (rebuild.code !== 0) {
        console.error('[operationkit] registry rebuild failed:', rebuild.stderr)
        res.status(500).json({ error: 'registry rebuild failed', detail: rebuild.stderr.slice(0, 500) })
        return
      }
    }
    const result = await runOkit(['inventory', '--json'])
    if (result.code !== 0) {
      console.error('[operationkit] inventory failed:', result.stderr)
      res.status(500).json({ error: 'inventory failed', detail: result.stderr.slice(0, 500) })
      return
    }
    res.json(annotateInventory(parseJson(result, 'registry')))
  } catch (err) {
    const message = err instanceof Error ? err.message : 'registry failed'
    console.error('[operationkit] registry error:', message)
    res.status(500).json({ error: message })
  }
})

/**
 * POST /api/internal/operationkit/validate
 * Body: { kind, name, frontmatter, body? } -> { valid, errors[] }
 * Pure: validates the supplied document in memory, touching no file.
 * `name` may be a compound `parent/child` sub-skill address (kind=skill only).
 */
router.post('/validate', async (req: Request, res: Response) => {
  const target = readTarget(req, res)
  if (!target) return
  const { frontmatter, body } = (req.body || {}) as { frontmatter?: unknown; body?: string }
  if (frontmatter !== undefined && (typeof frontmatter !== 'object' || Array.isArray(frontmatter) || frontmatter === null)) {
    res.status(400).json({ error: 'frontmatter must be an object' })
    return
  }
  try {
    const payload = JSON.stringify({
      layer: target.kind,
      name: target.leaf,
      frontmatter: frontmatterFor(target, frontmatter),
      body: body ?? '',
    })
    const result = await runOkit(['check', '--json', '--from-json', '-'], payload)
    const parsed = parseJson(result, 'validate') as { valid?: boolean; errors?: string[] }
    res.json({
      valid: !!parsed.valid,
      errors: parsed.errors || [],
      kind: target.kind,
      name: target.slug,
      ...(target.parent ? { parent: target.parent } : {}),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'validate failed'
    console.error('[operationkit] validate error:', message)
    res.status(500).json({ error: message })
  }
})

/**
 * POST /api/internal/operationkit/scaffold
 * Body: { kind, name, frontmatter?, body?, dry_run?, force? }
 * Validates first, then writes via the okit CLI. dry_run:true returns the
 * would-be content and never touches disk. Refuses to clobber without force.
 *
 * A compound `parent/child` name is passed through to `okit new skill
 * parent/child` verbatim — okit's own path builder nests it to
 * `skills/<parent>/<child>/SKILL.md`, so the nesting rule lives in exactly one
 * place. The frontmatter okit receives carries the bare child `name` plus
 * `parent`.
 */
router.post('/scaffold', async (req: Request, res: Response) => {
  if (!requireInternalSecret(req, res)) return
  const target = readTarget(req, res)
  if (!target) return
  const { frontmatter, body, dry_run: dryRun, force } = (req.body || {}) as {
    frontmatter?: unknown
    body?: string
    dry_run?: boolean
    force?: boolean
  }
  if (frontmatter !== undefined && (typeof frontmatter !== 'object' || Array.isArray(frontmatter) || frontmatter === null)) {
    res.status(400).json({ error: 'frontmatter must be an object' })
    return
  }
  try {
    const args = ['new', target.kind, target.slug, '--json', '--from-json', '-']
    if (dryRun) args.push('--dry-run')
    if (force) args.push('--force')
    const payload = JSON.stringify({
      frontmatter: frontmatterFor(target, frontmatter),
      ...(body ? { body } : {}),
    })
    const result = await runOkit(args, payload)
    const parsed = parseJson(result, 'scaffold') as Record<string, unknown>
    if (result.code === 1) {
      // schema failure — the document is bad, not the request
      res.status(422).json({ error: 'frontmatter failed schema validation', ...parsed })
      return
    }
    if (result.code !== 0) {
      // exit 2 = refused to clobber, or an IO/usage error
      res.status(409).json({ error: (parsed.error as string) || 'scaffold refused', ...parsed })
      return
    }
    console.log(
      `[operationkit] scaffold ${target.kind}/${target.slug}` +
        (dryRun ? ' (dry-run, nothing written)' : ` -> ${(parsed.written as string[] | undefined)?.join(', ')}`)
    )
    res.json({ ...parsed, name: target.slug, ...(target.parent ? { parent: target.parent } : {}) })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'scaffold failed'
    console.error('[operationkit] scaffold error:', message)
    res.status(500).json({ error: message })
  }
})

export default router
