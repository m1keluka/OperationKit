# Planning Step + Objective Type Classification — Design

Companion to `UNIFIED-TASK-ARCHITECTURE.md`. Specifies how the Command Center board grows from a single "queue → working → review → done" lane into a type-aware workflow with an optional planning stage in front of execution.

Status: **DESIGN — awaiting Mike's approval before implementation.**

---

## 1. Problem & End State

### Current behaviour

Every objective in CC moves through one path: `queue → working → review → done`. The same gating applies whether the work is a one-line label fix, a database migration, or a multi-week PRD-sized feature. Two consequences:

- **Heavy work skips planning.** A "design + ship the new contacts panel" objective gets the same zero-up-front planning as a typo fix — the working session has to do all its Discover/Design/Plan inside the same turn, often badly.
- **Light work over-pays for review.** A 30-second config bump still demands a manual human review pass before it lands in done. Mike ends up bottlenecked clearing review for trivial work.

### End state

Every objective is tagged with a **type** chosen at creation (`project`, `bug`, `task`). Type drives the workflow:

| Type | Workflow | Purpose |
|------|----------|---------|
| **Project** | `planning → queue → working → ai_review → human_review → done` | Substantive feature work. Full QA, mandatory human sign-off. |
| **Bug** | `queue → working → ai_review → done` | Targeted fixes. AI-reviewed for correctness; Mike trusts the verdict. |
| **Task** | `queue → working → done` | Light ops/admin/config work. No review gates. |

The **planning stage** is a guided Q&A between Mike and a planner sub-session that produces a written plan. The approved plan is stored on the objective and prepended to the working session's prompt, so the executor starts with shared context instead of re-discovering everything.

Acceptance criteria (drives every implementation step below):

1. Objectives table carries a `type` column with values `project | bug | task`, defaulting to `task` for existing rows and per-category for new ones.
2. The kanban has a **Planning** column to the left of Queue. Only `project`-type objectives in `status='planning'` appear there.
3. From a `planning`-status objective, Mike can open a chat panel and converse with a planner agent. The planner produces a markdown plan; Mike approves or revises. On approval, the objective moves to `queue` with `approved_plan` populated.
4. Working sessions for `project` objectives receive the approved plan as part of their spawn prompt.
5. When a `project` working session completes, status auto-advances to `ai_review`, which triggers a reviewer sub-session. Verdict `pass` auto-advances to `human_review`; verdict `fail` reverts to `working` with reviewer findings prepended to the next prompt.
6. `bug` objectives skip `human_review` — `ai_review` pass auto-advances straight to `done`.
7. `task` objectives skip both reviews — `working` completion advances straight to `done`.
8. Type, planning state, and review verdicts are visible on the kanban card and in the modal.

---

## 2. Decisions Recorded

These are the recommended defaults. Each has alternatives evaluated below; Mike can override any before implementation.

| # | Decision | Choice | Reason |
|---|----------|--------|--------|
| D1 | AI Review mechanism | **Autonomous reviewer sub-session** | Cheap to spawn, isolated from executor bias, produces verdict + findings as structured data the workflow engine can act on without UI changes per case. |
| D2 | Planning agent identity | **Same `agent_context` as the objective** | The planner shares the same domain expertise the executor will need (CTO planner → CTO executor). No new agent role to maintain. The planner's prompt restricts it to Discover/Design/Plan phases. |
| D3 | Planning UI surface | **New 'Planning' column + chat panel in modal** | Strong visual signal that planning is work-in-flight. Reuses the existing SessionViewer/MentorPage chat affordances. |
| D4 | Plan storage | **Markdown blob (`approved_plan`) + conversation log (`planning_conversations` table)** | Plans are narrative, not structured task lists — markdown stays human-readable and machine-injectable into prompts. Conversation log is for re-opening planning later. |
| D5 | Default type for existing rows | **All existing → `task`** | Lightest workflow path. Avoids forcing in-flight work back through new review gates. |
| D6 | Default type for new objectives | **By category** (`development → project`, `finance/legal → bug`, others → `task`) | Matches the actual nature of the work most categories produce. Mike still overrides per-objective. |
| D7 | Effort default by type | `project → high`, `bug → normal`, `task → normal` | Project work is more involved by definition. Mike overrides. |
| D8 | Status enum migration | **Replace `review` with `human_review`; add `planning` + `ai_review`** | One-shot CHECK-constraint rebuild (pattern already used for `agent_context`). Backfill: any current `review` row → `human_review`. |

### Alternatives considered (briefly)

- **AI Review as inline self-review by the same session** — rejected: same-model bias, no separate audit trail, can't run AI Review independently of the working session.
- **Dedicated 'planner' agent role** — rejected for v1: doubles the agent-prompt maintenance surface. Revisit only if domain-specific planners turn out to outperform role-shared planners.
- **Reuse Mentor threads for planning** — rejected: planning needs to be tied 1:1 to an objective and gate its workflow. Mentor threads are general-purpose and don't carry that contract.
- **Default existing rows to `project`** — rejected: would push every in-flight objective into both review gates, blocking work on the migration boundary.

---

## 3. Data Model Changes

### 3.1 `objectives` table — additive columns

```sql
ALTER TABLE objectives ADD COLUMN type TEXT NOT NULL DEFAULT 'task'
  CHECK(type IN ('project', 'bug', 'task'));

ALTER TABLE objectives ADD COLUMN approved_plan TEXT;          -- markdown blob, null until plan approved
ALTER TABLE objectives ADD COLUMN plan_approved_at TEXT;       -- iso8601, null until approved
ALTER TABLE objectives ADD COLUMN ai_review_verdict TEXT
  CHECK(ai_review_verdict IN ('pending', 'pass', 'fail', NULL));
ALTER TABLE objectives ADD COLUMN ai_review_findings TEXT;     -- markdown blob from reviewer
ALTER TABLE objectives ADD COLUMN ai_review_session_id TEXT;   -- reviewer sub-session id

CREATE INDEX IF NOT EXISTS idx_objectives_type ON objectives(type);
```

### 3.2 `objectives.status` enum migration

Existing CHECK constraint: `status IN ('queue', 'working', 'review', 'done')`.
New CHECK constraint: `status IN ('planning', 'queue', 'working', 'ai_review', 'human_review', 'done')`.

SQLite can't ALTER a CHECK constraint — we rebuild the table the same way the codebase already handles `agent_context` upgrades (`db/index.ts` lines 64–90). Migration order:

1. Detect old constraint by trying `INSERT … status='planning'` inside a transaction; on failure, rebuild.
2. `CREATE TABLE objectives_new AS SELECT * FROM objectives;` then `DROP` + recreate with new CHECK.
3. Reinsert from `objectives_new`, mapping `review → human_review`.
4. Recreate all indexes.

### 3.3 New table — `planning_conversations`

Stores the Q&A between Mike and the planner. One row per message. Reuses the same JSONL-backed transcript pattern as Mentor would be heavier; planning conversations are short (10–40 messages) so a relational table is simpler.

```sql
CREATE TABLE planning_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  session_id TEXT,                              -- planner sub-session id (Claude Code)
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  metadata TEXT,                                -- JSON: tool calls, citations, etc.
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_planning_objective ON planning_conversations(objective_id);
CREATE INDEX idx_planning_created ON planning_conversations(created_at);
```

### 3.4 Shared types — `shared/types.ts`

```typescript
export type ObjectiveType = 'project' | 'bug' | 'task'
export const OBJECTIVE_TYPES: ObjectiveType[] = ['project', 'bug', 'task']

export type ObjectiveStatus =
  | 'planning' | 'queue' | 'working' | 'ai_review' | 'human_review' | 'done'
export const OBJECTIVE_STATUSES: ObjectiveStatus[] =
  ['planning', 'queue', 'working', 'ai_review', 'human_review', 'done']

export type AIReviewVerdict = 'pending' | 'pass' | 'fail'

export interface Objective {
  // ... existing fields ...
  type: ObjectiveType
  approved_plan: string | null
  plan_approved_at: string | null
  ai_review_verdict: AIReviewVerdict | null
  ai_review_findings: string | null
  ai_review_session_id: string | null
}

export interface PlanningMessage {
  id: number
  objective_id: number
  session_id: string | null
  role: 'user' | 'assistant' | 'system'
  content: string
  metadata: Record<string, unknown> | null
  created_at: string
}
```

---

## 4. Workflow Routing Engine

Replace the static `VALID_TRANSITIONS` dict with a type-aware function.

```typescript
// shared/workflow.ts (new file)
import type { ObjectiveType, ObjectiveStatus } from './types.js'

const TRANSITIONS_BY_TYPE: Record<ObjectiveType, Record<ObjectiveStatus, ObjectiveStatus[]>> = {
  project: {
    planning:     ['queue'],                          // plan approved
    queue:        ['planning', 'working', 'done'],    // can revise plan, start work, or cancel
    working:      ['ai_review', 'done'],              // session completed or aborted
    ai_review:    ['working', 'human_review'],        // fail back to working, pass forward
    human_review: ['working', 'done'],                // pushback or sign-off
    done:         ['queue'],                          // reopen
  },
  bug: {
    planning:     [],                                 // bugs never enter planning
    queue:        ['working', 'done'],
    working:      ['ai_review', 'done'],
    ai_review:    ['working', 'done'],                // AI pass → done directly
    human_review: ['working', 'done'],                // unused but allowed for manual override
    done:         ['queue'],
  },
  task: {
    planning:     [],
    queue:        ['working', 'done'],
    working:      ['done'],                           // no reviews
    ai_review:    ['working', 'done'],                // unused but allowed for manual override
    human_review: ['working', 'done'],                // unused but allowed for manual override
    done:         ['queue'],
  },
}

export function isTransitionAllowed(
  type: ObjectiveType,
  from: ObjectiveStatus,
  to: ObjectiveStatus
): boolean {
  return TRANSITIONS_BY_TYPE[type][from]?.includes(to) ?? false
}

export function getInitialStatus(type: ObjectiveType): ObjectiveStatus {
  return type === 'project' ? 'planning' : 'queue'
}
```

`routes/objectives.ts` `PATCH /:id/status` swaps `VALID_TRANSITIONS[existing.status]` for `isTransitionAllowed(existing.type, existing.status, status)`.

### Auto-advance hooks

Added to the same status handler:

- `working → done` via session-intel detection: when `session-intel.ts` writes `outcome='success'` and `objective.type !== 'task'`, automatically PATCH the objective to `ai_review` instead of leaving it in `working` (status-poller already runs this loop).
- `ai_review` entry triggers `spawnReviewerSession(objectiveId)` (see §6).
- Reviewer verdict `pass` → if `type==='project'` advance to `human_review`, else advance to `done`.
- Reviewer verdict `fail` → reset to `working` with `ai_review_findings` injected into the next session prompt via `sendFollowUp(...)`.

---

## 5. Planning Stage

### 5.1 Lifecycle

```
[Mike creates project objective]
       │
       ▼
status='planning', planner sub-session starts (cold)
       │
       ▼
Planner posts opening message (read agent file, read context, ask 2-3 questions)
       │
       ▼─◄─┐
Mike answers│  (iterative chat — N rounds)
       │   │
       ├───┘
       ▼
Mike clicks 'Approve plan' → planner writes final plan markdown
       │
       ▼
approved_plan ← planner output
plan_approved_at ← now
status ← 'queue'
```

### 5.2 Planner session prompt

Spawned the same way as a working session (`session-manager.startSession`) but with:

- `prompt-builder.buildPrompt(...)` called with a new `mode: 'plan'` flag
- The agent file is loaded (CTO/CMO/etc.) BUT the prompt prepends a planning frame that:
  - Reads `~/ai-workspace/skills/pipeline/SKILL.md`'s Discover/Design/Plan phases
  - Forbids Execute-side tools: no `Write`, `Edit`, `Bash` against project files; only `Read`, `Glob`, `Grep`, `WebFetch`, `Agent` (for `Explore` subagent), and the planning chat I/O endpoint
  - Instructs the planner to research the codebase, ask Mike clarifying questions one-batch-at-a-time via the planning chat endpoint, and emit `<plan>` … `</plan>` markdown when Mike approves

Concretely, the planning frame is a new file at `~/ai-workspace/skills/cc-planner/SKILL.md`:

```markdown
# Skill: CC Planning Mode

You are running inside Command Center as a planner for an objective. Your job is to:
1. Read the objective + workspace + project context
2. Use Read / Glob / Grep / Explore agent to map the relevant code surface
3. Ask Mike clarifying questions in the planning chat
4. Iterate until Mike approves
5. Emit final plan as markdown inside <plan>…</plan> tags

You MAY NOT call Edit, Write, NotebookEdit, Bash (except for read-only commands
like `git log`, `ls`, `cat`), or any side-effecting MCP tool. Planning never
modifies repo state.

When Mike approves (signal: he posts "approve" or clicks the approve button),
emit your plan in this structure:

<plan>
# Plan: <objective title>

## Acceptance Criteria
- [ ] …
- [ ] …

## Implementation Steps
1. **<step>** — <which acceptance criteria this satisfies>
   - Files: …
   - Dependencies: …

## Risks & Open Questions
- …

## Effort
- Estimated session count: <n>
- QA intensity: <light | standard | rigorous>
</plan>
```

The server detects `<plan>…</plan>` in the planner's last assistant message and stages it as `approved_plan` when Mike clicks the approve button.

### 5.3 API endpoints

```
POST   /api/objectives/:id/planning/start
       → creates planner session if not already running; returns first planner message
       → requires objective.type === 'project' && objective.status === 'planning'

GET    /api/objectives/:id/planning/messages?after=N
       → incremental message poll (same pattern as /output)

POST   /api/objectives/:id/planning/message
       → posts Mike's reply; routes via sendFollowUp() to the planner session

POST   /api/objectives/:id/planning/approve
       → extracts the <plan>…</plan> block from latest assistant message
       → writes objective.approved_plan + plan_approved_at
       → transitions objective.status to 'queue'
       → stops planner sub-session

POST   /api/objectives/:id/planning/cancel
       → stops planner session, leaves status='planning' (Mike can re-open)
```

### 5.4 Working session inherits the plan

`prompt-builder.buildPrompt(objective, ...)`:

```typescript
if (objective.approved_plan) {
  prompt += `\n\n## Approved Plan\n\n${objective.approved_plan}\n\n` +
            `You are now in the Execute phase. Follow the plan above. ` +
            `If you discover the plan is wrong, STOP and report back to Mike instead of silently deviating.\n\n`
}
```

For `bug` and `task` objectives, `approved_plan` is null and this block is skipped — the prompt looks the same as today.

---

## 6. AI Review Sub-Session

### 6.1 When it fires

`status-poller` already tracks tmux session liveness. When a `project` or `bug` working session ends (tmux exits) AND `session-intel.outcome === 'success'`, the poller PATCHes the objective to `ai_review` instead of `review`. The status-change handler in `objectives.ts` sees the transition to `ai_review` and calls `spawnReviewerSession(objective)`.

### 6.2 Reviewer prompt

A new helper in `services/session-manager.ts`:

```typescript
export async function spawnReviewerSession(objective: Objective): Promise<string> {
  const sessionIntel = getLatestSessionIntel(objective.id)
  const filesTouched = sessionIntel.files_created.concat(sessionIntel.files_modified)

  const prompt = `
You are running as the AI reviewer for Command Center objective #${objective.id}.

## Objective
${objective.title}

${objective.description}

## Approved Plan
${objective.approved_plan ?? '(no plan — this is a Bug-type objective)'}

## Files touched
${filesTouched.join('\n')}

## Your task
Read the files touched. Compare against the plan's acceptance criteria.
Run any relevant test/lint/typecheck commands.
Produce a verdict block at the end:

<verdict>pass</verdict>
or
<verdict>fail</verdict>

<findings>
# Findings

- [PASS|FAIL] Acceptance criterion 1: …
- [PASS|FAIL] Acceptance criterion 2: …

## Issues
- …

## Recommendations (if fail)
- …
</findings>
`.trim()

  const sessionId = `cc-review-${objective.id}-${Date.now()}`
  // Spawn with the qa-reviewer skill loaded, restricted to read-only tools
  await startSessionWithPrompt({
    sessionId,
    prompt,
    workdir: WORKDIR_MAP[objective.agent_context],
    readOnly: true,                    // no Write/Edit/Bash side-effects
    skill: 'devops/qa-reviewer',
  })
  return sessionId
}
```

### 6.3 Verdict handling

A new branch in `state-poller.ts` watches for sessions matching `cc-review-*`:

```typescript
if (sessionId.startsWith('cc-review-')) {
  const transcript = getSessionOutput(sessionId)
  const verdict = extractVerdict(transcript)              // 'pass' | 'fail' | null
  const findings = extractFindings(transcript)
  const objectiveId = parseObjectiveIdFromSessionId(sessionId)

  db.prepare(`UPDATE objectives SET
    ai_review_verdict = ?,
    ai_review_findings = ?,
    ai_review_session_id = ?
    WHERE id = ?`).run(verdict, findings, sessionId, objectiveId)

  if (verdict === 'pass') {
    const obj = getObjective(objectiveId)
    const nextStatus = obj.type === 'project' ? 'human_review' : 'done'
    transitionStatus(objectiveId, nextStatus)
  } else if (verdict === 'fail') {
    // Send back to working with findings prepended
    const followUp = `## AI Review Findings\n\n${findings}\n\nPlease address these and continue.`
    sendFollowUp(objective.session_id, followUp, objective)
    transitionStatus(objectiveId, 'working')
  }
}
```

### 6.4 Cost containment

- Reviewer sessions use `claude-haiku-4-5` by default (cheap; only escalate to Sonnet via `effort='high'`).
- One reviewer attempt per `working→ai_review` transition. Repeated fails are surfaced to Mike — the workflow doesn't loop reviewer→working→reviewer infinitely.

---

## 7. UI Changes

### 7.1 Kanban board

`KanbanBoard.tsx`: column array becomes type-aware:

```typescript
const COLUMNS: { status: ObjectiveStatus; label: string; visibleFor: ObjectiveType[] }[] = [
  { status: 'planning',     label: 'Planning',     visibleFor: ['project'] },
  { status: 'queue',        label: 'Queue',        visibleFor: ['project', 'bug', 'task'] },
  { status: 'working',      label: 'Working',      visibleFor: ['project', 'bug', 'task'] },
  { status: 'ai_review',    label: 'AI Review',    visibleFor: ['project', 'bug'] },
  { status: 'human_review', label: 'Human Review', visibleFor: ['project'] },
  { status: 'done',         label: 'Done',         visibleFor: ['project', 'bug', 'task'] },
]
```

A column is rendered only if at least one currently-visible objective could legitimately reach that column. Empty `planning` / `ai_review` / `human_review` columns hide automatically when there are zero `project`/`bug` objectives in flight.

### 7.2 Type chip on cards

`ObjectiveCard.tsx`: add a chip beside the agent/effort badges:

```tsx
const TYPE_BADGES: Record<ObjectiveType, { label: string; cls: string }> = {
  project: { label: 'PROJECT', cls: 'bg-purple-500/20 text-purple-300' },
  bug:     { label: 'BUG',     cls: 'bg-red-500/20 text-red-300' },
  task:    { label: 'TASK',    cls: 'bg-gray-500/20 text-gray-300' },
}
```

For `project` cards in `planning`/`ai_review`/`human_review`, secondary status pill shows: "awaiting plan", "AI reviewing", "needs Mike". For `bug` cards in `ai_review`: "AI reviewing".

### 7.3 ObjectiveModal — type selector

`ObjectiveModal.tsx`: add a Type field (radio group of three) above the existing Agent/Category fields.

```
Type:  ◉ Task    ○ Bug    ○ Project
       Quick     Medium   Full plan + review
       ─────    ─────    ─────
```

Default selection is derived from category at the moment the user picks a category. Switching type after creation is allowed only when status is `queue` or `planning`.

### 7.4 Planning chat panel

New component `PlanningPanel.tsx` rendered inside `ObjectiveModal` when `objective.status === 'planning'`. Same chat UX as `SessionMessages.tsx` (it can be a thin wrapper). Header has two buttons:
- **Approve Plan** — calls `POST /api/objectives/:id/planning/approve`, closes panel, card moves to Queue
- **Cancel Planning** — calls `POST /api/objectives/:id/planning/cancel`, keeps card in Planning

The current planner message in flight uses the existing `ActivityIndicator` "Claude is working…" affordance.

### 7.5 Approved plan + review findings render

`SessionViewer.tsx`: above the message list, render two collapsible panels when present:
- **Approved Plan** (markdown) — shown for any objective with `approved_plan` set
- **AI Review Findings** (markdown) — shown for any objective with `ai_review_findings` set, with the verdict pill (PASS green / FAIL red)

Both rendered via existing markdown component (already used in MentorPage).

---

## 8. Type-based Effort + Agent Selection

### 8.1 Effort defaults

`ObjectiveModal` on type change:

```typescript
const DEFAULT_EFFORT_BY_TYPE: Record<ObjectiveType, EffortLevel> = {
  project: 'high',
  bug:     'normal',
  task:    'normal',
}
```

Effort is still editable per-objective.

### 8.2 Agent selection per category → type

`ObjectiveModal` on category change, before user picks type:

```typescript
const DEFAULT_TYPE_BY_CATEGORY: Record<ObjectiveCategory, ObjectiveType> = {
  development: 'project',
  finance:     'bug',
  legal:       'bug',
  operations:  'task',
  marketing:   'task',
  general:     'task',
}
```

`Hermes` orchestrator (which auto-creates objectives from raw signal via `/api/internal/objectives`) extends its decomposition output to include a `type` field, defaulting to the category-derived value if Hermes doesn't classify explicitly.

### 8.3 Sub-session model selection

Planner + reviewer sessions inherit `effort` from the objective:
- `normal` → haiku for reviewer, sonnet for planner
- `high` → sonnet for both
- `ultracode` → opus for both

The model is already wired through `session-manager.startSession` via the LiteLLM proxy — no new plumbing.

---

## 9. Implementation Plan (Steps)

Steps are derived backward from the acceptance criteria in §1. Each maps to at least one criterion.

| Step | Deliverable | Satisfies | Files | Owner |
|------|-------------|-----------|-------|-------|
| 1 | Schema migration: add `type`, `approved_plan`, `plan_approved_at`, `ai_review_*` columns; replace status CHECK; create `planning_conversations` table | AC1 | `app/server/src/db/index.ts` | Backend |
| 2 | Shared types update: `ObjectiveType`, new `ObjectiveStatus` values, `PlanningMessage`, updated `Objective` | AC1, AC4 | `app/shared/types.ts`, new `app/shared/workflow.ts` | Backend |
| 3 | Workflow engine: type-aware `isTransitionAllowed` + `getInitialStatus`; refactor `objectives.ts` PATCH /status to use it | AC5, AC6, AC7 | `app/shared/workflow.ts`, `app/server/src/routes/objectives.ts` | Backend |
| 4 | Planning skill file | AC3 | `~/ai-workspace/skills/cc-planner/SKILL.md` | Skills |
| 5 | Planning API endpoints (`/start`, `/messages`, `/message`, `/approve`, `/cancel`) | AC3 | `app/server/src/routes/objectives.ts`, new `app/server/src/services/planner-session.ts` | Backend |
| 6 | Reviewer skill: reuse `~/ai-workspace/skills/devops/qa-reviewer.md` with verdict/findings tag emission; add `spawnReviewerSession` | AC5, AC6 | `app/server/src/services/session-manager.ts`, `state-poller.ts` | Backend |
| 7 | Prompt-builder: inject `approved_plan` for working sessions; inject `ai_review_findings` on `fail` retry | AC4, AC5 | `app/server/src/services/prompt-builder.ts` | Backend |
| 8 | Kanban: type-aware columns, type chip on cards, secondary status pill | AC2, AC8 | `app/client/src/components/KanbanBoard.tsx`, `ObjectiveCard.tsx` | Frontend |
| 9 | ObjectiveModal: type selector with category-driven defaults; effort defaults by type | AC1, AC8 | `app/client/src/components/ObjectiveModal.tsx` | Frontend |
| 10 | PlanningPanel component + integration into modal | AC3 | new `app/client/src/components/PlanningPanel.tsx`, `ObjectiveModal.tsx` | Frontend |
| 11 | SessionViewer: render `approved_plan` and `ai_review_findings` panels | AC8 | `app/client/src/components/SessionViewer.tsx` | Frontend |
| 12 | Hermes update: extend dispatch payload with `type` field, default by category | AC1 | external — Hermes orchestrator (host VPS) | Ops |
| 13 | Backfill existing `review` rows to `human_review` and existing rows to `type='task'` | AC1, D5 | migration in step 1 | Backend |
| 14 | Self-deploy via `frontend` (UI changes) and `both` (server changes) | All | `scripts/self-deploy.sh` | Ops |

Step 14 needs careful sequencing: backend-only changes can `both`-deploy alone (kills sessions); frontend changes ride a safe `frontend`-only deploy. Schema migration runs at server boot — first `both`-deploy applies it.

### QA intensity

This is a `development`-profile task (code that ships to production). Standard QA: each step has its own acceptance check (DB introspection, API response, UI screenshot, reviewer session output). Reviewer skill itself gets a manual test pass before opening it for real objectives.

### Effort estimate

~3 sessions if work is well-decomposed: (1) schema + types + workflow engine + backend tests, (2) planner + reviewer wiring, (3) UI + integration test. Each session can fit under the 80k-token sub-agent budget when scoped tight.

---

## 10. Open Questions for Mike

Listed in priority order — answers shape implementation, not design.

1. **Should the planner be allowed to spawn `Explore` sub-agents?** (cheap codebase research vs. token budget). Recommendation: yes, capped at 3 explore calls per planning session.
2. **AI Review verdict on flaky tests** — if reviewer fails because a test is flaky, should there be a "Mike override → mark as pass" button on the card? Recommendation: yes, but only visible to admins.
3. **`bug` → `human_review` opt-in** — should there be a per-objective "force human review" toggle even for Bug type, for cases where Mike wants a second look? Recommendation: yes, single checkbox in modal.
4. **Hermes auto-typing** — should Hermes use the category-default mapping, or call an LLM to choose `type` based on the raw signal? Recommendation: ship with category default in v1; revisit if Hermes mis-classifies frequently.
5. **Cancelling planning** — does cancelling planning archive the conversation, delete it, or leave it for re-open? Recommendation: leave it (re-openable) but mark `status='queue'` (skips planning gate). Conversation stays in `planning_conversations` for future reference.

---

## 11. Migration Risk

- **Existing sessions in `review`** become `human_review` on rebuild. They keep working — the only behavior change is the column label.
- **Existing Hermes batches** don't include `type`. The default `task` ensures they keep flowing (`queue → working → done`).
- **Plan storage** is additive. Old objectives without `approved_plan` get the same prompt they get today.
- **Status enum rebuild** is the riskiest step — it locks the table briefly. Run during low traffic; CC has fewer than 1k objectives currently (per `objectives` table) so the rebuild is sub-second.

---

## 12. Out of Scope (for v1)

These are explicitly NOT in this phase, recorded so we don't scope-creep:

- Multi-reviewer voting (could be v2 if single reviewer turns out to be unreliable)
- Planning conversation search/index
- Plan templates per agent_context
- Type-change retroactive workflow re-routing (e.g. mid-flight changing a Task to a Project) — disallowed in UI
- Plan diff/version history (only the latest approved plan is stored)
- Plan generated from past similar objectives (RAG over previous plans)

---

## Approval

Once Mike signs off on the choices in §2 and the open questions in §10, implementation can proceed via the steps in §9. Until then this is a design doc, not a contract.
