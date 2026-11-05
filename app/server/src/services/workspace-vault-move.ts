/**
 * workspace-vault-move — fold one workspace's KB tree into another's, without
 * losing a byte (obj 900206, requirement 4).
 *
 * The rule is **copy-then-verify, never move-then-hope**:
 *
 * 1. Every file under `src/` is copied to the same relative path under `dest/`.
 * 2. A path that already exists in `dest/` is NEVER overwritten:
 *    - byte-identical (same sha256) → counted as `duplicate`, skipped;
 *    - different → written beside it as `<stem>.from-<srcSlug><ext>` and
 *      recorded in the collision log.
 * 3. Only after every source file is accounted for (`copied + duplicate +
 *    renamed === total`) may the caller retire the source tree, and `retire()`
 *    **renames** it to a sibling `_archived-<slug>/` — it never deletes. The
 *    card is explicit: "never delete vault data in this card."
 *
 * Nothing here reads file CONTENT into the report, so a credential that happens
 * to live in the vault cannot leak through the log — paths and hashes only.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export interface VaultCollision {
  /** Path relative to the source root. */
  relPath: string
  /** 'duplicate' = byte-identical, skipped. 'renamed' = differed, landed beside. */
  kind: 'duplicate' | 'renamed'
  /** Where it landed (relative to dest), for 'renamed'. */
  landedAs?: string
}

export interface VaultMovePlan {
  src: string
  dest: string
  files: number
  bytes: number
  copied: number
  collisions: VaultCollision[]
}

/** Relative paths of every file under `root` (directories are implied). */
export function listFiles(root: string, rel = ''): string[] {
  const abs = path.join(root, rel)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    const r = rel ? path.join(rel, e.name) : e.name
    if (e.isDirectory()) out.push(...listFiles(root, r))
    else if (e.isFile()) out.push(r)
  }
  return out.sort()
}

export function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** `notes.md` + slug `example` → `notes.from-example.md`; extension-less names keep working. */
export function collisionName(relPath: string, srcSlug: string): string {
  const dir = path.dirname(relPath)
  const ext = path.extname(relPath)
  const stem = path.basename(relPath, ext)
  const name = `${stem}.from-${srcSlug}${ext}`
  return dir === '.' ? name : path.join(dir, name)
}

/**
 * Plan (`apply: false`, the default) or perform the fold. The return value is
 * identical in both modes, so a dry-run report is a faithful preview.
 */
export function moveVaultTree(
  src: string,
  dest: string,
  srcSlug: string,
  opts: { apply?: boolean } = {},
): VaultMovePlan {
  const apply = opts.apply === true
  const files = listFiles(src)
  const collisions: VaultCollision[] = []
  let copied = 0
  let bytes = 0

  for (const rel of files) {
    const from = path.join(src, rel)
    bytes += fs.statSync(from).size
    const to = path.join(dest, rel)
    if (!fs.existsSync(to)) {
      if (apply) {
        fs.mkdirSync(path.dirname(to), { recursive: true })
        fs.copyFileSync(from, to)
      }
      copied++
      continue
    }
    if (fs.statSync(to).isFile() && sha256(from) === sha256(to)) {
      collisions.push({ relPath: rel, kind: 'duplicate' })
      continue
    }
    const landedAs = collisionName(rel, srcSlug)
    if (apply) {
      fs.mkdirSync(path.dirname(path.join(dest, landedAs)), { recursive: true })
      fs.copyFileSync(from, path.join(dest, landedAs))
    }
    collisions.push({ relPath: rel, kind: 'renamed', landedAs })
  }

  return { src, dest, files: files.length, bytes, copied, collisions }
}

/** Every source file reached the destination in one of the three forms. */
export function isAccountedFor(plan: VaultMovePlan): boolean {
  return plan.copied + plan.collisions.length === plan.files
}

/**
 * Retire the source tree by RENAMING it to `<parent>/_archived-<slug>`.
 * Refuses unless the plan accounts for every file. Never deletes.
 */
export function retireSourceTree(plan: VaultMovePlan, srcSlug: string): string {
  if (!isAccountedFor(plan)) {
    throw new Error(
      `refusing to retire '${plan.src}': ${plan.files} file(s) found but only ` +
        `${plan.copied + plan.collisions.length} accounted for`,
    )
  }
  const target = path.join(path.dirname(plan.src), `_archived-${srcSlug}`)
  if (fs.existsSync(target)) throw new Error(`refusing to retire: '${target}' already exists`)
  fs.renameSync(plan.src, target)
  return target
}
