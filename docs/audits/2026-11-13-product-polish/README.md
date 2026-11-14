# Product polish audit — 2026-11-13 (obj 900799)

**Ask (Operator, Nov 13):** the app still feels scrappy and vibe-coded. Make it feel like a top AI-lab
product (Claude, ChatGPT, Grok, GitHub), without cloning any one of them. Consistent spacing and type,
one accent color, clean light and dark modes, and white-label friendly.

**This is an audit, not a redesign.** It covers what is wrong, where, and in what order to fix it.
The PR that carries it only has a few one-line copy fixes (§8). The follow-up work is filed as
9 cards (§7).

---

## 1. The short version

The **color system is in good shape** after #751 (obj 900750). Every color is a CSS token. There
are no stray Tailwind palette classes, no `dark:` variants, and one configurable accent. Light and
dark both look intentional on the main pages.

What still reads as "vibe-coded" is everything **above** the color tokens:

1. **No type scale.** 20 different font sizes are in use, 13 of them arbitrary pixel values
   (`text-[12px]` ×650, `text-[12.5px]` ×135, `text-[13.5px]` ×21 …), plus 10 different letter-spacings
   on uppercase labels.
2. **The primitives exist but most screens don't use them.** `ui/Button` exists, yet the Board,
   Archive, objective modal, Secrets, Planning panel and auth screens use about 75+ hand-built
   `<button>`s in 5+ sizes and 2 radii. There is no `Input`/`Select`/`Textarea` primitive, so there
   are 15+ input styles, and native OS `<select>`s show up in Settings.
3. **Engineering vocabulary is visible to users:** raw ids, `ai_review`, "AI Rev", cron strings,
   `settings.flows_enabled = 1`, `(create_workflow)`, `frontmatter-layer-graph`, ISO/UTC timestamps,
   `HTTP 500`, monospace stats everywhere on System.
4. **Icons come from four sources** (lucide, copied Heroicons, inline SVG, emoji ⚙️📄🔧🧠 and unicode
   ▸ × ★ ●) at mixed stroke widths.
5. **The page shell is inconsistent.** The header search jumps about 110px sideways depending on whether
   the page shows the workspace switcher. Content width changes between Settings tabs. Some pages
   have two primary buttons. Tab groups are nested 2–3 deep.
6. **White-label leaks are mostly server-side now.** These include "Operator"/"Command Center" in agent
   prompts and PR bodies, an email accent that ignores the Branding panel, an accent flash on load,
   doc links to a personal GitHub repo, and the author's own workspaces seeded into a fresh DB.

None of this needs a visual redesign. It needs one design-foundations pass, then adoption sweeps.

## 2. Scope and method

| | |
|---|---|
| **Current private main** | `acbb7ee3` (operationkit). Booted as a scratch server (`CC_SCRATCH_SERVER=1`, temp DB, sample cards) and captured at 1440×900 in light and dark, plus 390×844 for Board and Secrets. 40 screenshots in [`shots/`](./shots/). |
| **Live OVH** | `GET /api/health` → `commit f0291dca0498`. That is **m1keluka/OperationKit** PR #84, *"sync from upstream (gated)"*, triggered by private PR **#751** (19:35 UTC Nov 13). |
| **Delta live → main** | **#752** (Organization→Workspace labels), **#753** (owner's first message), **#754** (CI speed), **#755** (card browser lockdown). Verified in the live bundle: `/assets/index-CwMEJ7pf.js` still contains "All Organizations" and "Organization for the new project", and has no "All workspaces". Main's build has "All workspaces" and no "All Organizations". #747 and #749 predate #751, so they are **in** the live sync (the card guessed they were not). Of the delta, only #752 is user-visible. |
| **Code sweep** | All 169 non-test `.tsx` files in `app/client/src`, plus server branding, prompts, email and seeds. Done as three parallel read-only passes (Board/shell · Context/Workflows/Agents/Bots · Settings/System/auth/white-label), then checked against the screenshots. |
| **Not covered** | The Bots **sidebar** (owned by #900798) and per-bot workspace access (#900797). Logged-in screenshots of live OVH: no session cookie is available to this card, so the live login screen was checked over HTTP and the rest of the live app through its JS bundle. |

## 3. What is already good (keep it)

- **Tokens:** `tailwind.config.ts` routes every color through `color-mix(var(--x))`, so `/10`-style
  opacity works in both themes. The only brand color is `accent`, settable per install
  (`OK_BRAND_ACCENT`, `config/branding.json`, Settings → Branding). Guard tests exist:
  `no-hardcoded-colors`, `no-hardcoded-brand`, `no-sub-12px-text`.
- **Theme plumbing:** one store (`lib/theme.ts`), `data-theme` applied before paint, OS-follow, and
  meta `theme-color`.
- **Primitives worth standardising on:** `ui/Button` (4 variants, loading state, 44px mobile
  targets), `IconButton`, `Badge`, `EmptyState`, `Skeleton`, `Tabs`, `Modal`, `PageHeader`,
  `PageContainer`, `DataTable`, `Alert` (41 uses), `ConfirmDialog`.
- **Best-in-class surfaces today:** the Bots chat page (skeletons, empty state with prompts, 760px
  reading width), the session-viewer header, System (`PageHeader` + `Alert` + `Skeleton`), and
  `RouteFallback`.
- **Organization → Workspace** rename is complete on main (#752). The only leftovers are
  GitHub-org copy and internal keys, which are fine.

## 4. What the reference products do that we don't

These are the principles behind the follow-ups. They describe a level of polish, not a look to copy.

| Principle | Claude / ChatGPT / Grok / GitHub | Us today |
|---|---|---|
| **One type ramp** | 5–6 sizes (≈12/14/16/20/24/32), 2 weights | 20 sizes, half-pixel steps |
| **One control height scale** | buttons, inputs and selects share 28/32/40px | 24–44px, mixed per screen |
| **Accent is rare** | at most one filled primary per view; links and focus carry the brand | 2 primaries stacked on Workflows, Integrations and Setup; accent text used for errors |
| **Plain language** | no ids, enums or config keys in the UI; relative times with an absolute tooltip | ids, enums, cron, config keys, ISO/UTC |
| **Sentence case everywhere** | "Sign in", "New integration" | "Sign In", "New Integration", "Skill Graph", "Queued Sessions" |
| **One icon set, one stroke** | a single icon family | lucide + Heroicons + inline SVG + emoji + unicode |
| **Stable chrome** | the header never reflows between pages | the search jumps when the workspace switcher hides |
| **Calm empty/loading states** | skeletons in place, one CTA per empty state | "Loading..." text, bare "No data", raw errors |
| **Monospace only for code** | | used for stats, timestamps, counts, prose labels |

## 5. System-level measurements (main `acbb7ee3`, non-test client code)

| Metric | Count | Target |
|---|---|---|
| Distinct font sizes | **20** (`text-xs/sm/base/lg/xl/2xl/3xl` + 13 arbitrary) | 6 tokens |
| `text-[12px]` / `[13px]` / `[12.5px]` / `[15px]` / `[14px]` / `[13.5px]` | 650 / 164 / 135 / 36 / 33 / 21 | 0 arbitrary |
| Uppercase-label letter-spacings | 10 (`tracking-[0.06em]` ×54, `wider` ×39, `[0.08em]`, `[0.12em]`, …); ~25 elements carry **two conflicting** tracking classes | 1 `Eyebrow` |
| Half-step paddings (`*-x.5`) | 610 | allowed, but from the scale |
| Radii | `md` 300, bare `rounded` 101, `lg` 91, `sm` 31, `xl` 4, `2xl` 3; plus 10px/14px in `preview.css` | 3 (control / card / modal) |
| Raw `<button>` in Board scope | ~75, vs ~15 `<Button>`/`<IconButton>` (all in `session-viewer/`) | primitives |
| Input class strings | 15+ (no `Input`/`Select`/`Textarea` primitive) | 1 field style |
| Raw hex in client TS/TSX | 45, mostly `jobs/FlowCanvas.tsx` (16) and `FlowDiagram.tsx` (9); plus fixed pastel fills in `shared/flow/mermaid.ts` | tokens |
| Inline `style={{…}}` | 51 | layout only |
| `font-medium` / `font-semibold` / `font-normal` / `font-bold` | 309 / 202 / 14 / 1 | 2 weights |

`cn()` (`ui/cn.ts`) is a plain join with no class merging. So a `className` that overrides a primitive
(`text-xs py-1` against a base `text-[13px] py-1.5`) wins or loses by CSS order, not by intent. That
is part of why overrides look random.

## 6. Page-by-page notes (light + dark)

Screens: `shots/NN-<page>-<light|dark>.png` (1440×900), `shots/m-*` (390×844).

### Global chrome (header + nav)
- The header search is centred only when the workspace switcher shows. On Bots, System and Settings
  the switcher hides, and **"Jump to page…" moves from x≈702 to x≈813** (compare `01-board` and `12-settings-secrets`).
- There are two searches with two shortcuts: "Jump to page… ⌘K" in the header, and "Search cards /"
  on the board. The board also has "Filter this library…" plus "Search /" on Archive. ⌘K is shown on
  Windows too.
- The lowercase username "operator" plus a lowercase "admin" pill in the review color reads as debug
  output (`Layout.tsx:371,422`).
- The command palette shows URL paths as hints and lists "Settings" twice (`CommandPalette.tsx:88`,
  `Layout.tsx:241-256`).
- On mobile (`m-board-*`), the board header takes 3 rows (~140px) before the first card. Theme
  toggle and avatar are 28px tap targets.

### Board (`01-board`, `02-archive`, `03-card`)
- Column labels "PLAN" and "AI REV" were jargon. **Fixed in this PR** to "Planning" and "AI review".
- Every card shows a monospace "GN" agent glyph and a monospace "1m" age. The workspace chip is the
  raw slug ("example", "example-project"), while Archive shows upper-case short labels ("EXAMPLE", "WS") for
  the same thing.
- At 1440px the fifth column is clipped mid-card with no scroll affordance. Columns are 14px-radius
  boxes that run to the bottom of the viewport even when empty, with no empty-column state.
- Card actions (Start / Done / Approve / Rework / Skip planning) are hand-built buttons about 26px
  high. The same actions in the card viewer are `Button sm` (32px), with different labels
  ("Re-open" vs "Re-Open", "Approve" vs "Done").
- Header buttons: Search, Archive and Workflow are hand-built (~34px), and "+ New" has no border, so
  it sits 2px shorter.
- The card viewer has a "SUB-OBJECTIVES" eyebrow with a monospace "0" under it. "Design / Brief /
  Flag mistake" are bare text buttons. The composer placeholder "Send follow-up to start new
  session…" is internal wording. The raw session id shows under the title.
- Not found / error states are bare text plus a link ("Objective not found"), with no
  `EmptyState`.
- Tool calls in the transcript use emoji icons (⚙️📄✏️🔍🔧ℹ️🧠, `SessionMessages.tsx:211-239`).
- Dead code that looks live: `KanbanBoard`, `KanbanColumn`, `ObjectiveCard`, `StatusGlyph`,
  `InputComposer`, `board.css`, and the unused `.cc-ws-topbar`/`.cc-ws-mark` in `preview.css`. The
  real board is `preview/*`.

### Bots (`04-bots`)
- This is the cleanest page. The sidebar is out of scope (#900798). Chat icons are copied Heroicons
  rather than lucide. The composer is three separate bordered pieces where Claude/ChatGPT use one
  container. The header shows the raw model id ("claude-sonnet-…"), and five text buttons sit in a
  row.

### Context / Knowledge (`05-knowledge`, `06-knowledge-setup`)
- The page title "Context" is 15px in the sidebar. Other pages use `PageHeader` at 20–24px.
- The toolbar "Save" is hand-built (~24px, `rounded-sm`) next to `Button sm` (32px, `rounded-md`).
- **`<BlockNoteView theme="dark">` is hardcoded** (`DocsPage.tsx:231`). Light mode works only because
  CSS remaps it, and dark-tuned menu shadows leak into light.
- "Loading file…" is plain text. Import shows raw `HTTP 500`. Naming drifts between Context,
  knowledge base, notes, Wiki and pages.

### Workflows (`07-workflows`)
- There are **two filled primary buttons** ("New strategy job" in the header, "New workflow" in the
  section). The main action on a page titled Workflows is "New strategy job".
- The breadcrumb root is the product name, in monospace ("Operation Kit / Workflows"). Two stacked
  segmented controls (Workflows|Runs, then All|Example). A "WORKFLOWS 0" eyebrow repeats the title.
- The empty state copy ends in "(create_workflow)". The Run-now tooltip says
  "settings.flows_enabled = 1". Triggers show raw cron ("schedule · 0 9 * * 1"), and statuses are raw
  lowercase enums in monospace.
- **Dark-mode hole:** the flow canvas uses React Flow light defaults (white controls and minimap), has
  16 hex + 10 rgba legend colors, and shows a visible "React Flow" attribution. The Mermaid view uses
  fixed pastel fills, giving near-white text on pastel boxes in dark.

### Agents & Skills (`08-agents`)
- A large, non-dismissible "Make a new bot, agent or skill" panel sits above everything on every
  visit.
- **Three nested tab groups in three different styles** (Registry|Board layer|Templates →
  Roster|Assignments|Skill Graph → Agents (8)|Skills (0) as underline tabs).
- "Board layer" is an engineering term, `frontmatter-layer-graph` shows as a badge, and project
  options read "{id} · {name}".
- The page needs a glossary to explain Bot vs Agent vs Skill. That is a naming problem, not a copy
  problem.

### System (`09-system`)
- Good structure. **Monospace is overused:** stat values, units, "2026-11-13 · Eastern", the
  container id, the kernel string and an "auto-refresh · 5s" pill. The timezone is fixed to
  `America/New_York`, and accounts are labelled "A/B/C/D".
- "Settings > Models" uses `>` where the rest of the app uses "→". Link hover colors are inverted.

### Settings (`10`–`16`)
- **The width jumps between tabs:** Models/API & MCP/Integrations are capped at ~790–920px, while
  Secrets/Workspaces/Branding are full width.
- Section headers come in 14 styles. Redundant eyebrows: "SETTINGS · BRANDING", "MANAGE /
  Workspaces", "MCP · SCOPED TOOL CONNECTION FOR ONE BOT".
- **Native OS `<select>`** for "All scopes" (Secrets) and the workspace picker (Integrations) is a
  different height from the inputs next to it. Checkboxes are browser defaults.
- Secrets has no `<Button>` at all: "+ New" uses a text plus sign, row actions are colored text
  links, and the empty state says "Click "New"".
- Integrations has two "New Integration" primaries (Title Case) and a left-aligned empty state in a
  narrow column.
- Workspaces has five outlined red "Remove" buttons stacked down the page. GitHub puts destructive
  actions behind a menu or in a Danger zone. Slugs show in mono chips.
- Branding: "Reset to default" sits next to Save with no confirmation and wipes name and tokens.
- API & MCP is a wall of explanatory text. The doc links point to `github.com/m1keluka/OperationKit`
  even on white-labelled installs.
- Every tab has a "Build unknown" footer.

### Login / first run (`00-login`)
- "Sign In" was Title Case, placeholders repeated the labels in lowercase, and autocomplete hints
  were missing. **Case and autocomplete fixed in this PR.**
- First load runs board skeleton → bare "Loading..." text → login card. Even a logged-out visitor
  sees a fake board first (`index.html:96-120`, `App.tsx:159-165`).
- `--accent` paints the default Ultramarine until `/api/branding` answers, so **a re-branded login
  button flashes the wrong color** (`branding.ts` injects only the title and favicon).

### Dark mode, overall
Main pages are clean in dark. The holes are concentrated in third-party widgets (React Flow, Mermaid
fills, BlockNote), the meeting-queue badge (`bg-signal-alarm text-fg-0` gives navy text on red in
light), the DiskLow banner using fill tokens for text, and the public changelog page (hardcoded
`#2563eb`, no dark mode).

### White-label, overall
The client is nearly clean: a guard test exists, and "Example" in the OAuth wizard is **fixed in this
PR**. The remaining leaks are on the server:
- Agent prompts and PR/gate comments say "Operator" and "Command Center" (`prompt-builder.ts`,
  `session-planner-prompt.ts`, `ci-green-gate-decide.ts`).
- The email accent reads only `OK_BRAND_ACCENT` and ignores the Branding panel.
- CORS, preview URL and `HARNESS_REPO` default to Example values. The Assistant nudge is on by default.
- `db/schema/workspaces.ts` seeds Example / Example Project / **Operator / Example Five / Example3**
  into every fresh DB, with `/home/operator` vault paths and old palette badge classes. The public sync
  may strip this, but private main ships it.
- `JobsBoard.tsx:691` falls back to the `'operator'` workspace, and `SessionMessages.tsx:200`
  hardcodes `/home/operator/…`.
- No web manifest or apple-touch icon is served.

## 7. Prioritised follow-ups (filed as cards)

Order matters. **F1 (foundations) goes first**, because every later card draws on its tokens and
primitives. F2–F9 touch different surfaces and can run in parallel once F1 merges. Each is PR-only,
on `operationkit`, in the operationkit workspace.

| # | Pri | Card | Surfaces | Effort | Depends on |
|---|---|---|---|---|---|
| F1 | **P0** | **#900802** Design foundations: type scale, eyebrow, control heights, class merge, icon defaults | all (tokens + `ui/`) | M | — |
| F2 | **P0** | **#900803** White-label leaks (server prompts/PR text, email accent, accent flash, seeded workspaces, doc links, fallbacks, guard test) | server + Settings + login | M | — |
| F3 | **P0** | **#900804** Dark mode holes in third-party widgets (React Flow, Mermaid fills, BlockNote, badges, changelog) | Workflows, Context, header, public changelog | S–M | — |
| F4 | P1 | **#900805** Board + card viewer onto primitives (buttons, inputs, tabs, icon buttons, labels, alignment, radii) | Board, Archive, card viewer, objective modal, filters | M | F1 |
| F5 | P1 | **#900806** Settings, Secrets and auth onto primitives (`Field`/`Input`/`Select`, `DataTable`, `Alert`, one width, one section header, destructive actions) | Settings ×7, Secrets, Test creds, Login, Change password, Setup | M–L | F1 |
| F6 | P1 | **#900807** Page shell + hierarchy (stable header, `PageHeader` everywhere, one primary per view, flatten nested tabs, breadcrumb rule, mobile board header) | header, Workflows, Agents, Context, Integrations, Setup | M | F1 |
| F7 | P1 | **#900808** Plain language + formatting (no ids/enums/config keys/cron/ISO/HTTP codes; sentence case; glossary; shared format helpers; less monospace) | all, esp. Workflows, System, Agents, Secrets | M | — |
| F8 | P1 | **#900809** Loading, empty and error states (first-load sequence, skeletons, `EmptyState`, friendly error boundary per route) | first load, Board, Context, Workflows, card viewer | M | F1 |
| F9 | P2 | **#900810** One icon set + dead-code cleanup (lucide only, no emoji/unicode icons, one stroke; delete the dead Kanban files) | all | S–M | F1 |

**Deliberately not filed:**
- The Bots sidebar (#900798, already in flight).
- Per-bot workspace access UI (#900797).
- A full restyle.
- A brand-color change. Ultramarine stays the default accent; F1/F6 make it *rarer*, not different.

**Note on owner bot:** the internal bulk-create route (`POST /api/internal/objectives`) does not accept `owner_bot`, and this session cannot call the Agent API. So the 9 cards were filed with owner_bot unset; each card says "owner_bot: Operation Kit" in its description. Setting the field is a one-click edit per card, or a follow-up to whitelist `owner_bot` on that route.

**Open question for Operator, no card yet:** should the filled primary button use the accent (as now) or
a neutral near-black/near-white, with the accent kept for links, focus and selection (the
ChatGPT/Claude/GitHub pattern)? Either works with the token system. It is a single token change in
F1 if he wants it.

## 8. Tiny fixes shipped in this PR

All copy and attributes, no layout or behaviour change:

| File | Change |
|---|---|
| `components/design/primitives.tsx` | Status labels "Plan" → "Planning", "AI Rev" → "AI review" (board columns and card status) |
| `components/LoginPage.tsx` | "Sign In" → "Sign in", "Signing in..." → "Signing in…", `autoComplete="username"` / `"current-password"` |
| `components/SecretsPage.tsx` | Stale path "Settings → You" → "Settings → Secrets → Mine" |
| `components/NoAccountPage.tsx` | Stale path "Settings → Users" → "Settings → Workspaces → Users" |
| `components/connectors/GuidedOAuthWizard.tsx`, `oauthWizardSteps.ts` | White-label: "shared Example app" → "shared OAuth app" |
| `components/ObjectiveModal.tsx` | Placeholder "e.g. Grok: Research" → "e.g. Research bot" |

Verified with `npx vitest run` (client): 107 files / 676 tests passed. `npx tsc -b` (client) exit 0.
