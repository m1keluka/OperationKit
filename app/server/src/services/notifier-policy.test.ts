/**
 * obj 900677 — which notifications fire. Real in-memory SQLite (not the shim in
 * notifier.test.ts) so the settings override, unread dedup and auto-resolve run
 * the actual SQL.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

const broadcastSpy = vi.fn()
let db: Database.Database

vi.mock('../db/index.js', () => ({ getDb: () => db }))
vi.mock('../ws/index.js', () => ({ broadcast: (msg: unknown) => broadcastSpy(msg) }))

const {
  insertAlert,
  isNotificationTypeEnabled,
  notificationTypeKey,
  NOTIFICATION_TYPES,
  _resetDedupForTests,
} = await import('./notifier.js')
const { shouldAlertDrift, nextBehindOnlySince, DRIFT_BEHIND_GRACE_MS } = await import('./drift-guard.js')

function unread(): { source: string; title: string; dedup_key: string | null }[] {
  return db.prepare('SELECT source, title, dedup_key FROM alerts WHERE acked_at IS NULL ORDER BY id').all() as never
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      severity TEXT NOT NULL DEFAULT 'normal',
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      dedup_key TEXT,
      url TEXT,
      email_sent_at TEXT,
      acked_at TEXT,
      acked_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  broadcastSpy.mockReset()
  _resetDedupForTests()
})

describe('notification type registry', () => {
  it('has one entry per key, each with a reason', () => {
    const keys = NOTIFICATION_TYPES.map(t => t.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const t of NOTIFICATION_TYPES) expect(t.reason.length).toBeGreaterThan(10)
  })

  it('cuts the per-card types the card and its bot already cover', () => {
    for (const k of ['stall-watchdog', 'abnormal-end', 'runner-failure', 'state-poller']) {
      expect(isNotificationTypeEnabled(k)).toBe(false)
    }
  })

  it('keeps the types only a human can act on', () => {
    for (const k of ['account-router', 'seat-pool', 'objectives-safety', 'drift-guard', 'routines', 'ci-green-gate', 'pr-health-watchdog']) {
      expect(isNotificationTypeEnabled(k)).toBe(true)
    }
  })

  it('a kind with no entry inherits its source; an unknown source stays on', () => {
    expect(isNotificationTypeEnabled('disk-watchdog')).toBe(true)
    expect(isNotificationTypeEnabled('disk-watchdog:warn')).toBe(false)
    expect(isNotificationTypeEnabled('disk-watchdog:low')).toBe(true)
    expect(isNotificationTypeEnabled('some-cron-script')).toBe(true)
    expect(notificationTypeKey({ source: 'n8n-watchdog', kind: 'recovered' })).toBe('n8n-watchdog:recovered')
    expect(notificationTypeKey({})).toBe('unknown')
  })

  it('a settings row overrides the default either way', () => {
    db.prepare("INSERT INTO settings VALUES ('notify:stall-watchdog', '1'), ('notify:seat-pool', '0')").run()
    expect(isNotificationTypeEnabled('stall-watchdog')).toBe(true)
    expect(isNotificationTypeEnabled('seat-pool')).toBe(false)
  })
})

describe('insertAlert', () => {
  it('drops a muted type: no row, returns null', () => {
    const a = insertAlert({ severity: 'high', source: 'stall-watchdog', title: 'Card #1 stalled', message: 'x', dedup_key: 'stall:1' })
    expect(a).toBeNull()
    expect(unread()).toEqual([])
  })

  it('keeps a still-unread condition to one item, and raises it again once read', () => {
    const args = { severity: 'high' as const, source: 'seat-pool', title: 'Seat expires', message: 'x', dedup_key: 'seat-expiry:a' }
    expect(insertAlert(args)).not.toBeNull()
    _resetDedupForTests() // past the 10-minute in-memory window, e.g. after a restart
    expect(insertAlert(args)).toBeNull()
    expect(unread()).toHaveLength(1)

    db.prepare("UPDATE alerts SET acked_at = datetime('now')").run()
    _resetDedupForTests()
    expect(insertAlert(args)).not.toBeNull()
    expect(unread()).toHaveLength(1)
  })

  it('a recovery marks the down item read even though the recovery itself is muted', () => {
    insertAlert({ severity: 'high', source: 'n8n-watchdog', title: 'n8n is DOWN', message: 'x', dedup_key: 'n8n-watchdog-down' })
    expect(unread()).toHaveLength(1)
    const rec = insertAlert({
      severity: 'normal', source: 'n8n-watchdog', kind: 'recovered', resolves: 'n8n-watchdog-down',
      title: 'n8n recovered', message: 'x', dedup_key: 'n8n-watchdog-up',
    })
    expect(rec).toBeNull()
    expect(unread()).toEqual([])
    const row = db.prepare('SELECT acked_by FROM alerts').get() as { acked_by: string }
    expect(row.acked_by).toBe('auto-resolved')
    expect(broadcastSpy).toHaveBeenCalledWith({ type: 'alert_acked', payload: { id: 1 } })

    // The next outage raises a fresh item.
    _resetDedupForTests()
    expect(insertAlert({ severity: 'high', source: 'n8n-watchdog', title: 'n8n is DOWN', message: 'x', dedup_key: 'n8n-watchdog-down' })).not.toBeNull()
  })

  it('still inserts when there is no settings table (older DB)', () => {
    db.exec('DROP TABLE settings')
    expect(insertAlert({ severity: 'normal', source: 'routines', title: 't', message: 'm' })).not.toBeNull()
  })
})

describe('drift-guard: behind-only grace', () => {
  const base = { reasons: ['r'], fetchOk: true, ok: true }
  const behind = { ...base, drifted: true, behind: 3, ahead: 0, dirtyServedFiles: [] }
  const dirty = { ...base, drifted: true, behind: 3, ahead: 0, dirtyServedFiles: ['app/server/src/x.ts'] }
  const ahead = { ...base, drifted: true, behind: 0, ahead: 1, dirtyServedFiles: [] }
  const clean = { ...base, drifted: false, behind: 0, ahead: 0, dirtyServedFiles: [] }

  it('dirty or ahead alerts at once', () => {
    expect(shouldAlertDrift(dirty, null, 0)).toBe(true)
    expect(shouldAlertDrift(ahead, null, 0)).toBe(true)
  })

  it('behind-only waits out the grace window, then alerts', () => {
    const t0 = 1_000_000
    const since = nextBehindOnlySince(behind, null, t0)
    expect(since).toBe(t0)
    expect(shouldAlertDrift(behind, since, t0 + 30 * 60_000)).toBe(false)
    expect(nextBehindOnlySince(behind, since, t0 + 60 * 60_000)).toBe(t0)
    expect(shouldAlertDrift(behind, since, t0 + DRIFT_BEHIND_GRACE_MS)).toBe(true)
  })

  it('the clock resets once the checkout catches up', () => {
    expect(nextBehindOnlySince(clean, 5, 10)).toBeNull()
    expect(nextBehindOnlySince(dirty, 5, 10)).toBeNull()
    expect(shouldAlertDrift(clean, null, 10)).toBe(false)
  })
})
