# skill-graph-layer-migration smoke run — the Skill Graph tab reads the frontmatter layer graph

Run date: 2026-08-19
Run by: cto session, objective 707030 (adoption/verification of PR #296)
Env: PR #296 branch client served locally by Vite on `127.0.0.1:5199`, `/api` proxied
to the running server on `localhost:3002`
Tooling: Playwright **CLI/library** (`/usr/local/lib/node_modules/playwright`), NOT
Playwright MCP — a plain worker session does not get the `browser_*` tools
(see root `CLAUDE.md`, "Playwright MCP (in-session browser verification)")
Source artifacts: captured to `.playwright-mcp/` (gitignored), curated + renumbered here

## What this proves

PR #296 re-points the admin Skill Graph tab off the hand-maintained `graph` block in
`~/ai-workspace/skills/registry.json` and onto the okit-validated **frontmatter layer
graph** (`scripts/generate-layer-graph.py --json`). The registry block is deleted and
`okit validate` now fails loudly (REF-002) if it comes back.

The headline number is visible in shot `01`: **19 agents**. The deleted registry block
only ever knew 11 — that drift is the whole reason for the migration.

## Pre-conditions

- Admin session minted directly as a `token` cookie (HS256 over the server's own
  `JWT_SECRET`, payload `{id, username, role}`) — no password used, no prod
  credential handled.
- The graph payload is the **real** output of
  `python3 ~/ai-workspace/scripts/generate-layer-graph.py --json`, supplied through
  Playwright route interception. Interception was necessary because the running
  server predates this PR and still answers `GET /api/admin/skill-graph` with the
  old registry shape — which is itself the subject of step 3.

## Steps and results

| # | Step | Result |
|---|------|--------|
| 1 | `/config` → click the "Skill Graph" tab at 1440×900 | PASS — three concentric rings render (agents outer, skills middle, tools inner); header reads `19 agents · 81 skills · 53 tools · 147 agent→skill · 76 skill→tool` with the `frontmatter-layer-graph` provenance badge — see `01-graph-desktop-1440.png` |
| 2 | Same tab at 390×844 (`deviceScaleFactor` 2, `isMobile`, `hasTouch`) | PASS — chrome reflows to the mobile bottom nav, counts wrap to two lines, graph stays centred and legible; zoom controls measure **44.0 × 44.0 px** — see `02-graph-mobile-390.png` |
| 3 | Serve the **old** API shape (`{version, generated_at, skills, schema}`) with HTTP 200 | PASS — renders the designed `EmptyState` ("Skill graph unavailable") naming the restart as the likely cause. **Zero** console/pageerror events; the `Cannot read properties of undefined (reading 'agents')` TypeError is gone — see `03-stale-shape-emptystate.png` |
| 4 | WCAG AA contrast on the 11px secondary strings | PASS — all three measure **5.587:1 / 5.587:1 / 5.856:1** against their surfaces, clear of the 4.5:1 floor (see below) |
| 5 | Zoom in/out disabled at the clamp | PASS — at fit-zoom both enabled; at `ZOOM_MAX` `Zoom in.disabled === true`; at `ZOOM_MIN` `Zoom out.disabled === true` |
| 6 | Console during the graph flow | PASS — zero errors in both shot 1 and shot 2 |

### Step 3 is a real deploy hazard, not a synthetic case

`scripts/self-deploy.sh frontend` ships the client with **no backend restart** — root
`CLAUDE.md` calls that mode "zero impact". So between a frontend-only deploy of this PR
and the next backend restart, the previous server really does answer with the old shape.
The first browser pass reproduced the crash (whole tab replaced by the ErrorBoundary);
the guard added in `bfe4ef3` turns it into the EmptyState above.

### Step 4 measurements (page background `rgb(12, 15, 20)`)

| Element | Class | Color | Background | Ratio |
|---|---|---|---|---|
| "Drag to pan · scroll to zoom · click a node to inspect" | `text-[11px] text-fg-2` | `rgb(138,147,163)` | `rgb(22,27,34)` | **5.587:1** |
| "147 agent→skill · 76 skill→tool" | `font-mono text-[11px] text-fg-2` | `rgb(138,147,163)` | `rgb(22,27,34)` | **5.587:1** |
| "dashed = load-on-demand" | `text-fg-2` | `rgb(138,147,163)` | `rgba(18,22,29,.9)` | **5.856:1** |

All three were `text-fg-3` (`#5b6472`, ~3.2:1 — an AA failure) before `bfe4ef3`. No
`text-fg-3` remains in `SkillGraph.tsx`.

## Screenshots

- `01-graph-desktop-1440.png` — Skill Graph tab at 1440×900, real layer-graph payload
- `02-graph-mobile-390.png` — same tab at 390×844 with the mobile bottom nav
- `03-stale-shape-emptystate.png` — stale API shape degrades to the EmptyState, no crash

All three are byte-distinct (`sha256` `354cc0df…`, `0c859167…`, `56c881d5…`).

## Notes / deviations

- **Committed evidence, never executed.** Per the root `CLAUDE.md` "Committed test
  evidence" section and `tests/smoke/README.md`, nothing here is run by `pnpm test`
  or CI. The executed gate for this PR is the Vitest CLI suite
  (161 files / 2125 tests green) plus `scripts/ui-conformance.sh` (exit 0).
- **Canvas colors are token-derived.** `readPalette()` reads `--st-working`,
  `--accent`, `--ok-verify`, `--ok-alarm`, `--fg-0`, `--fg-3` off computed style at
  draw time, so the canvas cannot drift from the design system. No hex literal
  exists in `SkillGraph.tsx`.
- **Known limitation, not a regression:** at fit-zoom only agent labels are drawn;
  skill and tool labels appear on hover/zoom, because 134 labels on the inner rings
  are illegible at that scale. Deliberate — see the comment at `SkillGraph.tsx`
  around the label pass.
- The tab strip is horizontally scrollable at 390px and clips the last tab. Pre-existing
  platform chrome, present on `main`, not introduced by this PR.
