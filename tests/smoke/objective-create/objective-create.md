# objective-create smoke run — create an objective from the board

Run date: 2026-06-22
Run by: reviewer session (Playwright MCP, browser_* tools)
Env: PR-110 preview — `https://pr-110.cc.example.com`
Source artifacts: captured to `.playwright-mcp/` (gitignored), curated + renumbered into this directory

## Pre-conditions

- PR-110 preview deploy is live and reachable at `https://pr-110.cc.example.com`.
- Operator credentials available for the preview environment (login form drives
  the session; the `/api/auth/me` 401 below is the pre-auth probe, expected).
- Board renders the existing objective set (no fixtures seeded — this is the live
  preview board, so the exact card list will differ on re-run).

## Steps and results

| # | Step | Result |
|---|------|--------|
| 1 | Navigate to preview root → login page renders | PASS — login form mounts; one expected `401` on `/api/auth/me` (pre-auth session probe) — see `01-login.png` |
| 2 | Sign in → board loads with objective columns | PASS — board renders the column layout with existing objective cards — see `02-board.png` |
| 3 | Open "new objective" modal and fill the form | PASS — modal mounts over the board; title + body fields accept input and the submit control enables — see `03-modal-filled.png` |
| 4 | Submit → new objective appears on the board | PASS — modal dismisses, board re-renders with the created objective card present — see `04-created.png` |
| 5 | Desktop viewport (1440px) renders board without layout break | PASS — full-width board, columns evenly distributed, no horizontal scroll — see `05-desktop-1440.png` |
| 6 | Mobile viewport (390px) renders board responsively | PASS — columns reflow to the mobile layout, nav collapses, cards remain legible — see `06-mobile-390.png` |
| 7 | Console during the flow | PASS (non-blocking) — only the pre-auth `401 /api/auth/me` and a DOM autocomplete-attribute hint; no application errors |

## Screenshots (full-page)

- `01-login.png` — Login page (pre-auth landing; `/api/auth/me` 401 probe is expected)
- `02-board.png` — Objective board after sign-in (existing cards across columns)
- `03-modal-filled.png` — New-objective modal open with title + body filled
- `04-created.png` — Board after submit; the new objective card is present
- `05-desktop-1440.png` — Board at 1440px desktop viewport
- `06-mobile-390.png` — Board at 390px mobile viewport (responsive reflow)

## Notes / deviations

- **This scenario is a reference exemplar** for the `tests/smoke/` convention
  (obj #2392). It is committed evidence, not an executed suite — `pnpm test` /
  the Vitest CI gate never run these files. See `tests/smoke/README.md` and the
  "Committed test evidence" section of the root `CLAUDE.md`.
- **Curation from raw capture.** The raw Playwright MCP run wrote eight frames to
  `.playwright-mcp/cc-1452-*.png`. Three consecutive frames (`02-board`,
  `03-afternew`, `04-modal`) were byte-identical (the modal had not finished
  mounting when frames 3–4 were taken), so they were collapsed to a single board
  frame here and the remaining distinct frames renumbered `01`–`06`. Curating to
  genuinely-distinct frames is part of the convention — a walkthrough should not
  claim a step is shown by a screenshot identical to the previous one.
- **Live-preview board, not a seeded fixture.** The card list in `02`/`04` is
  whatever PR-110's board held at run time; a re-run will show a different set.
  For evidence that must be reproducible, seed a tagged fixture first (see the
  example3 `s3-1-workbench` run for that pattern).
