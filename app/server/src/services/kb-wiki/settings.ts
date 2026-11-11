import { getDb } from '../../db/index.js'

/**
 * Install-wide wiki settings (obj 720117), stored in the `settings` table.
 *
 *   kb_lint_schedule   'nightly' (default) | 'weekly' | 'off'
 *   kb_lint_hour_utc   0-23, default 3 — the hour the cleanup pass runs
 *   kb_lint_stale_days pages not updated for this many days are listed as stale (default 180)
 *   kb_lint_ai_pages   how many pages the AI checks for contradictions per run (default 15, 0 = no AI)
 */
export type LintSchedule = 'nightly' | 'weekly' | 'off'

export interface WikiSettings {
  lint_schedule: LintSchedule
  lint_hour_utc: number
  lint_stale_days: number
  lint_ai_pages: number
}

export const DEFAULT_WIKI_SETTINGS: WikiSettings = { lint_schedule: 'nightly', lint_hour_utc: 3, lint_stale_days: 180, lint_ai_pages: 15 }

function read(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  } catch { return null }
}

function write(key: string, value: string): void {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

function int(v: string | null, def: number, min: number, max: number): number {
  const n = Number(v)
  return v !== null && v.trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? n : def
}

export function getWikiSettings(): WikiSettings {
  const s = read('kb_lint_schedule')
  return {
    lint_schedule: s === 'weekly' || s === 'off' || s === 'nightly' ? s : DEFAULT_WIKI_SETTINGS.lint_schedule,
    lint_hour_utc: int(read('kb_lint_hour_utc'), DEFAULT_WIKI_SETTINGS.lint_hour_utc, 0, 23),
    lint_stale_days: int(read('kb_lint_stale_days'), DEFAULT_WIKI_SETTINGS.lint_stale_days, 1, 3650),
    lint_ai_pages: int(read('kb_lint_ai_pages'), DEFAULT_WIKI_SETTINGS.lint_ai_pages, 0, 200),
  }
}

/** Validate + save a partial update. Throws a plain-language Error on a bad value. */
export function saveWikiSettings(patch: Partial<WikiSettings>): WikiSettings {
  if (patch.lint_schedule !== undefined) {
    if (!['nightly', 'weekly', 'off'].includes(patch.lint_schedule)) throw new Error('Schedule must be nightly, weekly or off.')
    write('kb_lint_schedule', patch.lint_schedule)
  }
  const nums: Array<[keyof WikiSettings, string, number, number]> = [
    ['lint_hour_utc', 'kb_lint_hour_utc', 0, 23],
    ['lint_stale_days', 'kb_lint_stale_days', 1, 3650],
    ['lint_ai_pages', 'kb_lint_ai_pages', 0, 200],
  ]
  for (const [k, key, min, max] of nums) {
    const v = patch[k]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`${k} must be a whole number from ${min} to ${max}.`)
    write(key, String(v))
  }
  return getWikiSettings()
}
