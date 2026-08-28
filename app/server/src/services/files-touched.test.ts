import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  resolveFilesTouched,
  filesFromSessionIntel,
  filesFromPrDiff,
  type GhExec,
} from './files-touched.js'
import {
  rubricForChangedFiles,
  buildDsConformanceCriteria,
  buildQaConformanceCriteria,
  BACKEND_CORRECTNESS_CRITERION,
} from './design-context.js'

// obj 705254 — the ds-*/qa-* auto-append is keyed on PROJECT, so every objective in a
// registered frontend repo carries browser criteria whether or not its deliverable has a
// UI. `rubricForChangedFiles` already strips them for backend-only PRs, but it was fed
// ONLY by `session_intel`, which the async extraction pipeline writes after a session
// ends — so an empty list (live session / extraction pending / extraction failed) failed
// OPEN and graded a Python API client against WCAG contrast. These pin the PR-diff
// fallback that closes that hole, and — critically — that the safe default survives.

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE session_intel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER,
      session_id TEXT NOT NULL UNIQUE,
      files_created TEXT NOT NULL DEFAULT '[]',
      files_modified TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE objective_prs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER,
      pr_number INTEGER,
      repo TEXT
    );
  `)
  return db
}

function putIntel(
  db: Database.Database,
  sessionId: string,
  created: unknown,
  modified: unknown,
): void {
  db.prepare(
    'INSERT INTO session_intel (session_id, files_created, files_modified) VALUES (?, ?, ?)',
  ).run(
    sessionId,
    typeof created === 'string' ? created : JSON.stringify(created),
    typeof modified === 'string' ? modified : JSON.stringify(modified),
  )
}

/** A gh runner that records its argv and returns canned stdout. */
function fakeGh(stdout: string): GhExec & { calls: string[][] } {
  const calls: string[][] = []
  const fn: GhExec = async (args: string[]) => {
    calls.push(args)
    return stdout
  }
  return Object.assign(fn, { calls })
}

function explodingGh(message: string): GhExec & { calls: string[][] } {
  const calls: string[][] = []
  const fn: GhExec = async (args: string[]) => {
    calls.push(args)
    throw new Error(message)
  }
  return Object.assign(fn, { calls })
}

const PY_ONLY = 'workers/integrations/emailbison.py\nworkers/tests/test_emailbison_client.py'

describe('filesFromSessionIntel', () => {
  it('unions created ∪ modified and de-duplicates', () => {
    const db = freshDb()
    putIntel(db, 's1', ['a.py', 'shared.ts'], ['shared.ts', 'b.py'])
    expect(filesFromSessionIntel(db, 's1').sort()).toEqual(['a.py', 'b.py', 'shared.ts'])
  })

  it('returns [] for a missing row, a null session id, or a null db', () => {
    const db = freshDb()
    expect(filesFromSessionIntel(db, 'nope')).toEqual([])
    expect(filesFromSessionIntel(db, null)).toEqual([])
    expect(filesFromSessionIntel(null, 's1')).toEqual([])
  })

  it('returns [] instead of throwing on unparseable JSON', () => {
    const db = freshDb()
    putIntel(db, 's1', '{not json', '[]')
    expect(filesFromSessionIntel(db, 's1')).toEqual([])
  })
})

describe('filesFromPrDiff', () => {
  it('paginates — a truncated list would flip a UI PR to backend-only', async () => {
    const gh = fakeGh(PY_ONLY)
    await filesFromPrDiff(gh, 'EXAMPLE2/example3-platform', 751)
    expect(gh.calls).toHaveLength(1)
    expect(gh.calls[0]).toContain('--paginate')
    expect(gh.calls[0]).toContain('repos/EXAMPLE2/example3-platform/pulls/751/files')
  })

  it('parses one filename per line and drops blanks', async () => {
    const gh = fakeGh('a.py\n\n  b.ts  \n')
    expect(await filesFromPrDiff(gh, 'o/r', 1)).toEqual(['a.py', 'b.ts'])
  })
})

describe('resolveFilesTouched', () => {
  it('prefers session_intel and does NOT shell out when it has files', async () => {
    const db = freshDb()
    putIntel(db, 's1', ['app/client/src/Card.tsx'], [])
    const gh = fakeGh(PY_ONLY)

    const out = await resolveFilesTouched(db, { id: 1, session_id: 's1' }, { ghExec: gh })

    expect(out).toEqual({ files: ['app/client/src/Card.tsx'], source: 'session_intel' })
    expect(gh.calls).toEqual([]) // no needless subprocess on the common path
  })

  it('falls back to the PR diff when intel is empty (the hole this closes)', async () => {
    const db = freshDb()
    const gh = fakeGh(PY_ONLY)

    const out = await resolveFilesTouched(
      db,
      { id: 705254, session_id: 's-live', pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/751' },
      { ghExec: gh },
    )

    expect(out.source).toBe('pr_diff')
    expect(out.files).toEqual([
      'workers/integrations/emailbison.py',
      'workers/tests/test_emailbison_client.py',
    ])
  })

  it('resolves the repo from pr_url, never assuming the harness repo (obj 1955)', async () => {
    const db = freshDb()
    const gh = fakeGh(PY_ONLY)

    await resolveFilesTouched(
      db,
      { id: 1, pr_number: 751, pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/751' },
      { ghExec: gh },
    )

    const path = gh.calls[0].find((a) => a.startsWith('repos/'))
    expect(path).toBe('repos/EXAMPLE2/example3-platform/pulls/751/files')
    expect(path).not.toContain('command-center-infra')
  })

  it('falls back to the objective_prs repo when pr_url is absent', async () => {
    const db = freshDb()
    db.prepare('INSERT INTO objective_prs (objective_id, pr_number, repo) VALUES (?, ?, ?)').run(
      42, 7, 'Example-Project/example-project-platform',
    )
    const gh = fakeGh('src/x.py')

    const out = await resolveFilesTouched(db, { id: 42, pr_number: 7 }, { ghExec: gh })

    expect(out.source).toBe('pr_diff')
    expect(gh.calls[0]).toContain('repos/Example-Project/example-project-platform/pulls/7/files')
  })

  it('does nothing when the repo cannot be established — no guessed gh call', async () => {
    const db = freshDb()
    const gh = fakeGh(PY_ONLY)

    const out = await resolveFilesTouched(db, { id: 1, pr_number: 99 }, { ghExec: gh })

    expect(out).toEqual({ files: [], source: 'none' })
    expect(gh.calls).toEqual([]) // an unresolvable repo must never be spelled "mine"
  })

  it('does nothing when there is no PR yet', async () => {
    const db = freshDb()
    const gh = fakeGh(PY_ONLY)
    const out = await resolveFilesTouched(db, { id: 1 }, { ghExec: gh })
    expect(out).toEqual({ files: [], source: 'none' })
    expect(gh.calls).toEqual([])
  })

  it('SAFE DEFAULT: a gh failure degrades to unknown, never to a wrong answer', async () => {
    const db = freshDb()
    const gh = explodingGh('gh: not logged into any GitHub hosts')

    const out = await resolveFilesTouched(
      db,
      { id: 1, pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/751' },
      { ghExec: gh },
    )

    expect(out).toEqual({ files: [], source: 'none' })
    expect(gh.calls).toHaveLength(1) // it really did try
  })

  it('an empty PR diff is "unknown", not "backend-only"', async () => {
    const db = freshDb()
    const out = await resolveFilesTouched(
      db,
      { id: 1, pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/751' },
      { ghExec: fakeGh('') },
    )
    expect(out).toEqual({ files: [], source: 'none' })
  })

  it('omitting ghExec keeps the pre-fix behaviour (intel only)', async () => {
    const db = freshDb()
    const out = await resolveFilesTouched(db, {
      id: 1,
      pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/751',
    })
    expect(out).toEqual({ files: [], source: 'none' })
  })
})

// The end-to-end point of the change: what the reviewer's rubric actually becomes.
describe('resolveFilesTouched → rubricForChangedFiles (obj 705254 regression)', () => {
  const uiBar = [...buildDsConformanceCriteria('example3-platform'), ...buildQaConformanceCriteria()]
  const realBar = {
    id: 'thread-reply-required',
    criterion: 'update_sequence_steps raises locally when a step omits thread_reply',
    type: 'functional' as const,
    method: 'api' as const,
  }

  it('a backend-only PR with EMPTY intel now strips the browser rubric', async () => {
    const db = freshDb()
    const { files, source } = await resolveFilesTouched(
      db,
      { id: 705254, session_id: 's-live', pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/751' },
      { ghExec: fakeGh(PY_ONLY) },
    )
    expect(source).toBe('pr_diff')

    const { criteria, stripped } = rubricForChangedFiles([realBar, ...uiBar], files)

    expect(stripped).toBe(true)
    expect(criteria).toEqual([realBar])
    // Every auto-appended criterion is gone — ds-* AND qa-* (both are method:'browser').
    expect(criteria.some((c) => c.id?.startsWith('ds-') || c.id?.startsWith('qa-'))).toBe(false)
  })

  it('strips to the backend correctness bar when the UI criteria were the WHOLE rubric', async () => {
    const db = freshDb()
    const { files } = await resolveFilesTouched(
      db,
      { id: 705254, pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/751' },
      { ghExec: fakeGh(PY_ONLY) },
    )
    const { criteria, stripped } = rubricForChangedFiles(uiBar, files)
    expect(stripped).toBe(true)
    expect(criteria).toEqual([BACKEND_CORRECTNESS_CRITERION])
  })

  it('NO REGRESSION: a genuine UI PR with empty intel keeps the full rubric', async () => {
    const db = freshDb()
    const { files, source } = await resolveFilesTouched(
      db,
      { id: 2, pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/752' },
      { ghExec: fakeGh('app/client/src/components/Card.tsx\nlib/x.ts') },
    )
    expect(source).toBe('pr_diff')

    const full = [realBar, ...uiBar]
    const { criteria, stripped } = rubricForChangedFiles(full, files)

    expect(stripped).toBe(false)
    expect(criteria).toEqual(full)
  })

  it('NO REGRESSION: gh unreachable ⇒ full rubric still applies, exactly as before', async () => {
    const db = freshDb()
    const { files } = await resolveFilesTouched(
      db,
      { id: 3, pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/753' },
      { ghExec: explodingGh('boom') },
    )
    const full = [realBar, ...uiBar]
    expect(rubricForChangedFiles(full, files).stripped).toBe(false)
  })
})
