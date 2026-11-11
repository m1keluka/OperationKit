import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'

// obj 717767 — a session that dies on an auth failure (401 / 403 org-disabled)
// with 0 tool calls must STOP: account parked, card blocked (not ai_review /
// review-for-work), alert naming the account label, and no re-spawn. A mid-run
// auth death (tool calls > 0) still falls through to rotation.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-717767-death-'))
process.env.CC_ACCOUNT_ROUTER_STATE_FILE = path.join(TMP, 'state.json')
process.env.CC_RATE_LIMIT_LOG = path.join(TMP, 'rate-limit.jsonl')

let db: Database.Database
const insertAlertMock = vi.fn((args: Record<string, unknown>) => ({ id: 1, ...args }))
const broadcastMock = vi.fn()
const autoResumeOnLimitMock = vi.fn()
const sendFollowUpMock = vi.fn()

vi.mock('../db/index.js', () => ({ getDb: () => db }))
vi.mock('../ws/index.js', () => ({ broadcast: (...a: unknown[]) => broadcastMock(...a) }))
vi.mock('./notifier.js', () => ({ insertAlert: (a: Record<string, unknown>) => insertAlertMock(a), sendTelegram: vi.fn() }))
vi.mock('./session-intel-pipeline.js', () => ({ queueExtraction: vi.fn() }))
vi.mock('./session-telemetry.js', () => ({ scanStreamTelemetry: vi.fn() }))
vi.mock('./session-worktree.js', () => ({ computeIsolation: () => null }))
vi.mock('./session-usage.js', () => ({ extractFinalUsage: () => ({ tokens: 0, cost: 0 }) }))
vi.mock('./arena-lifecycle.js', () => ({ hasArenaCohort: vi.fn(), getArenaCohort: vi.fn(), evaluateAndPromoteArena: vi.fn() }))
vi.mock('./session-manager.js', () => ({
  getSessionState: vi.fn(),
  autoResumeOnLimit: (...a: unknown[]) => autoResumeOnLimitMock(...a),
  autoResumeOnOverload: vi.fn(),
  autoResumeOnTurns: vi.fn(),
  getSessionOutput: vi.fn(),
  resolveWorkdir: vi.fn(),
  sendFollowUp: (...a: unknown[]) => sendFollowUpMock(...a),
}))

const router = await import('./account-router.js')
const { handleSessionDeath, countToolCalls } = await import('./session-death.js')
const { activeSessions } = await import('./session-registry.js')
const { handleAuthDeath } = await import('./poller-worker.js')
const { decideAuthDeath } = await import('./account-auth-park.js')

const ORG_DISABLED =
  'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access'

function seed(): void {
  const home = path.join(TMP, 't1')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}')
  fs.writeFileSync(process.env.CC_ACCOUNT_ROUTER_STATE_FILE!, JSON.stringify({
    accounts: [{
      id: 't1', label: 'Team Seat One', customLabel: 'Team Seat One', kind: 'claude', priority: 0, homeDir: home,
      sessionsToday: 0, tokensToday: 0, costToday: 0, lastRateLimit: null, rateLimitResetsAt: null,
      authFailedAt: null, authFailureReason: null, activeSessions: [], usageLog: [],
    }],
    queue: [], lastResetDate: new Date().toISOString().slice(0, 10),
  }))
  router.clearAuthFailure('t1')

  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE objectives (
      id INTEGER PRIMARY KEY, title TEXT, status TEXT, session_id TEXT, ai_review_verdict TEXT,
      ai_review_findings TEXT, project TEXT, workspace TEXT, branch_name TEXT, create_pr INTEGER DEFAULT 0,
      delegate_mode INTEGER DEFAULT 0, model TEXT, updated_at TEXT
    );
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, workspace TEXT,
      objective_id INTEGER, session_id TEXT, event_type TEXT, title TEXT, detail TEXT
    );
    CREATE TABLE branch_leases (branch_name TEXT, objective_id INTEGER, released_at TEXT, heartbeat_at TEXT);
    CREATE TABLE session_leases (lease_key TEXT, objective_id INTEGER, released_at TEXT);
    CREATE TABLE session_runtime (session_id TEXT PRIMARY KEY, claude_session_id TEXT, account_id TEXT, updated_at TEXT);
    CREATE TABLE session_spawns (session_id TEXT PRIMARY KEY, started_at TEXT);
  `)
  db.prepare(`INSERT INTO objectives (id, title, status, session_id, project, workspace)
              VALUES (42, 'Build the thing', 'working', 'cc-42-aaa', 'command-center', 'operationkit')`).run()
}

function startSession(sessionId: string, lines: unknown[]): void {
  const jsonlPath = path.join(TMP, `${sessionId}.jsonl`)
  fs.writeFileSync(jsonlPath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  activeSessions.set(sessionId, {
    logPath: path.join(TMP, `${sessionId}.log`),
    jsonlPath,
    startedAt: Date.now(),
    accountId: 't1',
    objective: db.prepare('SELECT * FROM objectives WHERE id = 42').get() as never,
  })
}

const init = { type: 'system', subtype: 'init', session_id: 'claude-abc' }
const orgDisabledResult = { type: 'result', subtype: 'success', is_error: true, api_error_status: 403, result: ORG_DISABLED }
const toolUse = (n: number) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${n}`, name: 'Bash', input: {} }] } })

beforeEach(() => {
  seed()
  vi.clearAllMocks()
})

describe('handleSessionDeath — 403 org-disabled is handled exactly like a 401', () => {
  it('parks the account as needs_admin and reports authFailed with 0 tool calls', () => {
    startSession('cc-42-aaa', [init, orgDisabledResult])
    const death = handleSessionDeath('cc-42-aaa')
    expect(death).toMatchObject({ limitHit: true, authFailed: true, authReason: 'needs_admin', toolCalls: 0, accountId: 't1' })
    const t1 = router.getAccountById('t1')!
    expect(t1.authFailedAt).toBeTruthy()
    expect(t1.authFailureReason).toBe('needs_admin')
    expect(router.pickAccount(a => a.id === 't1')).toBeNull()
  })

  it('a 401 dead credential parks as needs_reconnect', () => {
    startSession('cc-42-aaa', [init, { type: 'result', is_error: true, api_error_status: 401, result: 'Failed to authenticate. API Error: 401 Invalid authentication credentials' }])
    const death = handleSessionDeath('cc-42-aaa')
    expect(death).toMatchObject({ authFailed: true, authReason: 'needs_reconnect' })
    expect(router.getAccountById('t1')!.authFailureReason).toBe('needs_reconnect')
  })

  it('an OAuth-refresh-expired exit (api_error_status null) parks as needs_reconnect (obj 716791)', () => {
    startSession('cc-42-aaa', [init, { type: 'result', subtype: 'success', is_error: true, api_error_status: null, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' }])
    const death = handleSessionDeath('cc-42-aaa')
    expect(death).toMatchObject({ authFailed: true, authReason: 'needs_reconnect', toolCalls: 0, accountId: 't1' })
    expect(router.pickAccount(a => a.id === 't1')).toBeNull()
    const obj = db.prepare('SELECT * FROM objectives WHERE id = 42').get() as never
    expect(handleAuthDeath(obj, death)).toBe(true)
  })

  it('a bare 403 without the org-disabled body does not park the account', () => {
    startSession('cc-42-aaa', [init, { type: 'result', is_error: true, api_error_status: 403, result: 'Forbidden' }])
    const death = handleSessionDeath('cc-42-aaa')
    expect(death.authFailed).toBe(false)
    expect(router.getAccountById('t1')!.authFailedAt).toBeFalsy()
  })
})

describe('no re-spawn on 0 tool calls + auth error → blocked card + alert', () => {
  it('blocks the card (review + verdict blocked, not ai_review), names the label, alerts, never respawns', () => {
    startSession('cc-42-aaa', [init, orgDisabledResult])
    const death = handleSessionDeath('cc-42-aaa')
    const obj = db.prepare('SELECT * FROM objectives WHERE id = 42').get() as never

    expect(handleAuthDeath(obj, death)).toBe(true)

    const row = db.prepare('SELECT * FROM objectives WHERE id = 42').get() as Record<string, string | null>
    expect(row.status).toBe('review')
    expect(row.status).not.toBe('ai_review')
    expect(row.ai_review_verdict).toBe('blocked')
    expect(row.session_id).toBeNull()
    expect(row.ai_review_findings).toContain('account needs admin')
    expect(row.ai_review_findings).toContain('Team Seat One')
    expect(row.ai_review_findings).not.toMatch(/credentials\.json|cc-717767|\/t1\b/)

    const log = db.prepare("SELECT * FROM activity_log WHERE title = 'account_auth_blocked'").all()
    expect(log).toHaveLength(1)

    expect(insertAlertMock).toHaveBeenCalledTimes(1)
    const alert = insertAlertMock.mock.calls[0][0] as { title: string; message: string; severity: string }
    expect(alert.severity).toBe('high')
    expect(alert.title).toBe('Claude account needs admin: Team Seat One')
    expect(alert.message).toContain('Card #42')
    expect(broadcastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'alert' }))
    expect(broadcastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'objective_updated' }))

    // No rotation / follow-up respawn was attempted.
    expect(autoResumeOnLimitMock).not.toHaveBeenCalled()
    expect(sendFollowUpMock).not.toHaveBeenCalled()
  })

  it('an auth death AFTER real work (tool calls > 0) is not blocked — falls through to rotation', () => {
    startSession('cc-42-aaa', [init, toolUse(1), toolUse(2), orgDisabledResult])
    const death = handleSessionDeath('cc-42-aaa')
    expect(death).toMatchObject({ authFailed: true, toolCalls: 2 })
    const obj = db.prepare('SELECT * FROM objectives WHERE id = 42').get() as never
    expect(handleAuthDeath(obj, death)).toBe(false)
    expect((db.prepare('SELECT status FROM objectives WHERE id = 42').get() as { status: string }).status).toBe('working')
  })

  it('decideAuthDeath: block / rotate / none', () => {
    expect(decideAuthDeath({ authFailed: true, toolCalls: 0 })).toBe('block')
    expect(decideAuthDeath({ authFailed: true, toolCalls: 3 })).toBe('rotate')
    expect(decideAuthDeath({ authFailed: false, toolCalls: 0 })).toBe('none')
  })

  it('countToolCalls skips malformed lines and non-assistant tool_use mentions', () => {
    const lines = [
      JSON.stringify(toolUse(1)),
      '{not json tool_use',
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'tool_use' }, { type: 'tool_use' }, { type: 'tool_use' }] } }),
    ]
    expect(countToolCalls(lines)).toBe(3)
    expect(countToolCalls([])).toBe(0)
  })
})
