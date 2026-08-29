# projects-within-organizations smoke run — board folder filter + full project CRUD from the UI

**Run date:** 2026-08-27
**Run by:** CTO session for obj 708826, driving Chromium via the Playwright Node API
(the worker session has no `browser_*` MCP tools; the frames are equivalent full-viewport
captures from a scripted run, `/tmp/cc708826/verify.mjs`).
**Env:** a local, throwaway instance of this branch — `app/server` on `http://localhost:3311`
serving the branch's own `app/client/dist` build, `DB_PATH=/tmp/cc708826/cc.db`
(a fresh seeded SQLite file; the production DB was never opened).
**Branch:** `feat/projects-ui-708826`

## Pre-conditions

- `npx tsx src/db/seed.ts` against the throwaway DB → users `admin` (admin, workspaces
  example / example-project / personal) and `ava`.
- Five objectives inserted directly into the seeded DB, all with `project_id = NULL`:
  four in `example` (one of which carries the legacy repo-link `project =
  'command-center-infra'`) and one in `example-project` as a cross-organization control.
- **Zero** rows in `projects` at the start — every project in this run was created
  through the UI.
- Logged in as `admin` / `changeme` through the real login form.

## Steps and results

| # | Step | Result |
|---|------|--------|
| 1 | Open the Example organization board | **PASS** — a `PROJECT` row renders above `OWNER` with only `All projects` + `＋ New project`; four Example cards. `01` |
| 2 | Click `＋ New project`, type `Data Sourcing`, confirm | **PASS** — project created and immediately opened (its chip is the pressed one). `02` |
| 3 | Create a second project `Marketing`, then click `All projects` | **PASS** — chips read `All projects · Data Sourcing · Marketing · No project`. `03` |
| 4 | Edit three cards, setting the modal's **Project** select | **PASS** — chip counts become `Data Sourcing 2`, `Marketing 1`; all four cards still visible under `All projects`. `04` |
| 5 | Click the `Data Sourcing` chip | **PASS** — board shows exactly the 2 objectives with that `project_id`; header counter reads `2 of 4`. `05` |
| 6 | Reload the page | **PASS** — still filtered to `Data Sourcing`, same 2 cards. `06` |
| 7 | Switch the organization to Example Project | **PASS** — selection resets to `All projects`, the project list is empty (Example's folders are not offered), and only the 1 Example Project card shows. `07` |
| 8 | Switch back to Example | **PASS** — Example's own stored selection is restored: `Data Sourcing`, 2 cards. `08` |
| 9 | Click `New` to open the objective modal | **PASS** — exactly four labels: `Title`, `Description / Instructions`, `Organization`, `Project`; **Project** is pre-filled with the open folder `Data Sourcing`. No repo-link control, no `Advanced`. `09` |
| 10 | Click the pencil, rename to `Data Sourcing (US)` | **PASS** — chip relabels in place, filter and cards unchanged. `10` |
| 11 | Click the trash | **PASS** — confirmation reads *"2 objectives in this project will be kept and moved back to 'No project'. Nothing is deleted except the folder itself."* `11` |
| 12 | Confirm the delete | **PASS** — folder gone, selection falls back to `All projects`, and **all four objectives are still on the board** (nothing orphaned or deleted). `12` |

## Screenshots (full viewport)

| File | Caption |
|---|---|
| `01-example-board-no-projects-yet.png` | The Project row on an organization with no folders yet |
| `02-created-and-opened-data-sourcing.png` | `Data Sourcing` created inline and opened |
| `03-two-projects-all-selected.png` | Two folders, `All projects` selected |
| `04-all-projects-four-cards.png` | Counts on the chips after assigning objectives |
| `05-filtered-to-data-sourcing.png` | Board filtered to one folder — `2 of 4` |
| `06-after-refresh-still-data-sourcing.png` | Selection survives a page reload |
| `07-example-project-resets-to-all-projects.png` | Switching organization resets to `All projects` |
| `08-back-on-example-remembers-data-sourcing.png` | Returning to Example restores its folder |
| `09-modal-four-fields-project-preselected.png` | The modal: four fields, Project = the open folder |
| `10-renamed-to-data-sourcing-us.png` | Rename from the picker |
| `11-delete-confirm-states-objectives-are-kept.png` | Delete confirmation states what happens to the objectives |
| `12-after-delete-back-to-all-projects-objectives-kept.png` | After delete — folder gone, all four objectives kept |

## Notes

- The board component under test is `app/client/src/preview/PreviewBoard.tsx` — the
  component actually routed at `/` and `/w/:ws` in `App.tsx`. The same wiring was
  applied to `components/KanbanBoard.tsx`, which is currently unrouted.
- Organizations were switched by navigating to the bookmarkable `/w/<slug>` route
  rather than the header dropdown, which multi-*selects* rather than swaps.
