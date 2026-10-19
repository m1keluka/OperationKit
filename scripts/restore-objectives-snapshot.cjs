#!/usr/bin/env node
/**
 * Restore objectives from an objectives-safety snapshot (gzipped JSON).
 * Additive + non-destructive: only inserts objectives whose id is NOT already
 * present, so a live board is never clobbered (mirrors the 2026-07-01 recovery).
 *
 * Usage (inside the container):
 *   docker exec command-center node /home/operator/projects/operationkit/scripts/restore-objectives-snapshot.cjs \
 *     /app/data/obj-snapshots/objectives-drop-YYYYMMDDHHMM.json.gz
 */
const fs = require("fs")
const zlib = require("zlib")
const Database = require("/app/node_modules/better-sqlite3")

const file = process.argv[2]
if (!file) { console.error("usage: restore-objectives-snapshot.cjs <snapshot.json.gz>"); process.exit(1) }
const LIVE = process.env.DB_PATH || "/app/data/command-center.db"

const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf-8"))
const rows = snap.rows || []
if (!rows.length) { console.error("snapshot has no rows"); process.exit(1) }

const db = new Database(LIVE)
const present = new Set(db.prepare("SELECT id FROM objectives").all().map((r) => r.id))
const cols = Object.keys(rows[0])
const insert = db.prepare(
  `INSERT INTO objectives (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`
)
const before = present.size
let inserted = 0
const tx = db.transaction(() => {
  for (const row of rows) {
    if (present.has(row.id)) continue
    insert.run(cols.map((c) => row[c]))
    inserted++
  }
})
tx()
const after = db.prepare("SELECT count(*) c FROM objectives").get().c
const mx = db.prepare("SELECT max(id) m FROM objectives").get().m
db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name=\x27objectives\x27").run(mx)
console.log(`snapshot ${file}\nrows in snapshot: ${rows.length} | live before: ${before} | inserted: ${inserted} | live after: ${after} | maxid: ${mx}`)
db.close()
