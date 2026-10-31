import fs from 'fs'
import path from 'path'
import { getPack, isPackEnabled } from '../starter-packs.js'
import { workspaceKbRoot } from './kb-paths.js'
import { claimInbox, drainQueue, ensureKbFolders, recoverInterrupted, type IngestDeps, type ManifestEntry } from './ingest.js'
import { createIngestLlm, type LlmCall } from './llm.js'
import { kindForFile } from './extract.js'
import { afterDocIngest } from '../kb-wiki/hooks.js'

/** Glue between the routes and the pure ingest pipeline (obj 719936). */

export const PACK_ID = 'knowledge-import'

let llmOverride: LlmCall | null = null
/** Tests swap the AI for a stub. */
export function setIngestLlmForTests(fn: LlmCall | null): void { llmOverride = fn }

function llm(): LlmCall { return llmOverride ?? createIngestLlm() }

function packDir(): string {
  const p = getPack(PACK_ID)
  if (!p) throw new Error(`starter pack ${PACK_ID} is not installed`)
  return p.dir
}

export function packPrompt(name: 'organize' | 'answer'): string {
  return fs.readFileSync(path.join(packDir(), 'prompts', `${name}.md`), 'utf8')
}

export function ingestEnabled(): boolean {
  return isPackEnabled(PACK_ID)
}

export function ingestDeps(): IngestDeps {
  return { llm: llm(), systemPrompt: packPrompt('organize') }
}

export function answerLlm(): LlmCall { return llm() }

/** Sample files that ship with the pack (name + size), for the "try it" button. */
export function sampleFiles(): Array<{ name: string; bytes: number }> {
  const dir = path.join(packDir(), 'sample-data')
  try {
    return fs.readdirSync(dir)
      .filter(n => kindForFile(n) && !n.startsWith('.') && n.toLowerCase() !== 'readme.md')
      .sort()
      .map(n => ({ name: n, bytes: fs.statSync(path.join(dir, n)).size }))
  } catch { return [] }
}

/** Copy the pack's sample files into the workspace inbox (skips ones already uploaded). */
export function stageSamples(workspace: string): string[] {
  const kb = workspaceKbRoot(workspace)
  ensureKbFolders(kb)
  const dir = path.join(packDir(), 'sample-data')
  const staged: string[] = []
  for (const s of sampleFiles()) {
    fs.copyFileSync(path.join(dir, s.name), path.join(kb, 'sources/inbox', s.name))
    staged.push(s.name)
  }
  return staged
}

/** Register whatever is in the inbox and start reading it in the background. */
export function claimAndStart(workspace: string, uploadedBy?: string): ManifestEntry[] {
  const kb = workspaceKbRoot(workspace)
  const added = claimInbox(kb, new Date(), uploadedBy)
  startDrain(workspace)
  return added
}

export function startDrain(workspace: string): void {
  const kb = workspaceKbRoot(workspace)
  drainQueue(kb, ingestDeps()).then(() => { afterDocIngest(kb) }).catch(err => console.error(`[doc-ingest] ${workspace}: ${(err as Error).message}`))
}

/** On boot: requeue anything a restart interrupted and resume. */
export function resumeAfterRestart(workspaces: string[]): void {
  if (!ingestEnabled()) return
  for (const ws of workspaces) {
    try {
      const kb = workspaceKbRoot(ws)
      if (!fs.existsSync(path.join(kb, 'sources/_manifest.json'))) continue
      const n = recoverInterrupted(kb)
      if (n) console.log(`[doc-ingest] ${ws}: resuming ${n} interrupted file(s)`)
      startDrain(ws)
    } catch (err) {
      console.warn(`[doc-ingest] resume ${ws}: ${(err as Error).message}`)
    }
  }
}
