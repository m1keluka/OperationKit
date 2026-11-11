import fs from 'fs'
import path from 'path'
import { getDb } from '../../db/index.js'
import { createIngestLlm, type LlmCall } from '../doc-ingest/llm.js'
import { workspaceKbRoot } from '../doc-ingest/kb-paths.js'
import { SETUP_STATE_DIR, SETUP_PROMPT_FILE, getRun, listRuns, recoverRun, runWorker, type RunDeps } from './runs.js'

/**
 * Glue between the Knowledge Base Setup routes and the pure run engine
 * (obj 900556). The AI call is the same one document ingest makes
 * (doc-ingest/llm.ts): only extracted, secret-scrubbed text leaves the server,
 * and only to the AI provider this install was set up with.
 */

let llmOverride: LlmCall | null = null
/** Tests (and the screenshot harness) swap the AI for a stub. */
export function setSetupLlmForTests(fn: LlmCall | null): void { llmOverride = fn }

export function setupSystemPrompt(): string {
  return fs.readFileSync(SETUP_PROMPT_FILE, 'utf8')
}

function dbOrUndefined() {
  try { return getDb() } catch { return undefined }
}

export function setupDeps(): RunDeps {
  return {
    llm: llmOverride ?? createIngestLlm(),
    systemPrompt: setupSystemPrompt(),
    db: dbOrUndefined(),
    setupUrl: `${(process.env.PUBLIC_URL || process.env.APP_URL || '').replace(/\/+$/, '')}/knowledge/setup`,
  }
}

export function startRunWorker(workspace: string, runId: string): Promise<void> {
  const kb = workspaceKbRoot(workspace)
  return runWorker(kb, runId, setupDeps()).catch(err => console.error(`[kb-setup] ${workspace}: ${(err as Error).message}`))
}

/** On boot: a run that was 'running' when the server stopped carries on. */
export function resumeSetupRunsAfterRestart(workspaces: string[]): void {
  for (const ws of workspaces) {
    try {
      const kb = workspaceKbRoot(ws)
      if (!fs.existsSync(path.join(kb, SETUP_STATE_DIR))) continue
      for (const r of listRuns(kb)) {
        if (r.status !== 'running' || !recoverRun(kb, r.id)) continue
        console.log(`[kb-setup] ${ws}: resuming run ${r.id} (${getRun(kb, r.id)?.counts.pending ?? 0} file(s) left)`)
        void startRunWorker(ws, r.id)
      }
    } catch (err) {
      console.warn(`[kb-setup] resume ${ws}: ${(err as Error).message}`)
    }
  }
}
