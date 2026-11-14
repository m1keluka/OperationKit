# ARTIFACT — obj 900799: Product polish audit

**Deliverable:** an audit of current private main and the live OVH build, written up against the
reference products (Claude, ChatGPT, Grok, GitHub), with a prioritised follow-up list, 9 filed
cards, and a few tiny copy fixes. **No visual redesign. Not merged, not deployed.**

| What | Where |
|---|---|
| Audit write-up (vault/PR-ready) | `docs/audits/2026-11-13-product-polish/README.md` |
| Screenshots, light + dark (40 PNGs) | `docs/audits/2026-11-13-product-polish/shots/`: 17 pages × 2 themes at 1440×900 + login + Board/Secrets at 390×844 |
| Branch | `cc/obj-900799-product-polish-audit-make-the-app-feel-l` |
| PR | https://github.com/your-org/operationkit/pull/759 (open, not merged) |
| Follow-up cards | #900802 – #900810 (operationkit, operationkit, model claude-opus-5-5, create_pr=1, status `queue`, none started) |

## Evidence per requirement

**1. Audit of current main and live OVH, with the delta noted.**
- Main `acbb7ee3`. Booted as a scratch server (`[startup] SCRATCH instance …` logged, temp DB,
  port 3912) and screenshotted with Playwright.
- Live: `GET http://localhost:3002/api/health` → `{"status":"ok","commit":"f0291dca0498"}`. GitHub
  commit search resolves that hash to **m1keluka/OperationKit**
  `chore: sync from upstream (gated) (#84)`, 2026-11-13T19:35Z, whose PR body says it was
  "Triggered by merged upstream PR **#751**".
- Delta live → main: `git log` after `f1b88687` (#751) shows **#753, #754, #752, #755**.
- Checked in the live bundle `/assets/index-CwMEJ7pf.js`: it still contains `"All Organizations"`
  and `"Organization for the new project"`, and has 0 matches for "All workspaces". Main's build has
  "All workspaces" and 0 "All Organizations".
- Correction to the card: #747 and #749 predate #751, so they are in the live sync.
- Logged-in live pages were not screenshotted (no session cookie available to a card). The live
  login was checked over HTTP, and the live UI through its JS bundle.

**2. Screenshots or precise page-by-page notes, light and dark.**
The README has §6 page-by-page notes (global chrome, Board, Bots, Context, Workflows, Agents, System,
Settings ×7, Login, plus dark-mode and white-label roll-ups). Each cites `file:line` and links the
matching `shots/NN-<page>-<light|dark>.png`.

**3. Prioritised, cut-ready follow-up list (P0/P1/P2, effort, surfaces).**
README §7 gives the table with priority, effort, surfaces and dependency order, and §5 gives the
measured baseline:
- 20 font sizes (13 arbitrary)
- 10 letter-spacings
- ~75 raw buttons on the Board
- 15+ input styles
- 45 raw hex

| # | Pri | Card | Effort |
|---|---|---|---|
| F1 | P0 | #900802 Design foundations (type scale, eyebrow, control heights, class merge, icon stroke) | M |
| F2 | P0 | #900803 White-label leaks (server prompts/PR text, email accent, accent flash, seeded workspaces, doc links) | M |
| F3 | P0 | #900804 Dark-mode holes in React Flow / Mermaid / BlockNote / badges / changelog | S–M |
| F4 | P1 | #900805 Board + card viewer onto primitives (after F1) | M |
| F5 | P1 | #900806 Settings, Secrets, sign-in onto form primitives (after F1) | M–L |
| F6 | P1 | #900807 Page shell + hierarchy: stable header, one primary per view, flatter tabs (after F1) | M |
| F7 | P1 | #900808 Plain language + formatting + glossary | M |
| F8 | P1 | #900809 Loading / empty / error states (after F1) | M |
| F9 | P2 | #900810 One icon set + dead-code cleanup (after F1) | S–M |

**4. Cards filed on the operationkit board, without duplicating existing work.**
- `POST /api/internal/objectives` → `201 {"created":9, … "started":0, "deduped":0}`, ids
  900802–900810.
- Re-read: each card is `queue`, `operationkit`, `operationkit`, `claude-opus-5-5`,
  `create_pr=1`, with 3–5 acceptance criteria.
- Not duplicated:
  - #900798 Bots sidebar and #900797 bot workspace access are explicitly excluded in every card.
  - #900745, #900621, #900494 and #900750 are cited as already done.
- **Gap: owner_bot.** The internal bulk-create route does not accept `owner_bot`
  (`ACCEPTED_ITEM_KEYS` in `routes/internal-create.ts`), and a card session token is refused by
  `POST /api/objectives` (401). So `owner_bot` is unset on the 9 cards, and each description states
  "owner_bot: Operation Kit". Fix: set it in the card UI, or whitelist `owner_bot` on the internal
  route.

**5. Tiny uncontroversial fixes, PR only.** These are copy and attribute changes only (README §8):
- Status labels "Planning" and "AI review"
- "Sign in" and autocomplete hints on login
- Two stale settings paths
- "Example" removed from the OAuth wizard copy
- A neutral owner-bot placeholder

Test output:
- `cd app/client && npx vitest run` → `Test Files 107 passed (107)`, `Tests 676 passed (676)`.
- `npx tsc -b` → exit 0.

**Constraints respected:**
- No merge, no deploy, and no restart of the live server. The scratch server ran on port 3912 under
  `CC_SCRATCH_SERVER=1` and was stopped by its own PID.
- PR 645 and Shared secrets were not touched.
- No visual rewrite.
