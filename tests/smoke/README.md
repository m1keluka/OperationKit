# tests/smoke/ — committed UI test evidence

This directory holds **committed, browsable test evidence**: numbered full-page
screenshots plus a PASS/FAIL markdown walkthrough, one folder per scenario. It is
the command-center port of the example3 (`example3-platform`) `tests/smoke/`
convention (obj #2392).

> **This is evidence, not an executed suite.** Nothing here is run by `pnpm test`
> or the Vitest CI gate (`.github/workflows/test.yml`). These are curated
> artifacts captured during human-in-the-loop Playwright **MCP** verification and
> committed so a reviewer can _browse the proof_ without re-running the browser.
> See the "Committed test evidence" section of the root `CLAUDE.md` for how this
> coexists with the "no Playwright/e2e in CI" rule.

## Layout

```
tests/smoke/
  <scenario>/
    <scenario>.md        # the walkthrough (format below)
    01-<slug>.png        # numbered, full-page screenshots
    02-<slug>.png
    ...
```

`objective-create/` is the reference exemplar — copy its shape.

## Walkthrough .md format

A scenario `.md` has four parts, in order:

1. **Metadata header** — `# <scenario> smoke run — <one-line summary>` followed by
   `Run date:`, `Run by:` (which agent/session + that it used Playwright MCP),
   `Env:` (URL / Supabase ref), and where the source artifacts came from.
2. **Pre-conditions** — fixtures seeded, migrations applied, credentials/roles
   used. Enough that the run could be reproduced.
3. **Steps and results** — a numbered table with columns `# | Step | Result`. Each
   Result starts with **PASS** or **FAIL** and states the concrete observed fact
   (a count, a redirect target, a status string), not just "works". Reference the
   screenshot that shows it.
4. **Screenshots (full-page)** — a manifest listing each `NN-slug.png` with a
   one-line caption.

Optionally close with **Notes / deviations** — anything curated, skipped, or
worth a follow-up.

## How evidence gets here

1. During a reviewer / design-arena session (the only sessions with Playwright
   `browser_*` MCP tools), drive the flow and capture full-page screenshots. The
   raw frames land in `.playwright-mcp/` (which is **gitignored** — that is fine;
   it is scratch space).
2. **Curate**: keep only genuinely-distinct frames, renumber them `01..NN` with
   descriptive slugs, and copy them into `tests/smoke/<scenario>/`.
3. Write `<scenario>.md` in the format above.
4. Commit. The committed copy under `tests/smoke/` is the durable evidence; the
   `.playwright-mcp/` scratch copy stays ignored.

This sidesteps the `.playwright-mcp/` gitignore entirely — no CI or gitignore
change is needed, because the evidence lives at a non-ignored path and is never
executed.
