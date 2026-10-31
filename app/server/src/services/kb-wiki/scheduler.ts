import fs from 'fs'
import path from 'path'
import { workspaceKbRoot } from '../doc-ingest/kb-paths.js'
import { ingestEnabled } from '../doc-ingest/service.js'
import { getWorkspaceSlugs } from '../workspaces.js'
import { lastLintRun, runLint, type LintReport } from './lint.js'
import { wikiLlm, type LlmCall } from './llm.js'
import { STATE_DIR } from './paths.js'
import { getWikiSettings, type WikiSettings } from './settings.js'

/**
 * Runs the wiki cleanup pass on its schedule (obj 720117). A 10-minute tick
 * asks "is a run due?" per workspace, so a restart never loses or doubles a
 * run: the last run time lives in the KB itself (.kb-wiki/lint-last.json).
 */

const TICK_MS = 10 * 60_000
const WEEK_MS = 7 * 86_400_000

/** Pure: is a cleanup due now, given when it last ran? */
export function lintDue(lastRunIso: string | null, settings: Pick<WikiSettings, 'lint_schedule' | 'lint_hour_utc'>, now: Date): boolean {
  if (settings.lint_schedule === 'off') return false
  const last = lastRunIso ? Date.parse(lastRunIso) : NaN
  if (settings.lint_schedule === 'weekly') return !Number.isFinite(last) || now.getTime() - last >= WEEK_MS
  const slot = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), settings.lint_hour_utc)
  return now.getTime() >= slot && (!Number.isFinite(last) || last < slot)
}

function hasWiki(kbRoot: string): boolean {
  return fs.existsSync(path.join(kbRoot, STATE_DIR)) || fs.existsSync(path.join(kbRoot, 'sources/_manifest.json'))
}

function aiOrNull(): LlmCall | null {
  try { return wikiLlm() } catch { return null }
}

export async function runLintForWorkspace(workspace: string, now: Date = new Date()): Promise<LintReport> {
  const s = getWikiSettings()
  return runLint(workspaceKbRoot(workspace), {
    llm: s.lint_ai_pages > 0 ? aiOrNull() : null,
    now,
    staleDays: s.lint_stale_days,
    aiPages: s.lint_ai_pages,
  })
}

let running = false

async function tick(): Promise<void> {
  if (running) return
  running = true
  try {
    const settings = getWikiSettings()
    if (settings.lint_schedule === 'off' || !ingestEnabled()) return
    for (const ws of getWorkspaceSlugs()) {
      try {
        const kb = workspaceKbRoot(ws)
        if (!hasWiki(kb) || !lintDue(lastLintRun(kb), settings, new Date())) continue
        const r = await runLintForWorkspace(ws)
        console.log(`[kb-wiki] cleanup ${ws}: fixed ${r.fixed.length}, ${r.needs_human.length} need a look`)
      } catch (err) {
        console.warn(`[kb-wiki] cleanup ${ws}: ${(err as Error).message}`)
      }
    }
  } finally {
    running = false
  }
}

let timer: NodeJS.Timeout | null = null

export function startWikiLintScheduler(): void {
  if (timer) return
  timer = setInterval(() => { void tick() }, TICK_MS)
  timer.unref()
}

export function stopWikiLintScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}
