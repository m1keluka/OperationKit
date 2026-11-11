/**
 * jail-uploads — let a sandboxed session actually open the files (screenshots,
 * PDFs, CSVs) a person attached to its card. (obj 900408)
 *
 * ## What was wrong
 *
 * Card attachments are written by `POST /api/objectives/:id/upload` to
 * `/app/data/uploads/<objectiveId>/` on the control plane, and the follow-up
 * route appends those absolute paths to the message ("Attached files
 * (accessible on disk): - /app/data/uploads/…"). That worked while sessions ran
 * as tmux on the control plane. Under SESSION_ISOLATION=docker the frozen mount
 * set gives a jail exactly two binds — `/workspace` and `/home/jailuser` — so
 * the path in the message does not exist inside the jail, `Read` fails, and the
 * agent tells the person it "can't read screenshots".
 *
 * Files attached in the New Card modal had a second gap: they were uploaded to
 * the same dir but nothing told any session they existed.
 *
 * ## What this module does
 *
 * 1. {@link stageUploadsIntoJail} copies the card's OWN upload dir (regular
 *    files only, no symlinks, size-capped) into `<jail HOME>/uploads/` on every
 *    spawn. Copying, not a third bind mount, keeps the frozen two-bind contract
 *    and cannot break `docker run` on a host whose /app/data is not mapped.
 *    Every follow-up respawns, so a file attached mid-conversation is staged by
 *    the spawn that delivers the message naming it.
 * 2. {@link rewriteUploadPaths} rewrites `/app/data/uploads/<id>/` in the jail
 *    prompt to `/home/jailuser/uploads/`, so the paths the agent is handed are
 *    the paths that exist. Another card's upload dir is never rewritten (and
 *    never staged).
 * 3. {@link buildAttachedFilesBlock} lists the card's uploads in the prompt, so
 *    a screenshot attached when the card was created is no longer invisible.
 */
import fs from 'node:fs'
import path from 'node:path'
import { applyJailOwnership } from './jail-workspace.js'

/** Where objective uploads live on the control plane. Same constant as objectives-uploads.ts. */
export const UPLOAD_DIR = process.env.CC_UPLOAD_DIR || '/app/data/uploads'

/** Where a jailed session sees its card's uploads. Inside the per-session HOME bind. */
export const JAIL_UPLOADS_PATH = '/home/jailuser/uploads'

/** Per-file cap (matches the upload route's 20MB multer limit). */
const MAX_FILE_BYTES = 20 * 1024 * 1024
/** Total cap per spawn so a card with a huge upload history cannot fill /tmp. */
const MAX_TOTAL_BYTES = 200 * 1024 * 1024
/** Cap on files listed in the prompt. */
const MAX_LISTED = 50

function objectiveUploadDir(objectiveId: string | number, root: string = UPLOAD_DIR): string | null {
  const id = String(objectiveId)
  if (!/^\d+$/.test(id)) return null
  return path.join(root, id)
}

export interface UploadEntry {
  name: string
  path: string
  size: number
}

/** Regular files in the card's upload dir, oldest first. Never follows symlinks. */
export function listObjectiveUploads(objectiveId: string | number, root: string = UPLOAD_DIR): UploadEntry[] {
  const dir = objectiveUploadDir(objectiveId, root)
  if (!dir) return []
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out: UploadEntry[] = []
  for (const name of names.sort()) {
    const full = path.join(dir, name)
    try {
      const st = fs.lstatSync(full)
      if (!st.isFile()) continue
      out.push({ name, path: full, size: st.size })
    } catch { /* vanished between readdir and lstat */ }
  }
  return out
}

/**
 * Copy the card's uploads into `<jailHomeHost>/uploads/`. Best-effort: a staging
 * failure is logged and never blocks the spawn. Returns the number of files staged.
 */
export function stageUploadsIntoJail(
  objectiveId: string | number,
  jailHomeHost: string,
  root: string = UPLOAD_DIR,
): number {
  const files = listObjectiveUploads(objectiveId, root)
  if (files.length === 0) return 0
  const dest = path.join(jailHomeHost, 'uploads')
  let staged = 0
  let total = 0
  try {
    fs.mkdirSync(dest, { recursive: true })
    applyJailOwnership(dest, 'dir')
    for (const f of files) {
      if (f.size > MAX_FILE_BYTES || total + f.size > MAX_TOTAL_BYTES) {
        console.warn(`[jail-uploads] obj ${objectiveId}: skipping ${f.name} (${f.size} bytes) — over the staging cap`)
        continue
      }
      const target = path.join(dest, f.name)
      try {
        fs.copyFileSync(f.path, target)
        applyJailOwnership(target, 'jail-read')
        staged++
        total += f.size
      } catch (err) {
        console.warn(`[jail-uploads] obj ${objectiveId}: could not stage ${f.name}:`, (err as Error).message)
      }
    }
  } catch (err) {
    console.warn(`[jail-uploads] obj ${objectiveId}: could not create ${dest}:`, (err as Error).message)
  }
  if (staged) console.log(`[jail-uploads] obj ${objectiveId}: staged ${staged} upload(s) into ${JAIL_UPLOADS_PATH}`)
  return staged
}

/** Point this card's upload paths at their in-jail copies. Other cards' paths are left alone. */
export function rewriteUploadPaths(text: string, objectiveId: string | number, root: string = UPLOAD_DIR): string {
  const dir = objectiveUploadDir(objectiveId, root)
  if (!dir || !text) return text
  return text.split(`${dir}/`).join(`${JAIL_UPLOADS_PATH}/`)
}

/**
 * Prompt block listing the card's uploads (host paths — the jail spawn rewrites
 * them). Empty when the card has none, so prompts without uploads are unchanged.
 */
export function buildAttachedFilesBlock(objectiveId: string | number, root: string = UPLOAD_DIR): string[] {
  const files = listObjectiveUploads(objectiveId, root)
  if (files.length === 0) return []
  const shown = files.slice(-MAX_LISTED)
  const lines = [
    '',
    '## Files attached to this card',
    '',
    'The person attached these files (screenshots, documents, data). Open them with the Read tool — it shows images directly. Look at them before you start; they are part of the request.',
    ...shown.map(f => `- ${f.path}`),
  ]
  if (files.length > shown.length) lines.push(`- …and ${files.length - shown.length} older file(s) in the same folder`)
  return lines
}
