import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// obj 717767 — org-disabled subscription access (403) / dead OAuth: matcher,
// parking + pickAccount exclusion, follow-up reroute, slot health check, and
// the probe never using the metered API key.
//
// Router state lives in a per-file temp file (never the live state file), and
// only test slots t1/t2 (temp homes with a credentials file) are ever picked.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-717767-router-'))
process.env.CC_ACCOUNT_ROUTER_STATE_FILE = path.join(TMP, 'state.json')
process.env.CC_RATE_LIMIT_LOG = path.join(TMP, 'rate-limit.jsonl')

const insertAlertMock = vi.fn((args: Record<string, unknown>) => ({ id: 1, ...args }))
const broadcastMock = vi.fn()
vi.mock('./notifier.js', () => ({ insertAlert: (a: Record<string, unknown>) => insertAlertMock(a), sendTelegram: vi.fn() }))
vi.mock('../ws/index.js', () => ({ broadcast: (...a: unknown[]) => broadcastMock(...a) }))
vi.mock('../db/index.js', () => ({ getDb: () => { throw new Error('no db in this suite') } }))

const spawnMock = vi.fn()
vi.mock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), spawn: (...a: unknown[]) => spawnMock(...a) }))

const router = await import('./account-router.js')
const { checkSlot, runSlotHealthCheck, slotHealthIntervalMs } = await import('./account-health-check.js')
const probeMod = await import('./account-probe.js')

const ORG_DISABLED =
  'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access'
const OAUTH_DEAD = 'OAuth session expired and could not be refreshed. Please run /login.'

const testSlot = (a: { id: string }) => a.id === 't1' || a.id === 't2'

function slotHome(id: string): string {
  const home = path.join(TMP, id)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  // Shape-less creds → isOAuthTokenUsable is permissive (no real secret here).
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}')
  return home
}

function seedState(): void {
  const mk = (id: string, label: string) => ({
    id, label, customLabel: label, kind: 'claude', priority: 0, homeDir: slotHome(id),
    sessionsToday: 0, tokensToday: 0, costToday: 0, lastRateLimit: null, rateLimitResetsAt: null,
    authFailedAt: null, authFailureReason: null, activeSessions: [], usageLog: [],
  })
  fs.writeFileSync(
    process.env.CC_ACCOUNT_ROUTER_STATE_FILE!,
    JSON.stringify({ accounts: [mk('t1', 'Team Seat One'), mk('t2', 'Team Seat Two')], queue: [], lastResetDate: new Date().toISOString().slice(0, 10) }),
  )
  // Clear any park left in memory by a previous test.
  router.clearAuthFailure('t1')
  router.clearAuthFailure('t2')
  router.forceClearRateLimit('t1')
  router.forceClearRateLimit('t2')
}

beforeEach(() => {
  seedState()
  vi.clearAllMocks()
})

describe('matcher — org-disabled variants (obj 717767)', () => {
  it('matches the full CLI sentence, the "ask your admin to enable" tail, and the org-disabled head', () => {
    expect(router.authFailureKind(ORG_DISABLED)).toBe('org_disabled')
    expect(router.authFailureKind('… or ask your admin to enable access')).toBe('org_disabled')
    expect(router.authFailureKind('Please ask your admin to enable Claude subscription access')).toBe('org_disabled')
    expect(router.authFailureKind('Your organization has disabled subscription access')).toBe('org_disabled')
    expect(router.isAuthFailureMessage('API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Your organization has disabled Claude subscription access for Claude Code"}}')).toBe(true)
  })

  it('classifies dead credentials separately from org-disabled', () => {
    expect(router.authFailureKind(OAUTH_DEAD)).toBe('dead_credential')
    expect(router.authFailureKind('Failed to authenticate. API Error: 401 Invalid authentication credentials')).toBe('dead_credential')
    expect(router.authParkReason(ORG_DISABLED)).toBe('needs_admin')
    expect(router.authParkReason(OAUTH_DEAD)).toBe('needs_reconnect')
    expect(router.authParkReason('')).toBe('needs_reconnect')
  })

  it('403 counts only with the org-disabled body; 401 always counts', () => {
    expect(router.isAuthFailureEvent(403, ORG_DISABLED)).toBe(true)
    expect(router.isAuthFailureEvent(403, 'Forbidden: you do not have access to this repository')).toBe(false)
    expect(router.isAuthFailureEvent(401, '')).toBe(true)
    expect(router.isAuthFailureEvent(undefined, OAUTH_DEAD)).toBe(true)
  })

  it('does not collide with spend caps / rate limits / normal prose', () => {
    const spend = "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/admin-settings/usage"
    expect(router.isAuthFailureMessage(spend)).toBe(false)
    expect(router.isRateLimitMessage(ORG_DISABLED)).toBe(false)
    expect(router.isAuthFailureMessage('I added authentication to the admin page')).toBe(false)
  })
})

describe('parking + pickAccount exclusion', () => {
  it('org-disabled parks the slot as needs_admin and pickAccount skips it until cleared', () => {
    expect(router.pickAccount(testSlot)).not.toBeNull()
    router.recordAuthFailure('t1', ORG_DISABLED)
    const t1 = router.getAccountById('t1')!
    expect(t1.authFailedAt).toBeTruthy()
    expect(t1.authFailureReason).toBe('needs_admin')
    for (let i = 0; i < 5; i++) expect(router.pickAccount(testSlot)?.id).toBe('t2')

    router.recordAuthFailure('t2', OAUTH_DEAD)
    expect(router.getAccountById('t2')!.authFailureReason).toBe('needs_reconnect')
    expect(router.pickAccount(testSlot)).toBeNull()

    router.clearAuthFailure('t1')
    expect(router.getAccountById('t1')!.authFailureReason).toBeNull()
    expect(router.pickAccount(testSlot)?.id).toBe('t1')
  })

  it('getRouterStatus surfaces the reason and the slot as unavailable', () => {
    router.recordAuthFailure('t1', ORG_DISABLED)
    const t1 = router.getRouterStatus().accounts.find(a => a.id === 't1')!
    expect(t1.available).toBe(false)
    expect(t1.authFailureReason).toBe('needs_admin')
  })
})

describe('follow-up reroute off a parked account', () => {
  it('keeps a healthy original account (with ITS homeDir)', () => {
    const c = router.chooseFollowUpAccount('t1', testSlot)
    expect(c.account?.id).toBe('t1')
    expect(c.account?.homeDir).toBe(path.join(TMP, 't1'))
    expect(c.rerouted).toBe(false)
  })

  it('reroutes to a healthy account when the original is parked', () => {
    router.recordAuthFailure('t1', ORG_DISABLED)
    const c = router.chooseFollowUpAccount('t1', testSlot)
    expect(c.account?.id).toBe('t2')
    expect(c.account?.homeDir).toBe(path.join(TMP, 't2'))
    expect(c.rerouted).toBe(true)
    expect(c.parkedReason).toBe('needs_admin')
  })

  it('returns no account (caller enqueues) when every slot is parked', () => {
    router.recordAuthFailure('t1', ORG_DISABLED)
    router.recordAuthFailure('t2', ORG_DISABLED)
    const c = router.chooseFollowUpAccount('t1', testSlot)
    expect(c.account).toBeNull()
  })
})

describe('slot health check — park / un-park', () => {
  const fail = async () => ({ ok: false, rateLimited: false, authFailure: true, output: ORG_DISABLED })
  const pass = async () => ({ ok: true, rateLimited: false, authFailure: false, output: 'ok' })
  const timeout = async () => ({ ok: false, rateLimited: false, authFailure: false, output: 'probe timed out after 45s' })
  const limited = async () => ({ ok: false, rateLimited: true, authFailure: false, output: "You've hit your session limit · resets 6:40pm (UTC)" })

  it('a failing slot is parked as needs_admin with ONE alert naming the label, not the credential', async () => {
    expect(await checkSlot('t1', fail)).toBe('parked')
    expect(router.getAccountById('t1')!.authFailureReason).toBe('needs_admin')
    expect(router.pickAccount(testSlot)?.id).toBe('t2')
    expect(insertAlertMock).toHaveBeenCalledTimes(1)
    const alert = insertAlertMock.mock.calls[0][0] as { title: string; message: string }
    expect(alert.title).toContain('Team Seat One')
    expect(alert.title).toContain('needs admin')
    expect(alert.message).not.toMatch(/credentials\.json|cc-717767|sk-ant|oauth_token/i)

    // Still failing on the next tick → no duplicate alert.
    expect(await checkSlot('t1', fail)).toBe('parked')
    expect(insertAlertMock).toHaveBeenCalledTimes(1)
  })

  it('a parked slot that passes is un-parked back into rotation', async () => {
    router.recordAuthFailure('t1', ORG_DISABLED)
    expect(await checkSlot('t1', pass)).toBe('unparked')
    expect(router.getAccountById('t1')!.authFailedAt).toBeNull()
    expect(router.chooseFollowUpAccount('t1', testSlot).account?.id).toBe('t1')
  })

  it('a rate-limited reply proves auth works: un-parks but benches for the window', async () => {
    router.recordAuthFailure('t1', OAUTH_DEAD)
    expect(await checkSlot('t1', limited)).toBe('unparked')
    const t1 = router.getAccountById('t1')!
    expect(t1.authFailedAt).toBeNull()
    expect(t1.rateLimitResetsAt).toBeTruthy()
  })

  it('inconclusive probes leave state untouched; healthy slots stay healthy', async () => {
    router.recordAuthFailure('t1', ORG_DISABLED)
    expect(await checkSlot('t1', timeout)).toBe('inconclusive')
    expect(router.getAccountById('t1')!.authFailedAt).toBeTruthy()
    expect(await checkSlot('t2', pass)).toBe('healthy')
  })

  it('skips slots with no credentials on disk; runSlotHealthCheck covers every rotation slot', async () => {
    expect(await checkSlot('t1', pass, () => false)).toBe('skipped')
    const seen: string[] = []
    const out = await runSlotHealthCheck(async (home) => { seen.push(home); return pass() }, (a) => testSlot(a))
    expect(out.t1).toBe('healthy')
    expect(out.t2).toBe('healthy')
    expect(seen.sort()).toEqual([path.join(TMP, 't1'), path.join(TMP, 't2')])
  })

  it('interval config: default 30 min, floor 5, 0 disables', () => {
    expect(slotHealthIntervalMs(undefined)).toBe(30 * 60_000)
    expect(slotHealthIntervalMs('2')).toBe(5 * 60_000)
    expect(slotHealthIntervalMs('0')).toBe(0)
    expect(slotHealthIntervalMs('junk')).toBe(30 * 60_000)
  })
})

describe('probe never uses the API key', () => {
  it('strips every non-subscription credential from the spawn env', () => {
    const env = probeMod.buildProbeEnv({ ANTHROPIC_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'y', CLAUDE_CODE_OAUTH_TOKEN: 'z', PATH: '/bin' })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.PATH).toBe('/bin')
  })

  it('the probe script unsets the keys, runs as the slot HOME, and is a minimal subscription turn', () => {
    const script = probeMod.buildProbeScript('/app/data/cc-accounts/f')
    expect(script.startsWith('unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN')).toBe(true)
    expect(script).toContain('export HOME="/app/data/cc-accounts/f"')
    expect(script).toContain('--model haiku')
    expect(script).toContain("--tools ''")
    expect(script).toContain('--max-turns 1')
    expect(script).not.toContain('--bare') // --bare forces API-key auth
    expect(script).not.toMatch(/\$ANTHROPIC_API_KEY|--api-key/)
  })

  it('probeAccount spawns with the keys removed even when the server env has them', async () => {
    process.env.ANTHROPIC_API_KEY = 'metered-key-should-not-leak'
    try {
      spawnMock.mockImplementation(() => {
        const handlers: Record<string, (arg: unknown) => void> = {}
        const child = {
          stdout: { on: (_e: string, cb: (d: Buffer) => void) => setTimeout(() => cb(Buffer.from(ORG_DISABLED)), 0) },
          stderr: { on: () => {} },
          on: (e: string, cb: (arg: unknown) => void) => { handlers[e] = cb; if (e === 'close') setTimeout(() => cb(1), 5) },
          kill: () => {},
        }
        return child
      })
      const res = await probeMod.probeAccount('/tmp/slot-x')
      expect(res.authFailure).toBe(true)
      expect(res.ok).toBe(false)
      const [cmd, args, opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }]
      expect(cmd).toBe('runuser')
      expect(args.join(' ')).toContain('unset ANTHROPIC_API_KEY')
      expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(JSON.stringify(opts.env)).not.toContain('metered-key-should-not-leak')
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  it('classifyProbe: clean exit is ok; auth/rate-limit text is never ok', () => {
    expect(probeMod.classifyProbe(0, 'ok').ok).toBe(true)
    expect(probeMod.classifyProbe(0, ORG_DISABLED)).toMatchObject({ ok: false, authFailure: true })
    expect(probeMod.classifyProbe(1, 'boom')).toMatchObject({ ok: false, authFailure: false, rateLimited: false })
  })
})
