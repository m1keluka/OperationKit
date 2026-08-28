import Database from 'better-sqlite3'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Semantic vault index for spawn-context KB injection (ST6).
 *
 * BACKGROUND: the original retrieval path (knowledge-search.ts) is grep-only —
 * a bounded `/usr/bin/grep` sweep with IDF ranking, chosen in 2026-06-12 because
 * "there is no qmd binary, hybrid-search service, or sqlite/FTS index anywhere
 * on this host" and rg was not installed in the container. That host constraint
 * is now lifted: `better-sqlite3` (already a runtime dependency) ships SQLite
 * with FTS5 compiled in, verified working in-container. FTS5 gives us BM25
 * relevance ranking + Porter stemming, and a curated synonym-expansion layer
 * bridges true paraphrase ("outage" -> "incident", "availability" -> "uptime")
 * that a lexical grep can never reach.
 *
 * Why FTS5 and not embeddings: the vault is ~1.4k markdown files / <10 MB.
 * Per personal/decisions/2026-04-24-kb-retrieval-approach.md, that scale is too
 * small for vector retrieval to earn its keep, and there is no offline embedding
 * model or runtime in the container — embeddings would require a network model
 * download, i.e. a hard new infra dependency we are told to avoid. FTS5 is
 * self-contained, drift-free (rebuilt from the vault on a content signature),
 * and degrades safely: any failure here returns [] and knowledge-search.ts
 * falls back to the original grep path.
 *
 * Synchronous throughout (better-sqlite3 is sync) to match the synchronous
 * buildContext() / searchKnowledge() call path.
 */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'what', 'when',
  'where', 'which', 'will', 'should', 'would', 'could', 'have', 'has', 'had',
  'are', 'was', 'were', 'been', 'being', 'not', 'but', 'all', 'any', 'can',
  'may', 'must', 'our', 'your', 'their', 'its', 'use', 'using', 'used', 'via',
  'per', 'each', 'also', 'more', 'most', 'some', 'such', 'then', 'than',
  'them', 'they', 'you', 'how', 'why', 'who', 'out', 'get', 'set', 'new',
  'add', 'fix', 'run', 'make', 'need', 'needs', 'needed', 'does', 'doing',
  'done', 'only', 'just', 'here', 'there', 'about', 'after', 'before',
  'between', 'over', 'under', 'these', 'those', 'other', 'same', 'very',
  'objective', 'context', 'session', 'sessions', 'task', 'tasks', 'file',
  'files', 'currently', 'ensure', 'create', 'update', 'inject', 'support',
])

/**
 * Curated bidirectional synonym clusters for the ops/agent/infra vocabulary
 * this vault is written in. Each query term is expanded to its cluster
 * siblings before the FTS MATCH, so a paraphrase that shares no surface tokens
 * with a document ("service outage" vs a doc that only ever says "incident" /
 * "uptime") still retrieves it. Porter stemming inside FTS5 handles morphology
 * (plurals, -ing/-ed) on top of this, so clusters list lemmas, not every form.
 * This is the deliberate, documented "semantic" lever over plain grep.
 */
const SYNONYM_CLUSTERS: string[][] = [
  ['outage', 'incident', 'downtime', 'disruption', 'failure'],
  ['availability', 'uptime', 'reliability', 'liveness'],
  ['monitor', 'monitoring', 'observability', 'alerting', 'telemetry'],
  ['retrieval', 'search', 'lookup', 'recall', 'fetch'],
  ['embedding', 'vector', 'semantic'],
  ['worker', 'agent', 'subagent', 'delegate'],
  ['spawn', 'launch', 'provision', 'bootstrap'],
  ['deploy', 'deployment', 'release', 'ship', 'rollout'],
  ['schedule', 'scheduling', 'cron', 'recurring'],
  ['vault', 'knowledgebase', 'secondbrain'],
  ['credential', 'secret', 'token', 'apikey', 'auth'],
  ['email', 'mail', 'inbox', 'message'],
  ['cost', 'budget', 'spend', 'pricing'],
  ['error', 'failure', 'bug', 'fault'],
  ['migration', 'schema'],
]

const SYNONYMS: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>()
  for (const cluster of SYNONYM_CLUSTERS) {
    for (const term of cluster) {
      const others = cluster.filter((t) => t !== term)
      m.set(term, [...(m.get(term) || []), ...others])
    }
  }
  return m
})()

export interface VaultHit {
  path: string
  snippet: string
}

const SNIPPET_CHARS = 400
const MAX_DOCS = 5000
const MAX_HITS = 5
const WORKSPACE_BONUS = 2.0
const EXCLUDE_DIRS = new Set(['.obsidian', '_import', '_system', 'node_modules', '.git'])

function extractTerms(query: string, max = 8): string[] {
  const seen = new Set<string>()
  for (const raw of query.toLowerCase().split(/[^a-z0-9-]+/)) {
    const word = raw.replace(/^-+|-+$/g, '')
    if (word.length < 3 || word.length > 40) continue
    if (/^\d+$/.test(word)) continue
    if (STOPWORDS.has(word)) continue
    seen.add(word)
    if (seen.size >= max) break
  }
  return [...seen]
}

function expandTerms(terms: string[]): string[] {
  const out = new Set<string>()
  for (const t of terms) {
    out.add(t)
    for (const syn of SYNONYMS.get(t) || []) out.add(syn)
  }
  return [...out]
}

interface VaultDoc {
  path: string
  mtimeMs: number
}

/** Walk the vault collecting indexable markdown docs (same scope as the grep path). */
function collectDocs(root: string): VaultDoc[] {
  const docs: VaultDoc[] = []
  const stack: string[] = [root]
  while (stack.length > 0 && docs.length < MAX_DOCS) {
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (EXCLUDE_DIRS.has(ent.name)) continue
        stack.push(join(dir, ent.name))
      } else if (ent.isFile() && ent.name.endsWith('.md') && ent.name !== 'index.md') {
        const full = join(dir, ent.name)
        try {
          docs.push({ path: full, mtimeMs: statSync(full).mtimeMs })
        } catch {
          // unreadable — skip
        }
      }
    }
  }
  return docs
}

/** Cheap content signature so the index rebuilds only when the vault changes. */
function signatureOf(docs: VaultDoc[]): string {
  let maxMtime = 0
  for (const d of docs) if (d.mtimeMs > maxMtime) maxMtime = d.mtimeMs
  return `${docs.length}:${Math.round(maxMtime)}`
}

function stripFrontmatter(text: string): { title: string; tags: string; body: string } {
  let title = ''
  let tags = ''
  let body = text
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3)
    if (end > 0) {
      const fm = text.slice(3, end)
      body = text.slice(end + 4)
      const tm = fm.match(/(?:^|\n)\s*title:\s*"?([^"\n]+)"?/i)
      if (tm) title = tm[1].trim()
      const gm = fm.match(/(?:^|\n)\s*tags:\s*\[([^\]]*)\]/i)
      if (gm) tags = gm[1].replace(/[\[\]"']/g, ' ')
    }
  }
  return { title, tags, body }
}

interface CachedIndex {
  db: Database.Database
  signature: string
}

let cache: CachedIndex | null = null

function buildIndex(root: string, docs: VaultDoc[]): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = OFF')
  db.exec(
    "CREATE VIRTUAL TABLE docs USING fts5(" +
      "path UNINDEXED, title, tags, body, " +
      "tokenize = 'porter unicode61 remove_diacritics 2')"
  )
  const insert = db.prepare('INSERT INTO docs (path, title, tags, body) VALUES (?, ?, ?, ?)')
  const tx = db.transaction((rows: VaultDoc[]) => {
    for (const d of rows) {
      let raw: string
      try {
        raw = readFileSync(d.path, 'utf8').slice(0, 65536)
      } catch {
        continue
      }
      const { title, tags, body } = stripFrontmatter(raw)
      insert.run(d.path, title, tags, body)
    }
  })
  tx(docs)
  return db
}

function getIndex(root: string): Database.Database | null {
  const docs = collectDocs(root)
  if (docs.length === 0) return null
  const sig = signatureOf(docs)
  if (cache && cache.signature === sig) return cache.db
  if (cache) {
    try {
      cache.db.close()
    } catch {
      // ignore
    }
    cache = null
  }
  const db = buildIndex(root, docs)
  cache = { db, signature: sig }
  return db
}

function makeSnippet(file: string, terms: string[]): string {
  let text = readFileSync(file, 'utf8').slice(0, 65536)
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3)
    if (end > 0) text = text.slice(end + 4)
  }
  const lower = text.toLowerCase()
  let pos = -1
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i >= 0 && (pos < 0 || i < pos)) pos = i
  }
  const start = Math.max(0, (pos < 0 ? 0 : pos) - 120)
  const snippet = text.slice(start, start + SNIPPET_CHARS).replace(/\s+/g, ' ').trim()
  return (start > 0 ? '…' : '') + snippet + (start + SNIPPET_CHARS < text.length ? '…' : '')
}

/**
 * Semantic search over the vault via FTS5 (BM25 + Porter stemming + synonym
 * expansion). Returns [] on any failure or empty result so the caller can fall
 * back to the grep path. Never throws.
 */
export function searchVaultIndex(query: string, workspace?: string | null): VaultHit[] {
  try {
    const root = process.env.SECOND_BRAIN_ROOT || '/home/operator/second-brain'
    if (!existsSync(root)) return []
    const baseTerms = extractTerms(query.slice(0, 600))
    if (baseTerms.length === 0) return []
    const db = getIndex(root)
    if (!db) return []

    const expanded = expandTerms(baseTerms)
    // Quote each term as a bareword string so FTS5 never parses a term as an
    // operator; OR them so a paraphrase matching on synonyms still ranks.
    const match = expanded.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ')

    // bm25() returns a negative score; lower (more negative) is more relevant.
    // Boost title and tags columns over body.
    const rows = db
      .prepare(
        'SELECT path, bm25(docs, 10.0, 5.0, 1.0) AS score ' +
          'FROM docs WHERE docs MATCH ? ORDER BY score LIMIT 30'
      )
      .all(match) as { path: string; score: number }[]
    if (rows.length === 0) return []

    for (const r of rows) {
      if (workspace && r.path.includes(`/workspaces/${workspace}/`)) {
        r.score -= WORKSPACE_BONUS
      }
    }
    rows.sort((a, b) => a.score - b.score)

    const hits: VaultHit[] = []
    for (const r of rows.slice(0, MAX_HITS)) {
      try {
        hits.push({ path: r.path, snippet: makeSnippet(r.path, expanded) })
      } catch {
        // unreadable — skip
      }
    }
    return hits
  } catch {
    return []
  }
}

/** Test/maintenance hook: drop the cached in-memory index. */
export function resetVaultIndexCache(): void {
  if (cache) {
    try {
      cache.db.close()
    } catch {
      // ignore
    }
    cache = null
  }
}
