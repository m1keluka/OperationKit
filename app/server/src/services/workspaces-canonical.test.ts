/**
 * canonicalWorkspaceSlug / resolveWriteWorkspace (obj 900667): once a workspace
 * has been folded into another, writes that still name it must land on the
 * successor — otherwise hard-coded fallbacks quietly re-fill the retired org.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-ws-canonical-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const ws = await import('./workspaces.js')

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().exec(`
    INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('example', 'Example');
    INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('your-org', 'Example Growth');
    INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('loop-a', 'A'), ('loop-b', 'B');
  `)
  ws.invalidateWorkspacesCache()
})
afterAll(() => { if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB) })

describe('workspace redirect after a merge', () => {
  it('is the identity before any merge — an unmerged install behaves exactly as before', () => {
    expect(ws.defaultWorkspaceSlug()).toBe('example')
    expect(ws.resolveWriteWorkspace(undefined)).toBe('example')
    expect(ws.resolveWriteWorkspace('  ')).toBe('example')
    expect(ws.resolveWriteWorkspace('your-org')).toBe('your-org')
    expect(ws.resolveWriteWorkspace('not-a-workspace')).toBe('not-a-workspace')
  })

  it('follows merged_into for both the default and an explicit retired slug', () => {
    getDb().prepare("UPDATE workspaces SET archived = 1, merged_into = 'your-org' WHERE slug = 'example'").run()
    ws.invalidateWorkspacesCache()
    expect(ws.canonicalWorkspaceSlug('example')).toBe('your-org')
    expect(ws.defaultWorkspaceSlug()).toBe('your-org')
    expect(ws.resolveWriteWorkspace(undefined)).toBe('your-org')
    expect(ws.resolveWriteWorkspace('example')).toBe('your-org')
    expect(ws.getWorkspace('example')?.merged_into).toBe('your-org')
  })

  it('terminates on a cycle instead of looping', () => {
    getDb().exec(`
      UPDATE workspaces SET merged_into = 'loop-b' WHERE slug = 'loop-a';
      UPDATE workspaces SET merged_into = 'loop-a' WHERE slug = 'loop-b';
    `)
    ws.invalidateWorkspacesCache()
    expect(['loop-a', 'loop-b']).toContain(ws.canonicalWorkspaceSlug('loop-a'))
  })
})


describe("uncached resolver + former hard-coded fallbacks (obj 900667 review)", () => {
  it("resolveWorkspaceIn follows merged_into on an explicit db handle", () => {
    getDb().prepare("UPDATE workspaces SET archived = 1, merged_into = 'your-org' WHERE slug = 'example'").run()
    ws.invalidateWorkspacesCache()
    expect(ws.resolveWorkspaceIn(getDb(), null)).toBe("your-org")
    expect(ws.resolveWorkspaceIn(getDb(), "")).toBe("your-org")
    expect(ws.resolveWorkspaceIn(getDb(), "example")).toBe("your-org")
    expect(ws.resolveWorkspaceIn(getDb(), "loop-a")).not.toBe("your-org")
  })

  it("returns the input unchanged when the workspaces table is unavailable (schema init)", async () => {
    const Database = (await import("better-sqlite3")).default
    const bare = new Database(":memory:")
    expect(ws.resolveWorkspaceIn(bare, undefined)).toBe("example")
    expect(ws.canonicalWorkspaceSlugIn(bare, "x")).toBe("x")
    bare.close()
  })

  it("a card with no workspace gets its KB scope from the canonical workspace, not literal example", async () => {
    getDb().prepare("UPDATE workspaces SET archived = 1, merged_into = 'your-org' WHERE slug = 'example'").run()
    ws.invalidateWorkspacesCache()
    const { buildKbAccessBlock } = await import("./kb-access-prompt.js")
    const text = buildKbAccessBlock({ id: 1, workspace: "" } as never, true).join("\n")
    expect(text).toContain("scoped to your workspace (`your-org`)")
    const legacy = buildKbAccessBlock({ id: 1, workspace: "example" } as never, true).join("\n")
    expect(legacy).toContain("scoped to your workspace (`your-org`)")
  })

  it("no server source file falls back to the literal example workspace", () => {
    const root = path.resolve(__dirname, "..")
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "fixtures") walk(p); continue }
        if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue
        fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
          if (/^\s*(\*|\/\/)/.test(line)) return
          if (/(\|\||\?\?)\s*['"]example['"]/.test(line) || /COALESCE\([^)]*,\s*['"]example['"]\)/.test(line)) {
            offenders.push(path.relative(root, p) + ":" + (i + 1))
          }
        })
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})
