# Living product docs

These files are the product manual. They are wrong if they describe yesterday’s chrome.

## Convention (every linked repo)

```
docs/product/README.md        # one sentence, one paragraph, table of contents
docs/product/01-what-it-is.md # one page + overview mermaid
docs/product/02-how-it-works.md  # loop mermaid (required)
docs/product/07-data.md       # ER mermaid + tables/files inventory (required)
docs/product/*.md             # the rest — short, current, no archaeology
docs/product/LIVING.md        # this convention (copy or link)
```

Rules:

- Write for a person using the product, not for the git log.
- **Always ship both a mermaid of the product loop and a mermaid of the data spine.** Visual first, then words. GitHub and the in-app Docs editor both render mermaid.
- If a page is unused or hidden from nav, say so or delete the mention.
- Do not duplicate `docs/architecture/` (modules, HTTP contracts). Link it.
- Prefer delete-and-rewrite a stale section over appending “Update (2026-…)”.
- `07-data.md` inventory must match `CREATE TABLE` in that repo (for OperationKit: `app/server/src/db/schema/*.ts`). The breathe Job greps those names.

## What updates them

A OperationKit **Job** named `docs-breathe` (cron `15 6 * * *` UTC, org Example). Each morning it:

1. Lists linked repos with **Living docs** on and a `repo_path` on disk.
2. For each, reads `git log --since=yesterday` and any merged PRs / done Board cards for that project.
3. **If nothing product-facing changed, it writes nothing** and closes — **except** it still refreshes mermaid + `07-data.md` when tables were added/removed or the loop/engines/nav changed.
4. If something changed (nav, auth, a user-visible flow, a new engine, a new SQLite table), it edits `docs/product/` in a **PR** on that repo, including the flowcharts. No drive-by on `main`. No essays about refactors that did not change the product.
5. For OperationKit: `rg -o 'CREATE TABLE IF NOT EXISTS ([a-z_]+)' app/server/src/db/schema -r '$1' | sort -u` must be represented in `07-data.md`. Add/remove names; do not leave ghosts.

OperationKit’s own tree is the reference implementation.

## Adding a new repo to the loop

1. Settings → Org → attach the GitHub repo (path on disk if we have a checkout).
2. Leave Living docs on.
3. Either wait for docs-breathe to stub `docs/product/` (README, 01 with mermaid, 07-data), or copy this folder’s README + 01-what-it-is.md + 07-data.md and fill them once.

## What this is not

Not a changelog. Not CLAUDE.md. Not the architecture catalog. Not an excuse to run Opus every morning if the product did not move.
