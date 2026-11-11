// OUTCOME ASSERTION (example #2 — CONTENT / published artifact) — obj 700028
//
// A content/marketing objective claims "I published the article." THIS asserts the
// published artifact actually exists and is non-trivial: present on disk (stand-in
// for a CMS fetch / an HTTP 200 on the live URL), at least MIN_BYTES long, and
// containing a required marker (stand-in for "the headline rendered"). A worker
// that wrote a summary but never produced the artifact — or produced an empty stub
// — fails this deterministically.
//
//   Env (all optional, with defaults):
//     OUTCOME_ARTIFACT   path to the published file, relative to cwd  (default published/report.md)
//     OUTCOME_MIN_BYTES  minimum acceptable size in bytes              (default 200)
//     OUTCOME_MARKER     required substring (e.g. a headline/H1)       (default "# ")
//
//   Exit 0  → the artifact was really published.                  → gate PASS
//   Exit 1  → missing / empty stub / marker absent.               → gate BLOCK
import fs from 'fs'
import path from 'path'

const artifact = process.env.OUTCOME_ARTIFACT || 'published/report.md'
const minBytes = Number(process.env.OUTCOME_MIN_BYTES || '200')
const marker = process.env.OUTCOME_MARKER ?? '# '
const abs = path.resolve(process.cwd(), artifact)

let body
try {
  body = fs.readFileSync(abs, 'utf-8')
} catch {
  console.error(`OUTCOME FAIL: published artifact not found at ${abs}. Nothing was published — the outcome did not happen.`)
  process.exit(1)
}

const bytes = Buffer.byteLength(body, 'utf-8')
if (bytes < minBytes) {
  console.error(`OUTCOME FAIL: artifact ${artifact} is only ${bytes} bytes (need ≥ ${minBytes}). A stub is not a publication.`)
  process.exit(1)
}
if (marker && !body.includes(marker)) {
  console.error(`OUTCOME FAIL: artifact ${artifact} is missing the required marker ${JSON.stringify(marker)} — it did not render as a real article.`)
  process.exit(1)
}
console.log(`outcome ok: ${artifact} published (${bytes} bytes, marker present)`)
