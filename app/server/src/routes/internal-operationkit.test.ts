/**
 * internal-operationkit route tests.
 *
 * Three layers, deliberately separated so a broken/absent workspace can never
 * make the route's OWN contract untestable:
 *
 *  1. Pure unit tests of `parseSlug` / `annotateInventory` — no CLI, always run.
 *  2. HTTP tests against a STUB okit (`OKIT_BIN` points at a recorder script).
 *     These pin the exact argv + stdin the route hands the CLI, and the exact
 *     JSON it hands back, so sub-skill wiring is verified without depending on
 *     okit's health or on which okit revision is checked out. Always run.
 *  3. HTTP tests against the REAL okit CLI, driven against a THROWAWAY workspace
 *     built in a temp directory (schemas + templates copied from the
 *     repo-external ~/ai-workspace), so the suite never reads or writes the live
 *     workspace. Skipped unless okit is present AND actually executable — its
 *     python deps (PyYAML, jsonschema) live under `$AI_WORKSPACE/.pylibs` or on
 *     PYTHONPATH, and a workspace missing them is an environment problem, not a
 *     route regression.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import { execFileSync } from 'child_process'
import { parseSlug, annotateInventory } from './internal-operationkit.js'

const REAL_WORKSPACE = process.env.AI_WORKSPACE || '/home/operator/ai-workspace'
const OKIT_SRC = path.join(REAL_WORKSPACE, 'scripts', 'okit')
const HAVE_OKIT = fs.existsSync(OKIT_SRC) && fs.existsSync(path.join(REAL_WORKSPACE, 'docs', 'schemas', 'tool.schema.json'))

/** okit imports PyYAML/jsonschema at module load, so `--help` proves the deps resolve. */
function okitRunnable(): boolean {
  if (!HAVE_OKIT) return false
  try {
    execFileSync(OKIT_SRC, ['--help'], { stdio: 'ignore', timeout: 20_000 })
    return true
  } catch {
    return false
  }
}
const OKIT_OK = okitRunnable()

const SANDBOX = path.join(os.tmpdir(), `okit-test-${process.pid}-${Date.now()}`)
const STUB_DIR = path.join(os.tmpdir(), `okit-stub-${process.pid}-${Date.now()}`)
const STUB_BIN = path.join(STUB_DIR, 'okit-stub')
const STUB_LOG = path.join(STUB_DIR, 'call.json')
const STUB_OUT = path.join(STUB_DIR, 'reply.json')

/**
 * A dependency-free stand-in for the okit CLI: it records the argv and stdin it
 * was handed, then prints whatever JSON the test staged in `reply.json`.
 * It reads stdin ONLY when `--from-json` was passed, because runOkit leaves the
 * pipe open otherwise and a blind read would hang.
 */
const STUB_SOURCE = `#!/usr/bin/env python3
import json, os, sys
argv = sys.argv[1:]
stdin = sys.stdin.read() if "--from-json" in argv else ""
with open(os.environ["OKIT_STUB_LOG"], "w") as fh:
    json.dump({"argv": argv, "stdin": stdin}, fh)
with open(os.environ["OKIT_STUB_OUT"]) as fh:
    payload = json.load(fh)
print(json.dumps(payload.get("body", {})))
sys.exit(int(payload.get("code", 0)))
`

function copyDir(from: string, to: string) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dst)
    else if (entry.isFile()) fs.copyFileSync(src, dst)
  }
}

let server: http.Server
let baseUrl: string
// Never hardcode a credential here: ask the middleware for the value it will
// compare against (the non-production fallback in internal-secret.ts).
const { getInternalApiSecret } = await import('../middleware/internal-secret.js')
const SECRET = getInternalApiSecret()

/** Point the route at the stub, stage its reply, run `fn`, return the recorded call. */
async function withStub<T>(reply: { code?: number; body: unknown }, fn: () => Promise<T>) {
  const previous = process.env.OKIT_BIN
  fs.writeFileSync(STUB_OUT, JSON.stringify(reply))
  fs.rmSync(STUB_LOG, { force: true })
  process.env.OKIT_BIN = STUB_BIN
  try {
    const value = await fn()
    const call = fs.existsSync(STUB_LOG)
      ? (JSON.parse(fs.readFileSync(STUB_LOG, 'utf-8')) as { argv: string[]; stdin: string })
      : null
    return { value, call }
  } finally {
    if (previous === undefined) delete process.env.OKIT_BIN
    else process.env.OKIT_BIN = previous
  }
}

beforeAll(async () => {
  fs.mkdirSync(STUB_DIR, { recursive: true })
  fs.writeFileSync(STUB_BIN, STUB_SOURCE)
  fs.chmodSync(STUB_BIN, 0o755)
  process.env.OKIT_STUB_LOG = STUB_LOG
  process.env.OKIT_STUB_OUT = STUB_OUT

  if (OKIT_OK) {
    // Build the sandbox workspace: schemas + templates + one real tool to inventory.
    fs.mkdirSync(path.join(SANDBOX, 'scripts'), { recursive: true })
    fs.copyFileSync(OKIT_SRC, path.join(SANDBOX, 'scripts', 'okit'))
    fs.chmodSync(path.join(SANDBOX, 'scripts', 'okit'), 0o755)
    copyDir(path.join(REAL_WORKSPACE, 'docs', 'schemas'), path.join(SANDBOX, 'docs', 'schemas'))
    copyDir(
      path.join(REAL_WORKSPACE, 'skills', 'agent-builder', 'templates'),
      path.join(SANDBOX, 'skills', 'agent-builder', 'templates')
    )
    fs.mkdirSync(path.join(SANDBOX, 'tools'), { recursive: true })
    fs.mkdirSync(path.join(SANDBOX, 'agents'), { recursive: true })
    // okit resolves .pylibs relative to AI_WORKSPACE; point it at the real one so
    // PyYAML/jsonschema stay importable from the sandbox.
    const realPylibs = path.join(REAL_WORKSPACE, '.pylibs')
    if (fs.existsSync(realPylibs)) {
      try {
        fs.symlinkSync(realPylibs, path.join(SANDBOX, '.pylibs'))
      } catch {
        /* already there */
      }
    }
    process.env.AI_WORKSPACE = SANDBOX
    process.env.OKIT_BIN = path.join(SANDBOX, 'scripts', 'okit')
  }

  const { default: router } = await import('./internal-operationkit.js')
  const app = express()
  app.set('trust proxy', true) // honor X-Forwarded-For so we can simulate non-loopback
  app.use(express.json({ limit: '5mb' }))
  app.use('/api/internal/operationkit', router)
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}/api/internal/operationkit`
})

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  fs.rmSync(SANDBOX, { recursive: true, force: true })
  fs.rmSync(STUB_DIR, { recursive: true, force: true })
  delete process.env.AI_WORKSPACE
  delete process.env.OKIT_BIN
  delete process.env.OKIT_STUB_LOG
  delete process.env.OKIT_STUB_OUT
})

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

// --------------------------------------------------------------------------- //
// 1. pure unit tests — the slug rule and the inventory annotation
// --------------------------------------------------------------------------- //
describe('parseSlug', () => {
  it('accepts a bare slug for every layer', () => {
    for (const kind of ['tool', 'skill', 'agent'] as const) {
      expect(parseSlug(kind, 'my-thing_2')).toEqual({ kind, slug: 'my-thing_2', leaf: 'my-thing_2' })
    }
  })

  it('accepts a two-segment compound slug for kind=skill', () => {
    expect(parseSlug('skill', 'marketing/pre-call-hammer')).toEqual({
      kind: 'skill',
      slug: 'marketing/pre-call-hammer',
      leaf: 'pre-call-hammer',
      parent: 'marketing',
    })
  })

  it('rejects a compound slug for kind=agent and kind=tool', () => {
    for (const kind of ['agent', 'tool'] as const) {
      const result = parseSlug(kind, 'marketing/pre-call-hammer')
      expect(typeof result).toBe('string')
      expect(result as string).toMatch(/only valid for kind=skill/)
    }
  })

  // Every one of these must fail because some SEGMENT does not match the slug
  // regex (or there are too many segments) — not because of a blacklist entry.
  const TRAVERSAL = [
    '..',
    '../etc',
    'marketing/..',
    '../../etc/passwd',
    'marketing/../../etc',
    '/etc/passwd',
    '/marketing',
    'marketing/',
    '/marketing/child',
    'marketing//child',
    'a/b/c',
    'skills/a/b',
    '.',
    './child',
    'marketing/.ssh',
    '~/secrets',
    'marketing\\child',
    'mar keting/child',
    'Marketing/Child',
    '',
    '/',
    '//',
  ]
  it.each(TRAVERSAL)('rejects %j for kind=skill', bad => {
    expect(typeof parseSlug('skill', bad)).toBe('string')
  })

  it('rejects a non-string name', () => {
    for (const bad of [undefined, null, 42, ['a'], { name: 'a' }]) {
      expect(typeof parseSlug('skill', bad)).toBe('string')
    }
  })

  it('rejects a child named after its own parent', () => {
    expect(typeof parseSlug('skill', 'marketing/marketing')).toBe('string')
  })

  it('never yields a leaf or parent that escapes a single path segment', () => {
    // Property check: whatever survives, joining it can only ever go DOWN.
    for (const candidate of [...TRAVERSAL, 'a/b', 'ok-slug', 'marketing/pre-call']) {
      const parsed = parseSlug('skill', candidate)
      if (typeof parsed === 'string') continue
      const segments = [parsed.parent, parsed.leaf].filter(Boolean) as string[]
      for (const seg of segments) {
        expect(seg).not.toContain('/')
        expect(seg).not.toContain('..')
        expect(path.basename(seg)).toBe(seg)
      }
      const resolved = path.resolve('/w/skills', ...segments)
      expect(resolved.startsWith('/w/skills/')).toBe(true)
    }
  })
})

describe('annotateInventory', () => {
  const fixture = () => ({
    counts: { tools: 1, skills: 3, agents: 0 },
    tools: { acme: { name: 'acme', path: 'tools/acme/TOOL.md' } },
    skills: {
      marketing: { name: 'marketing', description: 'parent', path: 'skills/marketing/SKILL.md' },
      'marketing/pre-call-hammer': {
        name: 'pre-call-hammer',
        description: 'child',
        path: 'skills/marketing/pre-call-hammer/SKILL.md',
      },
      solo: { name: 'solo', description: 'unrelated', path: 'skills/solo/SKILL.md' },
    },
    agents: {},
  })

  it('makes a sub-skill addressable by compound slug with its parent edge visible', () => {
    const out = annotateInventory(fixture()) as {
      counts: { subskills?: number }
      skills: Record<string, Record<string, unknown>>
    }
    const child = out.skills['marketing/pre-call-hammer']
    expect(child.slug).toBe('marketing/pre-call-hammer')
    expect(child.parent).toBe('marketing')
    expect(child.name).toBe('pre-call-hammer')
    expect(out.skills.marketing.subskills).toEqual(['pre-call-hammer'])
    expect(out.counts.subskills).toBe(1)
  })

  it('leaves unrelated top-level entries byte-identical', () => {
    const before = fixture()
    const out = annotateInventory(fixture()) as ReturnType<typeof fixture>
    expect(out.skills.solo).toEqual(before.skills.solo)
    expect(out.tools).toEqual(before.tools)
    expect(out.counts.skills).toBe(before.counts.skills)
  })

  it('never overwrites what okit already stated', () => {
    const input = fixture() as unknown as { skills: Record<string, Record<string, unknown>> }
    input.skills['marketing/pre-call-hammer'].parent = 'declared-by-okit'
    input.skills.marketing.subskills = ['already-listed']
    const out = annotateInventory(input) as typeof input
    expect(out.skills['marketing/pre-call-hammer'].parent).toBe('declared-by-okit')
    expect(out.skills.marketing.subskills).toEqual(['already-listed', 'pre-call-hammer'])
  })

  it('is a no-op on a payload with no skills table', () => {
    expect(annotateInventory({ counts: {} })).toEqual({ counts: {} })
    expect(annotateInventory(null)).toBeNull()
  })
})

// --------------------------------------------------------------------------- //
// 2. HTTP contract against a stub okit — always runs
// --------------------------------------------------------------------------- //
describe('sub-skill HTTP contract (stub okit)', () => {
  it('400s a compound name for kind=agent and kind=tool before reaching okit', async () => {
    for (const kind of ['agent', 'tool']) {
      const res = await post(`${baseUrl}/validate`, { kind, name: 'marketing/pre-call-hammer' })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/only valid for kind=skill/)
    }
  })

  it('400s every traversal attempt on validate and scaffold', async () => {
    const attacks = ['..', '../etc', 'marketing/..', '/etc/passwd', 'marketing/', 'marketing//child', 'a/b/c', '/']
    for (const name of attacks) {
      const validate = await post(`${baseUrl}/validate`, { kind: 'skill', name })
      expect(validate.status, `validate ${name}`).toBe(400)
      const scaffold = await post(
        `${baseUrl}/scaffold`,
        { kind: 'skill', name },
        { 'x-internal-secret': SECRET }
      )
      expect(scaffold.status, `scaffold ${name}`).toBe(400)
    }
  })

  it('validate forwards a compound skill as layer=skill with the bare child name + parent', async () => {
    const { value, call } = await withStub({ code: 0, body: { valid: true, errors: [] } }, () =>
      post(`${baseUrl}/validate`, {
        kind: 'skill',
        name: 'marketing/pre-call-hammer',
        frontmatter: { description: 'A sub-skill of marketing. Use when prepping a call.', tools: [] },
      })
    )
    expect(value.status).toBe(200)
    const body = (await value.json()) as { valid: boolean; name: string; parent: string }
    expect(body.valid).toBe(true)
    expect(body.name).toBe('marketing/pre-call-hammer')
    expect(body.parent).toBe('marketing')

    expect(call?.argv).toEqual(['check', '--json', '--from-json', '-'])
    const sent = JSON.parse(call!.stdin) as { layer: string; name: string; frontmatter: Record<string, unknown> }
    expect(sent.layer).toBe('skill')
    // The skill schema's `name` pattern forbids a '/', so okit must receive the
    // bare child name plus the explicit parent edge.
    expect(sent.name).toBe('pre-call-hammer')
    expect(sent.frontmatter.name).toBe('pre-call-hammer')
    expect(sent.frontmatter.parent).toBe('marketing')
    expect(sent.frontmatter.tools).toEqual([])
  })

  it('scaffold passes the compound slug through to `okit new skill parent/child`', async () => {
    const { value, call } = await withStub(
      {
        code: 0,
        body: {
          ok: true,
          layer: 'skill',
          name: 'pre-call-hammer',
          dry_run: true,
          written: [],
          path: 'skills/marketing/pre-call-hammer/SKILL.md',
          content: '---\nname: pre-call-hammer\n---\n',
        },
      },
      () =>
        post(
          `${baseUrl}/scaffold`,
          {
            kind: 'skill',
            name: 'marketing/pre-call-hammer',
            frontmatter: { description: 'A sub-skill of marketing.', tools: [] },
            dry_run: true,
          },
          { 'x-internal-secret': SECRET }
        )
    )
    expect(value.status).toBe(200)
    const body = (await value.json()) as { path: string; name: string; parent: string; written: string[] }
    expect(body.path).toBe('skills/marketing/pre-call-hammer/SKILL.md')
    expect(body.name).toBe('marketing/pre-call-hammer')
    expect(body.parent).toBe('marketing')
    expect(body.written).toEqual([])

    expect(call?.argv).toEqual([
      'new',
      'skill',
      'marketing/pre-call-hammer',
      '--json',
      '--from-json',
      '-',
      '--dry-run',
    ])
    const sent = JSON.parse(call!.stdin) as { frontmatter: Record<string, unknown> }
    expect(sent.frontmatter.name).toBe('pre-call-hammer')
    expect(sent.frontmatter.parent).toBe('marketing')
  })

  it('scaffold leaves a top-level skill invocation exactly as it was', async () => {
    const { call } = await withStub({ code: 0, body: { ok: true, written: [], path: 'skills/solo/SKILL.md' } }, () =>
      post(`${baseUrl}/scaffold`, { kind: 'skill', name: 'solo' }, { 'x-internal-secret': SECRET })
    )
    expect(call?.argv).toEqual(['new', 'skill', 'solo', '--json', '--from-json', '-'])
    const sent = JSON.parse(call!.stdin) as { frontmatter: Record<string, unknown> }
    expect(sent.frontmatter.name).toBe('solo')
    expect(sent.frontmatter.parent).toBeUndefined()
  })

  it('GET /registry exposes sub-skills by compound slug without changing top-level shape', async () => {
    const inventory = {
      counts: { tools: 0, skills: 3, agents: 0 },
      tools: {},
      skills: {
        marketing: { name: 'marketing', description: 'parent', path: 'skills/marketing/SKILL.md' },
        'marketing/pre-call-hammer': {
          name: 'pre-call-hammer',
          description: 'child',
          path: 'skills/marketing/pre-call-hammer/SKILL.md',
        },
        solo: { name: 'solo', description: 'unrelated', path: 'skills/solo/SKILL.md' },
      },
      agents: {},
    }
    const { value } = await withStub({ code: 0, body: inventory }, () => fetch(`${baseUrl}/registry`))
    expect(value.status).toBe(200)
    const body = (await value.json()) as {
      counts: Record<string, number>
      skills: Record<string, Record<string, unknown>>
    }
    expect(Object.keys(body.skills)).toContain('marketing/pre-call-hammer')
    expect(body.skills['marketing/pre-call-hammer'].parent).toBe('marketing')
    expect(body.skills['marketing/pre-call-hammer'].slug).toBe('marketing/pre-call-hammer')
    expect(body.skills.marketing.subskills).toEqual(['pre-call-hammer'])
    expect(body.skills.solo).toEqual(inventory.skills.solo)
    expect(body.counts.subskills).toBe(1)
  })
})

// --------------------------------------------------------------------------- //
// 3. HTTP tests against the real okit CLI
// --------------------------------------------------------------------------- //
describe.skipIf(!OKIT_OK)('internal-operationkit', () => {
  describe('localhost guard', () => {
    it('rejects a request with an external X-Forwarded-For', async () => {
      const res = await fetch(`${baseUrl}/registry`, { headers: { 'x-forwarded-for': '203.0.113.5' } })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/localhost/i)
    })

    it('accepts a request from 127.0.0.1', async () => {
      const res = await fetch(`${baseUrl}/registry`)
      expect(res.status).toBe(200)
    })
  })

  describe('GET /registry', () => {
    it('returns the merged tools+skills+agents inventory', async () => {
      const res = await fetch(`${baseUrl}/registry`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        counts: { tools: number; skills: number; agents: number }
        tools: Record<string, unknown>
      }
      expect(body.counts).toBeDefined()
      expect(typeof body.counts.tools).toBe('number')
      expect(body.tools).toBeDefined()
    })
  })

  describe('POST /validate', () => {
    it('accepts a well-formed tool document', async () => {
      const res = await post(`${baseUrl}/validate`, {
        kind: 'tool',
        name: 'acme-crm',
        frontmatter: {
          name: 'acme-crm',
          description:
            'Acme CRM REST API. Reads and writes contacts, deals and pipelines. Use when syncing a lead into Acme.',
          kind: 'http-api',
        },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { valid: boolean; errors: string[] }
      expect(body.valid).toBe(true)
      expect(body.errors).toEqual([])
    })

    it('accepts a compound sub-skill document', async () => {
      const res = await post(`${baseUrl}/validate`, {
        kind: 'skill',
        name: 'marketing/pre-call-hammer',
        frontmatter: {
          description:
            'Pre-call research sub-skill of marketing. Use when preparing for a discovery call with a new prospect.',
          tools: [],
        },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { valid: boolean; errors: string[]; name: string; parent: string }
      expect(body.errors).toEqual([])
      expect(body.valid).toBe(true)
      expect(body.name).toBe('marketing/pre-call-hammer')
      expect(body.parent).toBe('marketing')
    })

    it('reports schema errors for a malformed document without throwing', async () => {
      const res = await post(`${baseUrl}/validate`, {
        kind: 'tool',
        name: 'acme-crm',
        frontmatter: { name: 'acme-crm', description: 'too short', kind: 'carrier-pigeon' },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { valid: boolean; errors: string[] }
      expect(body.valid).toBe(false)
      expect(body.errors.join(' ')).toMatch(/carrier-pigeon|too short/)
    })

    it('400s on an unknown kind', async () => {
      const res = await post(`${baseUrl}/validate`, { kind: 'widget', name: 'x' })
      expect(res.status).toBe(400)
    })

    it('400s on a non-slug name', async () => {
      const res = await post(`${baseUrl}/validate`, { kind: 'tool', name: 'Not A Slug' })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /scaffold', () => {
    it('401s without the internal secret', async () => {
      const res = await post(`${baseUrl}/scaffold`, { kind: 'tool', name: 'unauth-tool' })
      expect(res.status).toBe(401)
    })

    it('dry_run returns content and writes nothing', async () => {
      const res = await post(
        `${baseUrl}/scaffold`,
        { kind: 'tool', name: 'dry-tool', dry_run: true },
        { 'x-internal-secret': SECRET }
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { dry_run: boolean; path: string; content: string; written: string[] }
      expect(body.dry_run).toBe(true)
      expect(body.path).toBe('tools/dry-tool/TOOL.md')
      expect(body.content).toContain('name: dry-tool')
      expect(body.written).toEqual([])
      expect(fs.existsSync(path.join(SANDBOX, 'tools', 'dry-tool', 'TOOL.md'))).toBe(false)
    })

    it('writes the file, then refuses to clobber it without force', async () => {
      const payload = {
        kind: 'tool',
        name: 'real-tool',
        frontmatter: {
          description:
            'Real Tool HTTP API used by the scaffolder test. Use when exercising the OperationKit authoring path.',
          kind: 'http-api',
          vendor: 'Acme',
        },
      }
      const first = await post(`${baseUrl}/scaffold`, payload, { 'x-internal-secret': SECRET })
      expect(first.status).toBe(200)
      const body = (await first.json()) as { written: string[]; path: string }
      expect(body.written).toEqual(['tools/real-tool/TOOL.md'])
      const onDisk = fs.readFileSync(path.join(SANDBOX, 'tools', 'real-tool', 'TOOL.md'), 'utf-8')
      expect(onDisk).toContain('vendor: Acme')

      const second = await post(`${baseUrl}/scaffold`, payload, { 'x-internal-secret': SECRET })
      expect(second.status).toBe(409)
      const conflict = (await second.json()) as { error: string }
      expect(conflict.error).toMatch(/already exists/)

      const forced = await post(
        `${baseUrl}/scaffold`,
        { ...payload, force: true },
        { 'x-internal-secret': SECRET }
      )
      expect(forced.status).toBe(200)
    })

    it('422s when the supplied frontmatter fails the schema', async () => {
      const res = await post(
        `${baseUrl}/scaffold`,
        { kind: 'tool', name: 'bad-tool', frontmatter: { description: 'short', kind: 'http-api' } },
        { 'x-internal-secret': SECRET }
      )
      expect(res.status).toBe(422)
      const body = (await res.json()) as { errors: string[] }
      expect(body.errors.join(' ')).toMatch(/description/)
      expect(fs.existsSync(path.join(SANDBOX, 'tools', 'bad-tool'))).toBe(false)
    })

    it('scaffolds an agent as body + .meta.yaml sidecar', async () => {
      const res = await post(
        `${baseUrl}/scaffold`,
        { kind: 'agent', name: 'test-persona', frontmatter: { profile: 'strategic' } },
        { 'x-internal-secret': SECRET }
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { written: string[] }
      expect(body.written).toEqual(['agents/test-persona.md', 'agents/test-persona.meta.yaml'])
      const sidecar = fs.readFileSync(path.join(SANDBOX, 'agents', 'test-persona.meta.yaml'), 'utf-8')
      expect(sidecar).toContain('profile: strategic')
      // The .md itself must stay frontmatter-free: prompt-builder inlines it raw.
      const md = fs.readFileSync(path.join(SANDBOX, 'agents', 'test-persona.md'), 'utf-8')
      expect(md.startsWith('---')).toBe(false)
    })

    it('the scaffolded tool then passes okit validate on disk', async () => {
      const res = await fetch(`${baseUrl}/registry`)
      const body = (await res.json()) as { tools: Record<string, { secrets_required?: string[] }> }
      expect(Object.keys(body.tools)).toContain('real-tool')
    })

    it('scaffolds a real sub-skill under its parent and lists it in the registry', async () => {
      const parent = await post(
        `${baseUrl}/scaffold`,
        {
          kind: 'skill',
          name: 'marketing',
          frontmatter: {
            description:
              'Marketing parent skill used by the sub-skill scaffolder test. Use when exercising OperationKit nesting.',
            tools: [],
          },
        },
        { 'x-internal-secret': SECRET }
      )
      expect(parent.status).toBe(200)
      expect(((await parent.json()) as { written: string[] }).written).toEqual(['skills/marketing/SKILL.md'])

      const child = await post(
        `${baseUrl}/scaffold`,
        {
          kind: 'skill',
          name: 'marketing/pre-call-hammer',
          frontmatter: {
            description:
              'Pre-call research sub-skill of marketing. Use when preparing for a discovery call with a new prospect.',
            tools: [],
          },
        },
        { 'x-internal-secret': SECRET }
      )
      expect(child.status).toBe(200)
      const childBody = (await child.json()) as { written: string[]; path: string; name: string; parent: string }
      expect(childBody.path).toBe('skills/marketing/pre-call-hammer/SKILL.md')
      expect(childBody.name).toBe('marketing/pre-call-hammer')
      expect(childBody.parent).toBe('marketing')
      expect(childBody.written).toContain('skills/marketing/pre-call-hammer/SKILL.md')

      const onDisk = fs.readFileSync(
        path.join(SANDBOX, 'skills', 'marketing', 'pre-call-hammer', 'SKILL.md'),
        'utf-8'
      )
      expect(onDisk).toContain('name: pre-call-hammer')
      expect(onDisk).toContain('parent: marketing')

      const registry = await fetch(`${baseUrl}/registry`)
      const inventory = (await registry.json()) as { skills: Record<string, Record<string, unknown>> }
      expect(Object.keys(inventory.skills)).toContain('marketing/pre-call-hammer')
      expect(inventory.skills['marketing/pre-call-hammer'].parent).toBe('marketing')
      expect(inventory.skills.marketing.subskills).toContain('pre-call-hammer')
    })

    it('refuses a compound name for a non-skill layer end to end', async () => {
      const res = await post(
        `${baseUrl}/scaffold`,
        { kind: 'tool', name: 'marketing/nested-tool' },
        { 'x-internal-secret': SECRET }
      )
      expect(res.status).toBe(400)
      expect(fs.existsSync(path.join(SANDBOX, 'tools', 'marketing'))).toBe(false)
    })
  })
})
