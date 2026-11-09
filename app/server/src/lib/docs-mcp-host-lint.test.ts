/**
 * Docs lint (obj 900293): setup docs must not hardcode one install's MCP host.
 *
 * Every install serves its own `/api/mcp`, so a doc that says
 * `https://some.real.host/api/mcp` sends other installs' bots (and copy-pasting
 * operators) to the wrong server. Setup docs use a placeholder such as
 * `https://<your-install-host>/api/mcp` instead. Local dev hosts are allowed.
 *
 * The scan walks whatever of the doc set exists, so it also runs in the
 * assembled public tree, where some of these paths are stripped.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..', '..')

/** Setup docs that tell an agent or operator where the MCP server lives. */
const DOC_DIRS = ['docs/api']
const DOC_FILES = ['docs/CONNECT-YOUR-AGENT.md']

/**
 * Deliberately fictional hosts used as an illustration right next to a placeholder
 * (CONNECT-YOUR-AGENT.md: "For example `https://ops.example-capital.com/api/mcp`").
 * Exact URLs only. Do not add a real install host here; use the placeholder instead.
 */
const ILLUSTRATIVE_EXAMPLES = new Set(['https://ops.example-capital.com/api/mcp'])

const MCP_URL = /https?:\/\/([^\s`'"()<>\]/]*(?:<[^>]+>[^\s`'"()\]/]*)*)\/api\/mcp\b/g

/** Placeholder (`<…>`, `${…}`, `{…}`, `$VAR`) or a local dev host. */
export function isAllowedMcpHost(host: string): boolean {
  if (/[<{$]/.test(host)) return true
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(host)
}

export function hardcodedMcpHosts(text: string): string[] {
  const bad: string[] = []
  for (const m of text.matchAll(MCP_URL)) {
    if (!isAllowedMcpHost(m[1]) && !ILLUSTRATIVE_EXAMPLES.has(m[0])) bad.push(m[0])
  }
  return bad
}

function walkMarkdown(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkMarkdown(p))
    else if (entry.name.endsWith('.md')) out.push(p)
  }
  return out
}

function setupDocs(): string[] {
  const files = DOC_DIRS.flatMap((d) => walkMarkdown(path.join(repoRoot, d)))
  for (const f of DOC_FILES) {
    const p = path.join(repoRoot, f)
    if (fs.existsSync(p)) files.push(p)
  }
  return files
}

describe('docs lint: no hardcoded MCP host in setup docs', () => {
  it('flags a real hostname and accepts placeholders and local dev hosts', () => {
    expect(hardcodedMcpHosts('attach `https://ops.example-corp.com/api/mcp` now')).toEqual([
      'https://ops.example-corp.com/api/mcp',
    ])
    expect(hardcodedMcpHosts('"server_url": "https://cc.example.com/api/mcp",')).toHaveLength(1)
    expect(
      hardcodedMcpHosts(
        [
          'https://<your-install-host>/api/mcp',
          'https://<address>/api/mcp',
          '"https://<your Operation Kit address>/api/mcp"',
          '${BASE}/api/mcp is not a URL literal',
          'curl http://localhost:3002/api/mcp',
          'https://${HOST}/api/mcp',
        ].join('\n'),
      ),
    ).toEqual([])
  })

  it('finds the setup docs it is meant to guard', () => {
    // docs/api/README.md is published in every tree, so the scan is never vacuous.
    const files = setupDocs().map((f) => path.relative(repoRoot, f))
    expect(files).toContain(path.join('docs', 'api', 'README.md'))
  })

  it('no setup doc hardcodes a non-placeholder MCP host', () => {
    const offenders: string[] = []
    for (const file of setupDocs()) {
      const text = fs.readFileSync(file, 'utf8')
      for (const url of hardcodedMcpHosts(text)) {
        offenders.push(`${path.relative(repoRoot, file)}: ${url}`)
      }
    }
    expect(offenders, 'use https://<your-install-host>/api/mcp instead').toEqual([])
  })
})
