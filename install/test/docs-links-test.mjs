// Check that every relative link (and #anchor) in the install docs points at a
// file / heading that exists, using GitHub's heading-slug rules.
//   node install/test/docs-links-test.mjs [file.md …]
import fs from 'node:fs'
import path from 'node:path'
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const files = process.argv.slice(2).length ? process.argv.slice(2) : [
  'README.md', 'INSTALL.md', 'CHANGELOG.md', 'docs/RECOMMENDED-STACK.md',
  'docs/migration/ovh-rise4.md', 'docs/product/06-operating.md',
  'docs/CLOUDFLARE-API-ACCESS.md',
]
const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N}\- _]/gu, '').replace(/ /g, '-')
const anchorsCache = new Map()
function anchors(file) {
  if (anchorsCache.has(file)) return anchorsCache.get(file)
  const seen = new Map(), out = new Set()
  let fence = false
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; continue }
    const m = !fence && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (!m) continue
    const base = slug(m[1].replace(/`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'))
    const n = seen.get(base) || 0
    seen.set(base, n + 1)
    out.add(n ? `${base}-${n}` : base)
  }
  anchorsCache.set(file, out)
  return out
}
let bad = 0, checked = 0
for (const rel of files) {
  const file = path.join(root, rel)
  let fence = false
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) { fence = !fence; return }
    if (fence) return
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = m[1]
      if (/^(https?:|mailto:)/.test(href)) continue
      checked++
      const [p, a] = href.split('#')
      const target = p ? path.resolve(path.dirname(file), p) : file
      if (!fs.existsSync(target)) { console.log(`  FAIL  ${rel}:${i + 1} ${href} (no such file)`); bad++; continue }
      if (a && target.endsWith('.md') && !anchors(target).has(a)) { console.log(`  FAIL  ${rel}:${i + 1} ${href} (no heading #${a})`); bad++ }
    }
  })
}
console.log(bad ? `docs-links: ${bad} broken of ${checked}` : `docs-links: all ${checked} relative links resolve`)
process.exit(bad ? 1 : 0)
