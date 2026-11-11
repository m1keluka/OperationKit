/**
 * Objectives safety net (incident 2026-06-30 / 2026-07-01: the objectives table
 * was mass-wiped when a vitest run inherited the production DB_PATH and ran
 * `DELETE FROM objectives`). PR #196 closed that exact vector at the DB layer;
 * this service is the defense-in-depth blast-radius layer so that even a NOVEL
 * mass-deletion is (a) survivable within minutes and (b) detected within ~60s:
 *
 *   Layer 4 — routine snapshots: every 15 min, dump the whole objectives table
 *             to a gzipped JSON file. Worst-case loss window drops 24h -> 15min.
 *   Layer 3 — drop guard: every 60s, compare the live objective count to the
 *             last-seen count (persisted, so a wipe DURING downtime is also
 *             caught on boot). On a sharp drop we CAPTURE a forensic snapshot
 *             FIRST (before anything else writes), then page via AlertBell +
 *             email (notify) and Telegram (sendTelegram).
 *
 * Restore from a snapshot: scripts/restore-objectives-snapshot.cjs <file.json.gz>
 */
import fs from "fs"
import path from "path"
import zlib from "zlib"
import { getDb } from "../db/index.js"
import { notify, sendTelegram } from "./notifier.js"

const SNAP_DIR = process.env.OBJ_SNAPSHOT_DIR || "/app/data/obj-snapshots"
const STATE_FILE = path.join(SNAP_DIR, ".watchdog-state.json")
const ROUTINE_KEEP = 96 // ~24h at 15-min cadence
const SNAPSHOT_TICK_MS = 15 * 60 * 1000
const GUARD_TICK_MS = 60 * 1000
const MIN_BASELINE = 50 // never alarm off a tiny/empty table
const ABS_DROP = 15 // alarm if >= this many objectives vanish in one interval
const PCT_DROP = 0.2 // ...or >= 20% gone

function ensureDir(): void {
  fs.mkdirSync(SNAP_DIR, { recursive: true })
}

function objectiveCount(): number {
  return (getDb().prepare("SELECT count(*) c FROM objectives").get() as { c: number }).c
}

/** Dump the whole objectives table to a gzipped JSON snapshot. tag=routine is pruned; tag=drop is kept forever. */
export function snapshotObjectives(tag: "routine" | "drop" = "routine"): { count: number; file: string } | null {
  try {
    ensureDir()
    // Read + serialize SYNCHRONOUSLY so the snapshot freezes the table state at
    // THIS instant — the drop-guard's forensic capture must happen before any
    // other write mutates the damaged table (mass-wipe guarantee). Only the heavy
    // 44MB gzip + disk write is offloaded to async so it never blocks the event
    // loop (2026-08-13: synchronous gzipSync of the full table stalled HTTP on
    // every 15-min tick). The in-memory payload is already captured, so deferring
    // persistence does not weaken capture-first.
    const rows = getDb().prepare("SELECT * FROM objectives").all()
    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)
    const file = path.join(SNAP_DIR, `objectives-${tag}-${ts}.json.gz`)
    const payload = JSON.stringify({ tag, count: rows.length, saved_at: new Date().toISOString(), rows })
    zlib.gzip(payload, (gzErr, buf) => {
      if (gzErr) { console.warn("[objectives-safety] snapshot gzip failed:", gzErr.message); return }
      fs.writeFile(file, buf, (wErr) => {
        if (wErr) { console.warn("[objectives-safety] snapshot write failed:", wErr.message); return }
        if (tag === "routine") pruneRoutine()
      })
    })
    return { count: rows.length, file }
  } catch (err) {
    console.warn("[objectives-safety] snapshot failed:", (err as Error).message)
    return null
  }
}

function pruneRoutine(): void {
  try {
    const files = fs
      .readdirSync(SNAP_DIR)
      .filter((f) => f.startsWith("objectives-routine-"))
      .sort()
    for (let i = 0; i < files.length - ROUTINE_KEEP; i++) {
      fs.unlinkSync(path.join(SNAP_DIR, files[i]))
    }
  } catch (err) {
    console.warn("[objectives-safety] prune failed:", (err as Error).message)
  }
}

function readState(): { count: number; ts: string } | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"))
  } catch {
    return null
  }
}

function writeState(count: number): void {
  try {
    ensureDir()
    fs.writeFileSync(STATE_FILE, JSON.stringify({ count, ts: new Date().toISOString() }))
  } catch (err) {
    console.warn("[objectives-safety] state write failed:", (err as Error).message)
  }
}

/** Compare live count vs last-seen; on a sharp drop, snapshot-then-page. Always records the new baseline. */
export function checkObjectivesGuard(): void {
  let current: number
  try {
    current = objectiveCount()
  } catch (err) {
    console.warn("[objectives-safety] count failed:", (err as Error).message)
    return
  }
  const prev = readState()
  if (prev && prev.count >= MIN_BASELINE) {
    const drop = prev.count - current
    if (drop >= ABS_DROP || (drop > 0 && current < prev.count * (1 - PCT_DROP))) {
      // CAPTURE FIRST — snapshot the damaged state before any other write touches it.
      const snap = snapshotObjectives("drop")
      const msg =
        `Objectives dropped ${prev.count} -> ${current} (-${drop}) within <=60s. ` +
        `Forensic snapshot: ${snap?.file ?? "SNAPSHOT FAILED"}. ` +
        `Likely a mass-delete/wipe. Restore: scripts/restore-objectives-snapshot.cjs`
      console.error("[objectives-safety] DROP ALARM:", msg)
      void notify({
        severity: "emergency",
        source: "objectives-safety",
        title: `Objectives count dropped ${prev.count} -> ${current}`,
        message: msg,
        dedup_key: "objectives-safety:drop",
        url: "https://cc.example.com",
      })
      void sendTelegram(`\u{1F6A8} COMMAND CENTER wipe guard: ${msg}`)
    }
  }
  writeState(current)
}

let guardTimer: ReturnType<typeof setInterval> | null = null
let snapTimer: ReturnType<typeof setInterval> | null = null

/** Idempotent. Boot: take a snapshot + run the guard once (catches a wipe during downtime), then tick. */
export function startObjectivesSafety(): void {
  if (guardTimer) return
  setTimeout(() => {
    try {
      const s = snapshotObjectives("routine")
      checkObjectivesGuard()
      console.log(`[objectives-safety] initial snapshot: ${s?.count ?? "?"} objectives -> ${s?.file ?? "FAILED"}`)
    } catch {
      /* never let the guard crash boot */
    }
  }, 15_000)
  guardTimer = setInterval(() => {
    try {
      checkObjectivesGuard()
    } catch {
      /* swallow */
    }
  }, GUARD_TICK_MS)
  snapTimer = setInterval(() => {
    try {
      snapshotObjectives("routine")
    } catch {
      /* swallow */
    }
  }, SNAPSHOT_TICK_MS)
  console.log("[objectives-safety] started (60s drop-guard + 15min snapshots)")
}

export function stopObjectivesSafety(): void {
  if (guardTimer) clearInterval(guardTimer)
  if (snapTimer) clearInterval(snapTimer)
  guardTimer = null
  snapTimer = null
}
