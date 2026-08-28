import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { searchVaultIndex } from './vault-index.js'

/**
 * Knowledge-base search for spawn-context injection.
 *
 * RETRIEVAL (ST6, 2026-06-17): the primary path is now SEMANTIC — an FTS5
 * (BM25 + Porter stemming + synonym expansion) index over the vault, in
 * vault-index.ts. It retrieves decision docs by meaning, so a paraphrase that
 * shares no surface keywords ("service outage" → a doc that only says
 * "incident"/"uptime") still hits. The grep path below is retained verbatim as
 * a FAIL-SAFE FALLBACK: searchKnowledge() tries the semantic index first and
 * falls back to grep on any error or empty result, so this function never
 * regresses below the original behaviour.
 *
 * DISCOVERY (2026-06-12): there is no qmd binary, hybrid-search service, or
 * sqlite/FTS index anywhere on this host. The canonical vault search tool is
 * ~/second-brain/scripts/kb_search — a thin bash wrapper over ripgrep
 * (ratified in second-brain/personal/decisions/2026-04-24-kb-retrieval-approach.md).
 * It is NOT executable from the command-center container: rg is not installed
 * (the only copies on disk are vendored inside other repos' node_modules,
 * which can vanish on any npm prune). Chosen mechanism: bounded keyword
 * search over the vault markdown tree using /usr/bin/grep (verified present
 * in the container) via spawnSync — synchronous because buildContext() and
 * both of its call sites are synchronous. Hard ~4s overall deadline; any
 * error, timeout, or missing vault returns [] so spawning is never blocked.
 *
 * The ST6 host-constraint lift: better-sqlite3 (already a dependency) bundles
 * SQLite with FTS5, so an in-process index needs no new infra — see
 * vault-index.ts for the FTS5-vs-embeddings rationale.
 */

const VAULT_ROOT = process.env.SECOND_BRAIN_ROOT || '/home/operator/second-brain'
const TOTAL_BUDGET_MS = 4000
const MAX_TERMS = 8
const MAX_CANDIDATES = 1500
const MAX_HITS = 5
const SNIPPET_CHARS = 400

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

export interface KnowledgeHit {
  path: string
  snippet: string
}

function extractTerms(query: string): string[] {
  const seen = new Set<string>()
  for (const raw of query.toLowerCase().split(/[^a-z0-9-]+/)) {
    const word = raw.replace(/^-+|-+$/g, '')
    if (word.length < 3 || word.length > 40) continue
    if (/^\d+$/.test(word)) continue
    if (STOPWORDS.has(word)) continue
    seen.add(word)
    if (seen.size >= MAX_TERMS) break
  }
  return [...seen]
}

function grep(args: string[], deadline: number): string | null {
  const remaining = deadline - Date.now()
  if (remaining <= 100) return null
  const res = spawnSync('/usr/bin/grep', args, {
    timeout: remaining,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  // status 1 = "no matches", which is a valid empty result, not an error
  if (res.error || res.status === null || (res.status !== 0 && res.status !== 1)) return null
  return res.stdout || ''
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
 * Search the second-brain vault for content relevant to `query`.
 *
 * Primary path: the semantic FTS5 index (vault-index.ts). Fail-safe fallback:
 * the original grep path below. Never throws; returns [] only when both paths
 * find nothing or fail. The KnowledgeHit shape is unchanged, so the
 * context-builder KB-injection contract is untouched.
 */
export function searchKnowledge(query: string, workspace?: string | null): KnowledgeHit[] {
  try {
    const semantic = searchVaultIndex(query, workspace)
    if (semantic.length > 0) return semantic
  } catch {
    // fall through to grep
  }
  return searchKnowledgeGrep(query, workspace)
}

/**
 * Original grep-based retrieval. Retained as the fail-safe fallback for
 * searchKnowledge() and used directly by tests. Never throws; returns [] on any
 * failure or when nothing relevant is found.
 */
export function searchKnowledgeGrep(query: string, workspace?: string | null): KnowledgeHit[] {
  try {
    if (!existsSync(VAULT_ROOT)) return []
    const terms = extractTerms(query.slice(0, 600))
    if (terms.length === 0) return []
    const deadline = Date.now() + TOTAL_BUDGET_MS

    const candidateOut = grep([
      '-r', '-l', '-i', '-E', terms.join('|'),
      '--include=*.md',
      '--exclude-dir=.obsidian', '--exclude-dir=_import', '--exclude-dir=_system',
      VAULT_ROOT,
    ], deadline)
    if (candidateOut === null) return []
    const candidates = candidateOut.split('\n')
      .filter(Boolean)
      .filter(f => !f.endsWith('/index.md')) // auto-generated menus, pure noise
      .slice(0, MAX_CANDIDATES)
    if (candidates.length === 0) return []

    // Per-term occurrence counts across candidates. /dev/null forces grep to
    // prefix filenames even when only one candidate remains.
    const termCounts: Map<string, number>[] = []
    for (const term of terms) {
      const counts = new Map<string, number>()
      const out = grep(['-i', '-c', '-F', term, ...candidates, '/dev/null'], deadline)
      if (out === null) break
      for (const line of out.split('\n')) {
        const sep = line.lastIndexOf(':')
        if (sep <= 0) continue
        const count = parseInt(line.slice(sep + 1), 10)
        if (count) counts.set(line.slice(0, sep), count)
      }
      termCounts.push(counts)
    }

    // Rank with an IDF weight so rare, discriminating terms ("prepaid")
    // outweigh terms that match half the vault ("example").
    const scores = new Map<string, number>()
    const distinct = new Map<string, number>()
    for (const counts of termCounts) {
      if (counts.size === 0) continue
      const idf = Math.max(1, Math.log2(candidates.length / counts.size))
      for (const [file, count] of counts) {
        scores.set(file, (scores.get(file) || 0) + idf * (3 + Math.min(count, 5)))
        distinct.set(file, (distinct.get(file) || 0) + 1)
      }
    }
    if (scores.size === 0) return []

    if (workspace) {
      for (const file of scores.keys()) {
        if (file.includes(`/workspaces/${workspace}/`)) {
          scores.set(file, (scores.get(file) || 0) + 6)
        }
      }
    }

    const minDistinct = terms.length >= 3 ? 2 : 1
    const ranked = [...scores.entries()]
      .filter(([file]) => (distinct.get(file) || 0) >= minDistinct)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_HITS)

    const hits: KnowledgeHit[] = []
    for (const [file] of ranked) {
      try {
        hits.push({ path: file, snippet: makeSnippet(file, terms) })
      } catch {
        // unreadable file — skip it
      }
    }
    return hits
  } catch {
    return []
  }
}
