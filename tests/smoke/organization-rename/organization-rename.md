# organization-rename smoke run — every user-facing "Workspace" label now reads "Organization"

**Run date:** 2026-08-14
**Run by:** worker session for objective 706134 (general agent). Plain worker sessions do **not**
get the Playwright `browser_*` MCP tools, so this run drove the pre-installed global Playwright
from a plain Node script instead (`createRequire('/usr/local/lib/node_modules/')('playwright')`,
Chromium from `PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright`, `--no-sandbox`).
**Env:** PR-276 preview — https://pr-276.cc.example.com (branch
`cc/obj-706134-worker-rename-projects-workspaces-to-org`, HEAD `9355541`).
Let's Encrypt cert `CN = pr-276.cc.example.com`, HTTP 200.
**Source artifacts:** captured to `/tmp/shots276/` and `/tmp/shots276b/`, curated and renumbered here.

## Pre-conditions

- Preview provisioned via `POST /api/internal/pr-created` (the **only** thing that provisions a
  preview — `gh pr create` alone does not; see decision
  `2026-08-14-cc-pr-preview-provisioning-requires-pr-created-call.md`). Spool job
  `deploy-pr276.json` drained OK at 04:22 UTC, after the fix commit.
- Preview DB is freshly seeded by `preview-deploy.sh`: users `mike` (admin, orgs example +
  example-project) and `ava` (member, org example), password `changeme`. Organizations seeded:
  Example Growth / Example Project / Mike Luka. Zero objectives — the board shots are empty-state.
- Logged in as `mike` (admin) — the Settings surface is admin-gated.
- Settings is served at **`/config`**, not `/settings`.

## Steps and results

| # | Step | Result |
|---|---|---|
| 1 | Load the preview over TLS | **PASS** — HTTP 200, `ssl_verify=0`, cert CN `pr-276.cc.example.com`, issuer Let's Encrypt, valid to 2026-11-12. |
| 2 | Log in as `mike`, open System → Config | **PASS** — Settings renders; page description reads "**Organizations**, users, agents, and platform configuration." (01) |
| 3 | Read the Settings tab strip | **PASS** — first tab reads "**Organizations**" (was "Workspaces"). Remaining tabs unchanged: Users, Agents & Skills, Assignments, Skill Graph, Cron Jobs, Tools. (01) |
| 4 | Read the manage card on the Organizations tab | **PASS** — card header "**Organizations**", primary action "**Add organization**". Three rows: Example Growth `example`, Example Project `example-project`, Mike Luka `personal`. (01) |
| 5 | Confirm the repo-link concept was NOT renamed | **PASS** — each org row still shows a "6 repos" / "2 repos" / "7 repos" chip; the `project` scope label elsewhere still reads "Project". These are the repo-link concept, deliberately untouched. (01) |
| 6 | Open the Users tab and expand `mike` | **PASS** — section header reads "**ORGANIZATION ACCESS**" (was "Workspace access"); membership rows `example` + `example-project` with Role / Assistant chat / Sees controls. (02) |
| 7 | Read the per-user membership counters at the right edge of each user row | **PASS** — DOM text extracted via `allInnerTexts()`: `ava` → `"1 organization"`, `mike` → `"2 organizations"`. Previously "1 workspace" / "2 workspaces" — this was the one label the string greps missed (it is split by a pluralization ternary) and was caught only by this browser pass. (02) |
| 8 | Read the "Sees:" visibility dropdown | **PASS** — options are "own objectives" / "**all in organization**". (02) |
| 9 | Open New Objective → expand Advanced | **PASS** — the field label reads "**Organization**" with value "Example" (options Example / Example Project / Mike Luka). (03) |
| 10 | Confirm the objective **type** concept was NOT renamed | **PASS** — the type chips still read PROJECT / BUG / TASK. This is a third, unrelated meaning of "project" (workflow tier) and is deliberately untouched. (03) |
| 11 | View the board with the org switcher | **PASS** — switcher pill reads "Example"; it renders the org slug label, never the literal word, so no change was needed there. Columns QUEUE / WORKING / NEEDS YOU (empty — seeded DB has no objectives). (04) |
| 12 | Re-check Settings/Organizations at 390×844 | **PASS** — "Organizations" tab active, "Add organization" button, all three org rows, mobile bottom tab bar. The longer labels do **not** overflow or truncate the tab strip or the button. (05) |
| 13 | Re-check Users at 390×844 | **PASS** — same "1 organization" / "2 organizations" DOM text at mobile width; no wrap or clipping. (06) |
| 14 | Grep the **served** JS bundles for surviving UI labels | **PASS** — across `index-*.js` and the lazy-loaded `ConfigPage-*.js` chunk: zero hits for a space-prefixed `' workspace'` (i.e. no prose/label usage left), and zero for `Workspaces`, `Add workspace`, `No workspaces`, `Create workspace`, `this workspace`, `Select a workspace`. 15 hits for `' organization'`. |
| 15 | Confirm internals survived in the bundle | **PASS** — remaining `workspace` hits in the bundle are all identifiers: React props `{workspace:i}`, object keys, API paths `/admin/workspaces`, `/api/workspaces`, `/workspaces-config`, query param `?workspace=`, localStorage key `cc-workspace`, route prefix `/w/${x}`, and the tab key `{key:"workspaces",label:"Organizations"}`. |
| 16 | Confirm the Google Workspace product name survived | **PASS** — `ConfigPage` still contains the literal `"Google Workspace"` twice (tool-connections list). |

## Screenshots (full-page)

| File | Caption |
|---|---|
| `01-settings-organizations-1440.png` | Settings → Organizations tab at 1440×900: tab label, card header, "Add organization", and the three org rows with their untouched "N repos" chips. |
| `02-settings-users-organization-access-1440.png` | Settings → Users at 1440×900 with `mike` expanded: "ORGANIZATION ACCESS", "1 organization" / "2 organizations" counters, "all in organization" visibility option. |
| `03-objective-modal-organization-field-1440.png` | New Objective modal, Advanced expanded: the "Organization" field label — alongside the deliberately-unchanged PROJECT/BUG/TASK type chips. |
| `04-board-org-switcher-1440.png` | Kanban board at 1440×900 with the "Example" org switcher in the top nav (renders the slug label, not the word). |
| `05-settings-organizations-390.png` | Settings → Organizations at 390×844: the longer labels fit the mobile tab strip and button without truncation. |
| `06-settings-users-390.png` | Settings → Users at 390×844: the membership counters read "organization(s)" at mobile width. |

## Notes / deviations

- **Not captured:** org badges on objective cards. The seeded preview DB has zero objectives, so
  the board is empty-state. Those badges render `objective.workspace` (the slug value) with no
  literal label text, so there was nothing to rename there anyway.
- **Step 7 is the reason this pass exists.** The `{n} workspace{n === 1 ? '' : 's'}` literal is
  split across a JSX expression, so neither the quoted-string sweep nor the word-boundary sweep
  found it. It shipped visibly wrong in the first commit and was fixed in `9355541`. On any future
  user-facing rename, add a pass for `word{` / `word${` — and still look at the rendered page.
- These screenshots are **evidence, never executed**. Nothing here is run by the Vitest CI gate.
