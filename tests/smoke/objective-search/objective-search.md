# Smoke evidence — Board objective search UI (obj 702389)

| | |
|---|---|
| **Objective** | 702389 — Board objective search UI (keyword+fuzzy + AI mode) |
| **PR** | #229 (`feat/board-search-702389`) |
| **Date** | 2026-07-16 |
| **Surface** | Client `KanbanBoard` → `ObjectiveSearchPanel` → `ObjectiveModal` |
| **Driver** | headless Chromium (`playwright-core` + `chrome-headless-shell`), viewport 1280×850 |
| **Backend under test** | **Contract mock** (`_mock-server.cjs`) serving the built SPA + the exact `/api/objectives/search` and `/api/objectives/search/ai` response shapes from `app/server/src/routes/objectives-search.ts`, driven by `_driver.cjs`. |

## Why a contract mock, not the live board

The consumed backend (obj **702388**) is **not on `origin/main` and not in git** — it exists only as
uncommitted working-tree edits in the live checkout (`index.ts` modified + untracked
`routes/objectives-search.ts` / `.test.ts`), and the **running server 404s** on the route (an
authenticated `GET /api/objectives/search` falls through to `/:id` → `{"error":"Objective not found"}`
because the router was never mounted on the running process). So an end-to-end run against the real
deployed board is impossible until obj 702388 lands on main + the server restarts.

Every acceptance criterion here is **frontend behavior given the documented contract**, so a mock that
returns the exact contract shapes (including a DONE row, ranked AI rows with reasons, and a 502) is a
faithful verification of *this* deliverable. The mock exists only to drive the UI — it asserts nothing
about backend writes. To reproduce: `node _mock-server.cjs` (serves on :4599 from the built `dist/`),
then `node _driver.cjs`.

## Steps / Results

| # | Step | Expected | Result |
|---|------|----------|--------|
| 1 | Load board | Header shows a **Search** affordance (button + `/` hint) | ✅ PASS (01) |
| 2 | Click Search / press `/` | Search panel opens, Keyword mode, input focused | ✅ PASS (02) |
| 3 | Type `board` (keyword) | Results across **multiple stages** (Working, Done, Needs You), each with a status badge | ✅ PASS (03) |
| 4 | Type `portal` (keyword) | A **DONE** objective is returned with a green **Done** badge + snippet | ✅ PASS (04) |
| 5 | AI mode → query → Enter | **Ranked results each with a per-result reason** line | ✅ PASS (05) |
| 6 | AI query that 502s | Graceful message **"AI search unavailable (API key not configured)"** | ✅ PASS (06) |
| 7 | Click a DONE result | Opens the existing **ObjectiveModal** for that objective (title + description hydrated) | ✅ PASS (07) |
| 8 | Modal footer (DONE obj) | **Re-Open** button present (Delete · Re-Open · Cancel · Update); wired to `handleChangeStatus(id,'queue')` per `VALID_TRANSITIONS` | ✅ PASS (08) |

## Screenshot manifest

- `01-board-with-search.png` — board with the header Search button (`⌘ Search /`).
- `02-panel-open.png` — search panel open, Keyword/AI toggle.
- `03-keyword-results-all-stages.png` — `board` → Working + Done + Needs You rows, each badged.
- `04-keyword-finds-done.png` — `portal` → DONE "Client portal lockout + dispute flow" with Done badge + snippet.
- `05-ai-ranked-reasons.png` — AI mode, three ranked DONE results each with a reason line.
- `06-ai-502-graceful.png` — AI 502 → graceful "API key not configured" message.
- `07-click-opens-modal.png` — clicking the DONE result opens ObjectiveModal (title/description populated).
- `08-modal-reopen-button.png` — modal footer for the DONE objective: Delete · **Re-Open** · Cancel · Update.
