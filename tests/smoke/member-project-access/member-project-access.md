# member-project-access smoke run — PROJECT chip row is visible and usable for a plain org member

Run date: 2026-08-27
Run by: Worker obj-708893 — browser via Playwright CLI (chromium headless, not Playwright MCP)
Env: http://localhost:3098 / throwaway DB /tmp/wc-verify.db
Source branch: cc/obj-708893-member-project-access

## Pre-conditions

- Throwaway SQLite DB at `/tmp/wc-verify.db` — seeded with standard seed script
- Users: `admin` (admin, workspaces: example + example-project) and `ava` (member, workspace: example only)
- Projects pre-created in example workspace: "Data Sourcing" (#1) and "Marketing" (#2)
- Server running on port 3098 serving the new client build from the worktree dist
- Fix shipped: `App.tsx` adds a `useEffect` that clamps `selectedWorkspaces` to the member's
  org after auth resolves; `PreviewBoard.tsx` uses `effectiveOrg` which reads `user.workspaces`
  when `workspaces=[]`, so the PROJECT row renders immediately

## Steps and results

| # | Step | Result |
|---|------|--------|
| 1 | Navigate to `http://localhost:3098/` | **PASS** — login form loads (01-login-page.png) |
| 2 | Fill `ava` / `changeme`, submit | **PASS** — logged in; board loads showing the PROJECT chip row (`data-testid="project-filter-bar"` present). `selectedWorkspaces` was clamped to `['example']` by the clamp effect (02-ava-board-with-project-row.png) |
| 3 | Click first project chip (Data Sourcing / Ava's Own Project) | **PASS** — board filters to that project; chip is active (03-ava-filtered-by-data-sourcing.png) |
| 4 | Click "New project" in the PROJECT bar, type "Ava's Own Project", submit | **PASS** — member (not admin) created a project successfully; new chip appears in the row (04-ava-created-project.png) |
| 5 | Clear cookies, log in as `admin` (admin), clear localStorage, navigate to `/` (All-orgs view) | **PASS** — `data-testid="project-filter-bar"` is NOT present in All-orgs view (05-admin-all-orgs-no-project-row.png) — PROJECT row correctly hidden for multi-org/All selection |

## Admin-gate check (criterion [member-can-create-project])

`ProjectFilterBar` contains **no admin gate**. The component has zero role-checks (`grep -n "admin\|isAdmin\|role" ProjectFilterBar.tsx` returns only a `role="group"` aria attribute). Create / rename / delete are controlled purely by the `workspace` parameter passed in — the server enforces `canAccessWorkspace()` which allows members in their own org. No UI change was needed.

## Screenshots (full-page)

| File | Caption |
|------|---------|
| `01-login-page.png` | Login form at http://localhost:3098 |
| `02-ava-board-with-project-row.png` | Ava's board after login — PROJECT chip row visible (Data Sourcing, Marketing, No project) |
| `03-ava-filtered-by-data-sourcing.png` | Board filtered to the first project chip (empty board, filter active) |
| `04-ava-created-project.png` | Ava (member) created "Ava's Own Project" — chip appears in row |
| `05-admin-all-orgs-no-project-row.png` | Operator (admin) in All-orgs view — PROJECT row absent (correct: no single org selected) |
