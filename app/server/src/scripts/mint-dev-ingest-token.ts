// Mint a per-platform ingest token for the Universal Development API (obj-704214).
// Spec: universal-development-api.md §3.1-§3.3, schema §2.6.
//
//   npx tsx src/scripts/mint-dev-ingest-token.ts <workspace>
//   docker exec command-center npx tsx /app/server/src/scripts/mint-dev-ingest-token.ts example-project
//
// Only sha256(token) is ever persisted. The raw value is printed ONCE here and
// is unrecoverable afterwards — there is no "show me the token again" path, by
// design: a stored raw token is a stored password.
//
// Rotation is a first-class flow, not a special case. The current hash is moved
// to `ingest_token_hash_previous` and BOTH remain valid (middleware/
// dev-ingest-token.ts compares against either), so a platform can deploy the
// new token on its own schedule instead of taking an outage at the moment of
// rotation. Run the script a second time to retire the previous value.
import crypto from 'crypto'
import Database from 'better-sqlite3'

const DB_PATH = process.env.DB_PATH || '/app/data/command-center.db'

const workspace = (process.argv[2] || '').trim()
if (!workspace) {
  console.error('usage: npx tsx src/scripts/mint-dev-ingest-token.ts <workspace>')
  process.exit(1)
}
// The slug is half of the credential (`dvi_<slug>_<32 hex>`) and the middleware
// splits on `_`, so the slug must not contain one.
if (!/^[a-z0-9-]{1,40}$/.test(workspace)) {
  console.error(`Invalid workspace slug "${workspace}" — must match [a-z0-9-]{1,40} (no underscores).`)
  process.exit(1)
}

const db = new Database(DB_PATH)

const row = db
  .prepare("SELECT id, config FROM workspace_integrations WHERE workspace = ? AND kind = 'development'")
  .get(workspace) as { id: number; config: string } | undefined

if (!row) {
  console.error(
    `No kind='development' integration row for workspace "${workspace}".\n` +
      'Create it first (Config page, or seedDevelopmentRegistry on boot) — this script only mints INTO an existing row.',
  )
  db.close()
  process.exit(1)
}

// READ-MERGE-WRITE. The config JSON is shared with the admin UI and carries keys
// this script knows nothing about (allowed_origins, attachment_storage, notify,
// posthog_project_id, and anything a later wave adds). Re-deriving the object
// and stringifying it over the top would silently drop them, so the existing
// object is parsed and only the three token keys are replaced.
let config: Record<string, unknown> = {}
try {
  const parsed = JSON.parse(row.config || '{}') as unknown
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    config = parsed as Record<string, unknown>
  } else {
    console.warn('[mint] existing config was not a JSON object — starting from {}')
  }
} catch {
  console.warn('[mint] existing config was unparseable JSON — starting from {}')
}

const token = `dvi_${workspace}_${crypto.randomBytes(16).toString('hex')}`
const hash = crypto.createHash('sha256').update(token, 'utf8').digest('hex')

const previous = typeof config.ingest_token_hash === 'string' ? config.ingest_token_hash : undefined
if (previous) config.ingest_token_hash_previous = previous
config.ingest_token_hash = hash
// Prefix only, and DELIBERATELY carrying zero bytes of the random half:
// api.md §3.1 defines the clear-text prefix as exactly `dvi_<workspace>_`. It
// identifies which platform a credential belongs to for display and log
// correlation; it is not meant to identify an individual token. Including even
// 6 hex chars would persist 24 bits of the secret next to its own hash, which
// is a gift to anyone who gets read access to this row.
config.ingest_token_prefix = `dvi_${workspace}_`

db.prepare("UPDATE workspace_integrations SET config = ?, updated_at = datetime('now') WHERE id = ?").run(
  JSON.stringify(config),
  row.id,
)
db.close()

console.log('')
console.log(`  Minted a development ingest token for workspace: ${workspace}`)
console.log('')
console.log(`      ${token}`)
console.log('')
console.log('  STORE THIS NOW — IT CANNOT BE RECOVERED.')
console.log('  Only its sha256 hash was written to the database; nothing on this')
console.log('  server can print it again. If you lose it, mint a new one.')
console.log('')
if (previous) {
  console.log('  The previous token has been moved to ingest_token_hash_previous and')
  console.log('  REMAINS VALID so you can roll the platform over without an outage.')
  console.log('  Run this script again once the new token is deployed to retire it.')
  console.log('')
}
