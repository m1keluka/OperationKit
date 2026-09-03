# secrets-multi-org smoke run — one create action scopes a secret to several organizations

**Run date:** 2026-08-16
**Run by:** worker session for objective 706458 (general agent). Plain worker sessions do **not**
get the Playwright `browser_*` MCP tools, so this run drove the pre-installed global Playwright
from a plain Node script instead (`import { chromium } from '/usr/local/lib/node_modules/playwright/index.mjs'`,
Chromium from `PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright`).
**Env:** PR-282 preview — https://pr-282.cc.example.com (branch
`cc/obj-706458-worker-secrets-create-modal-multi-select`, HEAD `c036a53`). HTTP 200 over TLS.
**Source artifacts:** captured to `/tmp/verify-706458/`, curated and renumbered here.

## Pre-conditions

- Preview provisioned via `POST /api/internal/pr-created` (the **only** thing that provisions a
  preview — `gh pr create` alone does not; see decision
  `2026-08-14-cc-pr-preview-provisioning-requires-pr-created-call.md`). The first spool job
  FAILED (`tsc -b` build error, see the decision doc for obj 706458); a second job after the fix
  commit drained `OK` at 16:49 UTC.
- Preview DB freshly seeded by `preview-deploy.sh`: users `mike` (admin, orgs example +
  example-project) and `ava` (member, org example only), password `changeme`. Organizations seeded:
  Example / Example Project / Operator. Zero secrets at start.
- Logged in as `mike` (admin) for the UI steps; `ava` (member) used for the constraint check.
- Secrets page is served at `/settings/secrets`.

## Steps and results

| # | Step | Result |
|---|---|---|
| 1 | Load the preview over TLS | **PASS** — HTTP 200 (`curl -sS -o /dev/null -w '%{http_code}'`), no cert error. |
| 2 | Open Settings → Secrets, click **+ New** | **PASS** — modal opens at the admin default scope, Command Center. (05) |
| 3 | Read the scope explanation with scope = Command Center | **PASS** — rendered **inline** under the Scope select (`[data-testid="modal-scope-hint"]`, wired via `aria-describedby`), text: "Command-Center-wide — applies everywhere, in every organization." Not a hover `title=`. (05) |
| 4 | Switch scope to **Organization** | **PASS** — hint text updates in place to "Applies only to everyone working inside the selected organization(s) — not everywhere. Pick "Command Center" for a secret that applies everywhere." (01) |
| 5 | Confirm the old single-select is gone at create time | **PASS** — `[data-testid="modal-scope-organization"]` count = **0**; `[data-testid="modal-scope-organizations"]` renders a checkbox list with **3** checkboxes, one per org the caller may target. (01) |
| 6 | Tick **Example** + **Example Project**, type key + value | **PASS** — live summary reads "2 of 3 selected — 2 secret rows will be created, one per organization."; submit button relabels to "**Create in 2 organizations**". (02) |
| 7 | Submit | **PASS** — modal closes, table reloads. (03) |
| 8 | Read the all-scopes table | **PASS** — **2 rows** for `MULTI_ORG_DEMO_KEY`, badged `Organization · Example` and `Organization · Example Project` (DOM text extracted via `allTextContents()`). Count line: "2 secrets across 2 organizations". (03) |
| 9 | Confirm each row is still an ordinary single-scope row | **PASS** — every row carries its own History / Edit / Delete actions, unchanged. (03) |
| 10 | **Partial failure**: repeat with the `example-project` POST forced to 403 (Playwright `page.route` fulfilling 403 for that one request body) | **PASS** — the modal **stays open** and reports "Created in 1 of 2 organizations — 1 failed.", then per org: "✓ Example — created" / "✕ Example Project — forbidden". No all-or-nothing claim. (04) |
| 11 | Confirm the partial failure left the successful row in place | **PASS** — the table behind the modal refreshed to "3 secrets across 2 organizations" with a new `Organization · Example` row; the Example Project row was correctly NOT created. (04) |
| 12 | Confirm the retry affordance | **PASS** — only the failed org stays ticked (Example unticked, Example Project ticked), summary drops to "1 of 3 selected — 1 secret row will be created", and the copy says so explicitly. (04) |
| 13 | Re-run the whole multi-select flow at 390×844 | **PASS** — checkbox list, summary, hint and the "Create in 2 organizations" button all render without overflow or clipping; rows keep their 44px touch height. (06) |
| 14 | **Member constraint** — `GET /api/secrets/principals` as `ava` | **PASS** — `{"organizations":[{"slug":"example","name":"Example"}],"users":[{"id":2,"username":"ava"}],"canUseGlobal":false}`. The checkbox list is built from this, so a member can only ever tick orgs they belong to, and Command Center is not offered. |
| 15 | **Member constraint, server side** — `POST /api/secrets` as `ava` for `example-project` (not a member) | **PASS** — `403 {"error":"You do not have access to this scope"}`. The same org as `example` returns `201`. The fan-out cannot launder a write into an org the caller can't already reach. |
| 16 | Confirm no new server surface | **PASS** — every create in the fan-out is a `POST /api/secrets` (the pre-existing per-scope endpoint); the diff touches **zero** files under `app/server/`. |

## Screenshots

| File | Caption |
|---|---|
| `01-modal-org-multiselect-1440.png` | Create modal at Organization scope, 1440×900: inline scope hint under the Scope select, three-org checkbox list, "No organizations selected." summary, Select all. |
| `02-two-orgs-ticked-1440.png` | Example + Example Project ticked: "2 of 3 selected — 2 secret rows will be created, one per organization." and the "Create in 2 organizations" button. |
| `03-two-rows-created-1440.png` | The all-scopes table after submit: two rows for the same key, each badged with its own organization; per-row History / Edit / Delete unchanged. |
| `04-partial-failure-report-1440.png` | Forced 403 on Example Project: "Created in 1 of 2 organizations — 1 failed." with ✓ Example / ✕ Example Project, modal held open, only the failed org still ticked, and the Example row visible behind. |
| `05-inline-hint-command-center-1440.png` | Same modal at Command Center scope — the inline hint reads "applies everywhere, in every organization", the contrast that removes the old ambiguity. |
| `06-two-orgs-ticked-390.png` | The same multi-select at 390×844: no overflow, 44px rows, full-width action row. |

## Not covered here

- Editing/moving an existing secret across organizations — deliberately **out of scope**: a row IS
  one scope, so the edit modal keeps its single-select (asserted by the vitest case
  "keeps EDIT single-scope"). No browser evidence needed for an unchanged surface.
