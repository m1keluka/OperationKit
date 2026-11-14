/**
 * Knowledge-base graph report (obj 900815): index one knowledge folder the way
 * the server does and print node / edge / kind / unresolved counts. Read-only:
 * it uses an in-memory database and never writes into the folder.
 *
 *   npx tsx src/scripts/kb-graph-report.ts <kb-folder> [--json] [--exclude a,b] [--unresolved 20]
 */
import Database from 'better-sqlite3'
import path from 'path'
import { kbWorkspaceGraph, readUnresolved, syncGraph } from '../services/kb-wiki/graph.js'
import { parseExcludeSetting } from '../services/kb-wiki/vault-scan.js'

const args = process.argv.slice(2)
const root = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a))
if (!root) {
  console.error('usage: kb-graph-report.ts <kb-folder> [--json] [--exclude a,b] [--unresolved N]')
  process.exit(2)
}
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const excludeArg = flag('--exclude')
const db = new Database(':memory:')
const ws = 'report'
const t0 = Date.now()
const sync = syncGraph(db, ws, path.resolve(root), excludeArg !== undefined ? { excludes: parseExcludeSetting(excludeArg) } : {})
const ms = Date.now() - t0
const g = kbWorkspaceGraph(db, ws)
const kinds = (db.prepare('SELECT kind, COUNT(*) AS n FROM kb_edges WHERE workspace = ? GROUP BY kind ORDER BY n DESC').all(ws) as Array<{ kind: string; n: number }>)
const unresolved = readUnresolved(db, ws, { limit: Number(flag('--unresolved') ?? 15) })
const out = {
  root: path.resolve(root),
  nodes: sync.nodes,
  edges: sync.edges,
  connected_pairs: g.counts.links,
  isolated: g.counts.isolated,
  connected_pages: g.counts.pages - g.counts.isolated,
  node_kinds: g.counts.by_kind,
  edge_kinds: Object.fromEntries(kinds.map(k => [k.kind, k.n])),
  unresolved_links: unresolved.total,
  top_unresolved: unresolved.targets,
  build_ms: ms,
}
if (args.includes('--json')) console.log(JSON.stringify(out, null, 2))
else {
  console.log(`${out.root}`)
  console.log(`  pages ${out.nodes} · edges ${out.edges} · connected pairs ${out.connected_pairs} · isolated ${out.isolated} · built in ${ms} ms`)
  console.log(`  page kinds: ${Object.entries(out.node_kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`)
  console.log(`  edge kinds: ${Object.entries(out.edge_kinds).map(([k, n]) => `${k} ${n}`).join(', ')}`)
  console.log(`  unresolved links: ${out.unresolved_links}`)
  for (const u of out.top_unresolved) console.log(`    ${String(u.count).padStart(4)}  ${u.target}`)
}
