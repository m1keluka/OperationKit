/**
 * Prompt-builder memory convention, reviewer artifact, and delegator/strategy
 * playbooks — extracted from prompt-builder.ts (behavior frozen).
 *
 * buildPrompt stays on the prompt-builder.ts facade.
 */
import fs from 'fs'
import type { Objective, AcceptanceCriterion } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { isUiInjectionActive, repoHasE2eSuite } from './design-context.js'

/**
 * Delegator playbook — injected into the prompt for objectives whose
 * delegate_mode is true. A delegator is a facilitator that decomposes
 * its objective into independent worker sessions, manages them to completion via
 * the localhost control API, and synthesizes the result. It does NOT implement
 * work itself. The wake-on-completion contract (end your turn; you'll be
 * re-invoked when a worker finishes) is what makes this loop cheap — no polling.
 */
// ── Objective-memory convention: scratch vs. final artifact (P1-1, obj 707060) ──
// One directory, two roles, and the split is the whole point:
//
//   objective-memory/<id>/NOTES.md     — the WORKER's private scratch. Mid-run
//                                        self-narration: hypotheses, dead ends,
//                                        "I think this is broken", restart state.
//   objective-memory/<id>/ARTIFACT.md  — the FINAL deliverable a consumer reads.
//
// Principle P2 (causal mask) + P2.3 (cross-attention reads the TOP of the producer
// stack, never mid-stack scratch): a reviewer that reads the worker's scratch is
// grading the worker's OPINION OF ITSELF rather than the deliverable. That is both
// an anchoring leak (the worker's "I'm confident this works" primes a pass) and a
// false-fail source (an abandoned hypothesis reads as a defect). So the reviewer is
// MASKED off the scratch file and given the artifact + the locked criteria instead.
//
// This is deliberately NOT symmetric: the WORKER keeps full read/write on its own
// scratch (buildPrompt still hands it the path), and delegator wake / parent flows
// are untouched. The mask applies to the reviewer edge only.
export const DEFAULT_OBJECTIVE_MEMORY_ROOT = '/home/operator/ai-workspace/objective-memory'

/**
 * The objective-memory root, resolved **per call**.
 *
 * Env-overridable (`CC_OBJECTIVE_MEMORY_ROOT`) only so the suite can exercise the
 * artifact-PUBLISHED branch: on the host the default is real and writable, on a CI runner
 * there is no `/home/mike` at all, so a test that must `mkdir` there fails for reasons
 * unrelated to the code under test. Unset in production ⇒ the default, unchanged.
 *
 * Resolved LAZILY, and that detail is load-bearing. `import` is hoisted above every other
 * statement in the importing module, so a test that sets `process.env` next to its imports
 * runs that assignment AFTER this module has already loaded. Reading the env once at module
 * scope therefore ignored the override and fell back to the host path: the redirect LOOKED
 * applied, passed locally (the host path happens to exist and be writable), and failed on CI
 * exactly as before. A function body reads the env at call time and cannot lose that race.
 */
export function objectiveMemoryRoot(): string {
  return process.env.CC_OBJECTIVE_MEMORY_ROOT || DEFAULT_OBJECTIVE_MEMORY_ROOT
}

export function objectiveMemoryDir(objectiveId: number): string {
  return `${objectiveMemoryRoot()}/${objectiveId}`
}

/** The worker's private scratch file. Consumers other than the worker MUST NOT read this. */
export function objectiveScratchPath(objectiveId: number): string {
  return `${objectiveMemoryDir(objectiveId)}/NOTES.md`
}

/** Escape a path literal for safe interpolation into a RegExp. */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const WORKER_SCRATCH_REDACTION = '[worker scratch — withheld from the reviewer]'

/**
 * Redact every pointer to the worker's private scratch file out of free text before
 * that text is echoed into a REVIEW prompt.
 *
 * Belt-and-braces, and load-bearing: the reviewer prompt echoes operator-authored
 * prose (`description`, `completion_goal`, `approved_plan`) and the worker's own
 * `last_session_summary`, any of which can spell the scratch path out verbatim — a
 * delegator brief routinely says "persist state to <dir>/NOTES.md". A mask built only
 * out of "we never add the pointer ourselves" would therefore leak on exactly the
 * objectives that care about it most. Redacting at the boundary instead makes the
 * invariant a single greppable property of the built prompt.
 */
export function maskWorkerScratch(text: string | null | undefined): string {
  if (!text) return ''
  return text
    // Absolute pointer at the scratch file — any objective id, and any memory ROOT.
    // Root-agnostic on purpose: CC_OBJECTIVE_MEMORY_ROOT can move the directory, and a
    // root-specific pattern would strip only the basename and leave the directory
    // prefix dangling in the prompt — a redaction that still points at the file.
    .replace(/[^\s)`'"]*objective-memory\/[^\s)`'"]*NOTES\.md/g, WORKER_SCRATCH_REDACTION)
    // ...and the CONFIGURED root explicitly, which the pattern above cannot assume:
    // it keys on the literal segment `objective-memory`, so a relocated root that does
    // not contain that word would fall through to the basename arm alone and leave its
    // directory prefix dangling — a redaction that still points at the file.
    .replace(
      new RegExp(`${escapeForRegExp(objectiveMemoryRoot())}/[^\\s)\`'"]*NOTES\\.md`, 'g'),
      WORKER_SCRATCH_REDACTION,
    )
    // Any remaining bare reference to the scratch file by name.
    .replace(/\bNOTES\.md\b/g, WORKER_SCRATCH_REDACTION)
}

/** The worker's final, consumer-facing artifact. This is what the reviewer reads. */
export function objectiveArtifactPath(objectiveId: number): string {
  return `${objectiveMemoryDir(objectiveId)}/ARTIFACT.md`
}

/**
 * Normalize `acceptance_criteria`, which reaches prompt builders in TWO shapes:
 * a parsed `AcceptanceCriterion[]` (mapped rows) or the raw JSON string stored in
 * SQLite (raw rows passed straight through). A raw string passes a `.length`
 * truthy check but `.map()` throws — and that throw, inside an async route
 * handler, crash-loops the server (obj 1180). Always go through this.
 */
export function normalizeAcceptanceCriteria(value: unknown): AcceptanceCriterion[] {
  let parsed: unknown = value
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { parsed = null }
  }
  return Array.isArray(parsed) ? (parsed as AcceptanceCriterion[]) : []
}

/**
 * The REVIEWER's causal mask (P1-1). Injected into `buildReviewerPrompt`
 * (session-manager.ts) — it lives here because this module owns prompt context
 * sections and their conventions.
 *
 * Gives the reviewer the TOP of the worker's stack:
 *   (a) the locked acceptance criteria, inline — the bar, verbatim;
 *   (b) the final artifact reference — ARTIFACT.md when the worker wrote one,
 *       otherwise the declared deliverable surface (branch / PR / last summary).
 *
 * And withholds the worker's mid-run scratch. INVARIANT, asserted by
 * `reviewer-prompt-mask.test.ts`: the string returned here — and therefore the
 * whole reviewer prompt — contains NO occurrence of the scratch filename or its
 * path. The prohibition below is phrased WITHOUT naming that file on purpose: a
 * prompt that says "do not read X" has still put X in front of the model.
 */
export function buildReviewerArtifactBlock(objective: Objective): string {
  const id = objective.id
  const artifactPath = objectiveArtifactPath(id)
  const artifactExists = (() => {
    try { return fs.existsSync(artifactPath) } catch { return false }
  })()

  const criteria = normalizeAcceptanceCriteria(objective.acceptance_criteria)

  const lines: string[] = [
    '## The deliverable you are grading (read this, not the worker\'s scratch)',
    '',
    'You grade the worker\'s FINAL OUTPUT against the criteria below. You are deliberately',
    'masked off the worker\'s mid-run working files: its private scratch inside the',
    `objective-memory directory (${objectiveMemoryDir(id)}/) is self-narration — hypotheses,`,
    'dead ends, and its own confidence about its own work. Reading it makes you grade the',
    'worker\'s opinion of itself instead of what it shipped: its optimism anchors you toward',
    'a pass, and an abandoned hypothesis reads as a defect that never shipped. Do NOT open',
    'the worker\'s private scratch files in that directory, and do NOT pull its raw session',
    'transcript. Grade the artifact, the branch, and the criteria.',
    '',
    '### Final artifact',
    '',
  ]

  if (artifactExists) {
    lines.push(
      `The worker published its final artifact at:`,
      '',
      `    ${artifactPath}`,
      '',
      'Read that file. It is the worker\'s own statement of what it delivered — treat it as a',
      'CLAIM to be verified against the code and the criteria, never as evidence on its own.',
    )
  } else {
    lines.push(
      `The worker published no final artifact at \`${artifactPath}\`. Its deliverable is therefore`,
      'whatever it actually shipped — grade these surfaces directly:',
    )
  }

  lines.push('')
  const surfaces: string[] = []
  if (objective.branch_name) surfaces.push(`- Branch: \`${objective.branch_name}\` (the code itself — the primary evidence).`)
  if (objective.pr_url) surfaces.push(`- PR: ${objective.pr_url}`)
  else if (objective.pr_number) surfaces.push(`- PR: #${objective.pr_number}`)
  if (objective.last_session_summary) {
    surfaces.push('- The worker\'s declared final summary (a CLAIM, not evidence — verify every assertion in it):')
  }
  if (surfaces.length === 0) {
    surfaces.push('- No branch, PR, or final summary was recorded. Locate the deliverable from the files-touched list below before concluding anything is missing.')
  }
  lines.push(...surfaces)

  if (objective.last_session_summary) {
    lines.push(
      '',
      '```',
      maskWorkerScratch(objective.last_session_summary).trim(),
      '```',
    )
  }

  lines.push(
    '',
    '### Acceptance criteria (the bar — grade against EXACTLY these)',
    '',
  )
  if (criteria.length > 0) {
    lines.push(
      // The criterion TEXT is echoed prose too, and a criterion ABOUT the mask spells the
      // scratch name out ("the prompt must contain no NOTES.md path"). Redacting it costs a
      // little readability on those meta-objectives and buys the invariant: the prompt
      // necessarily prints the objective-memory DIRECTORY (the artifact lives there), so a
      // bare basename surviving anywhere makes the full path trivially reconstructable and
      // the mask decorative. Found by an end-to-end render of THIS objective's real row —
      // the fixture-based unit tests could not see it.
      ...criteria.map((c) => `- [${c.id}] ${maskWorkerScratch(c.criterion)} (type: ${c.type}, verify via: ${c.method})`),
      '',
      'These are the locked criteria as stored on the objective. If Step 0 below has you fetch',
      'the rubric, the fetched copy is authoritative (it may have had N/A items stripped) — but',
      'it must match this list item-for-item apart from removals. Invent no new bar.',
    )
  } else {
    lines.push(
      'No rubric is locked on this objective yet — you author it in Step 0 below, from the',
      'description, completion goal, and plan. Once locked it becomes the bar for every',
      'later iteration.',
    )
  }

  return lines.join('\n')
}

export function buildDelegatorBlock(objective: Objective): string[] {
  const ws = objective.workspace || 'example'
  const id = objective.id
  const base = 'http://localhost:3002/api/internal/objectives'
  return [
    '# DELEGATOR MODE (active for this objective)',
    '',
    'You remain the agent described above — your persona, workspace context, and domain',
    'ownership all still apply. But for THIS objective you operate as a DELEGATOR: you do',
    'NOT implement the work yourself. You decompose this objective into worker tasks, spawn',
    'each as its OWN independent Claude Code session, manage them to completion, and',
    'synthesize the result. You are the signal; the workers are the hands.',
    '',
    `Your objective id is ${id}. Set parent_id=${id} on EVERY worker you create so workers`,
    'are linked to you on the board (and so the wake-on-completion callback can find you).',
    '',
    'CRITICAL — HOW TO SPAWN WORKERS: create each worker ONLY via the control API below',
    '(the POST curl). Do NOT use the Agent tool, the Task tool, or TeamCreate to create your',
    'workers — those run in-process as sub-agents, never appear on the board, and CANNOT fire',
    'your [child-complete] wakes, so you will be left blind and the work invisible. (A worker',
    'may use sub-agents INTERNALLY for its own execution — but YOUR workers must each be a real',
    'board objective created with the POST below.)',
    '',
    '## Control API (localhost only, port 3002 — no auth)',
    '- Spawn a worker (returns {"created":N,"objectives":[{"id":..,"title":..}]} — RECORD the id):',
    `    curl -s -X POST ${base} \\`,
    `      -H 'Content-Type: application/json' \\`,
    `      -d '[{"title":"Worker: <task>","description":"<full self-contained instructions>","agent_context":"${objective.agent_context}","workspace":"${ws}","type":"task","parent_id":${id},"completion_goal":"<definition of done>","acceptance_criteria":[{"id":"<kebab-id>","criterion":"<one concrete testable statement>","type":"functional|visual|data","method":"browser|api|doc"}]}]'`,
    `  (Omit "model" to use Sonnet for workers — cheaper than the board default. Set "model" explicitly only when the worker needs Opus. Pick the right owning agent per worker — default to your own ("${objective.agent_context}"), or a specialist (cto/cmo/coo/cfo/general/...) when the task fits one better; it must be valid for the workspace pool. Do NOT set delegate_mode on a worker.)`,
    '  REQUIRED: define 3-7 acceptance_criteria per worker — these are the review checkpoints you design now, during planning. Each worker is INDEPENDENTLY REVIEWED by a fresh-context adversarial agent graded against exactly these criteria before it can complete, so make them concrete and testable.',
    '  Do NOT write a criterion whose proof is a FUTURE wall-clock event the worker session cannot reach (e.g. "prove the cron fired on its next natural tick" when that tick is minutes or hours out). The worker has no way to schedule a delayed start, so such a criterion is unmeetable by construction and fails the worker for a bar it could never clear. Grade the reachable intent instead — scheduler entry installed, one manual run\'s real stdout and exit code, config verified — and if confirming the natural firing genuinely matters, plan it as a SEPARATE follow-up verification objective to start after the fire time, not as a bar the setup session must block on.',
    ...(isUiInjectionActive(objective)
      ? [
          '  REQUIRED (UI): if a worker targets a registered frontend repo (see /home/operator/projects/.design-registry.json), you MUST attach the 5-criterion ds-conformance acceptance criteria (ds-tokens-only, ds-primitives, ds-renders-conformant, ds-interaction-states, ds-a11y-contrast) so taste is a gradable bar. Drop-in template: /home/operator/ai-workspace/skills/devops/ds-conformance-criteria.md. (Add the ds-no-contract-drift headline criterion for visual-only wire/re-skin tasks.) If you forget, the objectives API auto-appends them as a safety net — but attach them explicitly so you design the bar deliberately.',
        ]
      : []),
    ...(repoHasE2eSuite(objective.project)
      ? [
          '  REQUIRED (QA): this repo ships a Playwright/E2E suite, so any worker doing user-facing work MUST attach the production-worthy QA acceptance criteria (qa-smoke, qa-role-matrix, qa-error-state) — a page-loads-only pass is NOT shippable and must fail the gate. Drop-in template: /home/operator/ai-workspace/skills/devops/qa-conformance-criteria.md; contract: ~/ai-workspace/skills/qa-enforcement/SKILL.md ("Production-Worthy Gate Contract"). If you forget, the objectives API auto-appends them as a safety net — but attach them explicitly so you design the bar deliberately.',
        ]
      : []),
    '- Start a worker (queue -> working spawns its session):',
    `    curl -s -X PATCH ${base}/<id>/status -H 'Content-Type: application/json' -d '{"status":"working"}'`,
    '- Check a worker:',
    `    curl -s ${base}/<id>`,
    '  After a worker session ends it is AUTOMATICALLY sent to an independent reviewer (status "ai_review"). You are only woken once the verdict is in. Read .ai_review_verdict: "pass" = independently approved, accept it; otherwise it failed review (already auto-iterated up to 3x) — read .ai_review_findings and escalate or re-scope. Also read .last_session_summary for the outcome.',
    '- What a worker\'s SIBLINGS delivered (final summaries + verdicts only, no scratch) — the supported peer read edge:',
    `    curl -s ${base}/<id>/siblings`,
    '- Read full worker output when the summary is not enough:',
    `    curl -s "${base}/<id>/output?limit=40"`,
    '- Iterate a worker (sends a follow-up into its existing session, resumes its context):',
    `    curl -s -X POST ${base}/<id>/message -H 'Content-Type: application/json' -d '{"message":"<specific corrections>"}'`,
    '- Accept a worker (review -> done; removes it from the active board):',
    `    curl -s -X PATCH ${base}/<id>/status -H 'Content-Type: application/json' -d '{"status":"done"}'`,
    '',
    '## Workflow',
    '1. PLAN. Break the objective into 2-5 independent worker tasks. Write the plan and a',
    `   CHILD REGISTRY table (child_id | task | status | verdict) to your NOTES.md`,
    `   (/home/operator/ai-workspace/objective-memory/${id}/NOTES.md). NOTES.md is your save file:`,
    '   on every wake you reconstruct your full state from it.',
    '2. SPAWN workers, at most 5 running at once. Record each returned child id in the registry,',
    '   then start it.',
    '3. END YOUR TURN. Do NOT poll, sleep, or loop waiting. Once your in-flight workers are',
    '   running, stop. You will be AUTOMATICALLY re-invoked with a "[child-complete]" message',
    '   each time a worker finishes — that is your only cue to continue. Polling wastes budget.',
    '4. ON EACH WAKE: read NOTES.md, then for each finished worker check its independent-review verdict:',
    '     - PASS    -> accept it: mark the worker done, update the registry.',
    '     - FAIL    -> it already auto-iterated against your criteria up to 3x and still failed. Read',
    '                  .ai_review_findings, then ESCALATE (record in NOTES.md + surface in your report)',
    '                  or re-scope into a new worker. Do NOT silently accept failed work.',
    '   Then spawn the next queued worker if you are under 5 in flight. Update NOTES.md, end your turn.',
    '5. FINISH. When every worker is accepted or escalated, write a concise synthesis of what was',
    '   accomplished (this becomes your card summary) and stop.',
    '',
    '## Discipline',
    '- You are the orchestrator, not an implementer. Delegate the actual building.',
    '- Each worker can itself fan out to sub-agents and sub-agent teams internally, so size worker tasks as substantial, coherent units of work — not micro-steps. Let the detail live below the worker; you stay at strategy and integration.',
    '- Never run more than 5 workers concurrently.',
    `- Always set parent_id=${id} on workers. Workers must NOT set delegate_mode (no nested delegation).`,
    '- On every wake, act on EACH finished worker (status `review`): accept it (mark done), iterate, or escalate. Never leave a finished worker sitting unacted — that stalls the whole objective.',
    '- Persist state to NOTES.md before ending every turn. Assume you may be restarted at any',
    '  moment; NOTES.md must always be enough for a fresh you to resume the orchestration.',
  ]
}

/**
 * Strategy playbook (P4) — the depth-0 variant of the delegator block, injected
 * for a STRATEGY node (a delegator whose children are themselves delegate_mode
 * PROJECTS) when CC_STRATEGY_TIER is on. Where buildDelegatorBlock teaches the
 * one-tier "spawn workers → accept/iterate/escalate" loop, this teaches the
 * decompose-into-PROJECTS DECISION LOOP: the strategy node spawns each project
 * as its OWN delegator, is re-woken (via the P3 [project-complete] wake) after
 * each finishes, pulls/judges that project's result, and decides the next
 * project at decision granularity. The wake plumbing already exists (P3); this
 * is ONLY the prompt/playbook the re-woken strategy node reads.
 *
 * Mirrors buildDelegatorBlock's control-API recipes with two deltas: workers are
 * spawned as PROJECTS (delegate_mode:true), and the loop is pull→judge→decide
 * rather than accept/iterate/escalate. Design: strategy-layer-design.md §6.2.
 */
export function buildStrategyBlock(objective: Objective): string[] {
  const ws = objective.workspace || 'example'
  const id = objective.id
  const base = 'http://localhost:3002/api/internal/objectives'
  // obj 700030 Part B — at trust_stage<=0 the human gate is ARMED and HARD-enforced:
  // the batch spawn route REFUSES any project spawn without an owner-approved
  // Decision Request. The playbook must tell the strategy to park EVERY decision,
  // not "if armed". Stage 1+ enforcement is a later slice; today strategies are stage 0.
  const gateArmed = (objective.trust_stage ?? 0) <= 0
  return [
    '# STRATEGY MODE (active for this objective — depth-0 strategy node)',
    '',
    'You remain the agent described above — your persona, workspace context, and domain',
    'ownership all still apply. But for THIS objective you operate as a persistent STRATEGY',
    'agent: the top tier of the hierarchy (Strategy → Project → Task). You do NOT implement',
    'work, and you do NOT decompose into micro-tasks. You decompose your objective into',
    'PROJECTS — each project is ITSELF a delegator that fans out into its own workers. You are',
    're-invoked after each project completes to pull its result, judge it, and decide the next',
    'project. You are the signal at decision-granularity; the projects (and their workers) are the hands.',
    '',
    `Your strategy id is ${id}. Set parent_id=${id} on EVERY project you create so projects are`,
    'linked to you on the board (and so the wake-on-completion callback can find you).',
    '',
    'CRITICAL — HOW TO SPAWN PROJECTS: create each project ONLY via the control API below (the',
    'POST curl) with "delegate_mode":true. Do NOT use the Agent tool, the Task tool, or TeamCreate —',
    'those run in-process and never appear on the board, so they cannot fire your [project-complete]',
    'wakes and you will be left blind. Each project must be a real board objective created with the POST below.',
    '',
    '## Control API (localhost only, port 3002 — no auth)',
    '- Spawn a PROJECT (a delegator child — returns {"created":N,"objectives":[{"id":..,"title":..}]} — RECORD the id):',
    `    curl -s -X POST ${base} \\`,
    `      -H 'Content-Type: application/json' \\`,
    `      -d '[{"title":"Project: <objective>","description":"<full self-contained project brief>","agent_context":"${objective.agent_context}","workspace":"${ws}","type":"project","delegate_mode":true,"parent_id":${id},"completion_goal":"<project-level definition of done>","acceptance_criteria":[{"id":"<kebab-id>","criterion":"<one concrete testable statement>","type":"functional|visual|data","method":"browser|api|doc"}]}]'`,
    '  Each project you spawn is ITSELF a delegator: give it a project-level completion_goal and',
    '  acceptance_criteria, and it will decompose into its own tasks and manage its own workers.',
    '  (Omit "model" to use the configured default. delegate_mode:true is REQUIRED — that is what',
    '  makes the child a project rather than a single worker; the nesting guard permits it because you',
    '  are a depth-0 delegator with the strategy tier enabled.)',
    '- Check a project:',
    `    curl -s ${base}/<id>`,
    '  A finished project parks in "review" with a .last_session_summary (its synthesis) and, if graded,',
    '  a .ai_review_verdict. Read those FIRST; only pull deeper if the summary is insufficient.',
    '- Read a project\'s deeper output when the summary is not enough (bounded fallback):',
    `    curl -s "${base}/<id>/output?limit=40"`,
    '- Accept a project (review -> done; removes it from the active board):',
    `    curl -s -X PATCH ${base}/<id>/status -H 'Content-Type: application/json' -d '{"status":"done"}'`,
    '- Send a course-correction into a project\'s existing session (resumes its context):',
    `    curl -s -X POST ${base}/<id>/message -H 'Content-Type: application/json' -d '{"message":"<specific direction>"}'`,
    '',
    '## The DECISION LOOP (this is your workflow — bounded, data-driven, append-only)',
    '1. PLAN. Decompose the strategy into an ordered/contingent sequence of PROJECTS. Write a',
    `   PROJECT REGISTRY table (project_id | objective | status | verdict | decision) to your NOTES.md`,
    `   (/home/operator/ai-workspace/objective-memory/${id}/NOTES.md). NOTES.md is your save file: on every`,
    '   wake you reconstruct your full state from it in ONE read.',
    gateArmed
      ? '2. PARK THE FIRST PROJECT FOR APPROVAL. The human gate is ARMED — you may NOT spawn directly. POST a Decision Request (see "The human gate" below) describing the first project and await Mike’s approval. Record it in the registry. END YOUR TURN.'
      : '2. SPAWN THE FIRST PROJECT only (delegate_mode:true). Record its id in the registry. END YOUR TURN.',
    '3. END YOUR TURN. Do NOT poll, sleep, or loop waiting. You will be AUTOMATICALLY re-invoked with a',
    '   "[project-complete]" message each time a project finishes — that is your only cue to continue.',
    '4. ON EACH [project-complete] WAKE, run the bounded protocol against the DELTA (the newly finished project):',
    '     a. RECONSTRUCT from NOTES.md (one read). Identify which project just finished.',
    '     b. PULL its result: read .last_session_summary + .ai_review_verdict (one GET). Pull deeper output',
    '        ONLY if the summary is insufficient. Do NOT re-analyze already-decided projects.',
    '     c. JUDGE against the strategy goal: did this project move it? Trust a PASS verdict unless quality',
    '        signals are elevated. Do not re-verify a clean PASS.',
    '     d. DECIDE exactly ONE of: (i) spawn the NEXT project (one POST, delegate_mode:true) — at most one',
    '        per wake unless explicitly batching; (ii) STOP — goal met: write your final synthesis and let',
    gateArmed
      ? '        the objective settle to review; (iii) the human gate is ARMED — you MUST park a Decision Request for the next project (see below) instead of spawning.'
      : '        the objective settle to review; (iii) PAUSE for the human gate if armed (see below).',
    '     e. PERSIST the decision + updated PROJECT REGISTRY to NOTES.md, then END YOUR TURN.',
    '5. FINISH. When the strategy goal is met (or every project is accepted/escalated), write a concise',
    '   synthesis of what was accomplished (this becomes your card summary) and stop.',
    '',
    '## The human gate',
    ...(gateArmed
      ? [
          `- THE HUMAN GATE IS ARMED (trust stage ${objective.trust_stage ?? 0}). This is HARD-enforced server-side:`,
          '  the spawn route REFUSES every project spawn that lacks an owner-APPROVED Decision Request. You CANNOT',
          '  bypass it — a direct spawn returns HTTP 409. So for EVERY project (including the first), park a Decision',
          '  Request and await Mike’s approval before spawning:',
          `    curl -s -X POST ${base}/${id}/decision \\`,
          `      -H 'Content-Type: application/json' \\`,
          `      -d '{"kind":"spawn-next","decision":"<one sentence: the next project>","evidence":["<concrete signal>"],"options":[{"id":"a","label":"<the project>"}],"recommendation":"a","recommendation_why":"<why>"}'`,
          '  This parks YOU in review with a pending decision. Mike approves/denies via the board. On APPROVAL you are',
          '  re-woken with a [decision …] APPROVED follow-up — THEN issue the spawn POST (the approval authorizes exactly',
          '  ONE project spawn, and is consumed by it; the next project needs its own approval). On DENIAL, re-plan and',
          '  park a new request. Never attempt to spawn before the approval lands.',
        ]
      : [
          '- Before spawning the next project, if a human gate is armed for this decision, PAUSE: write your',
          '  proposed next project to NOTES.md and request Mike\'s sign-off (leave the objective in review)',
          '  instead of spawning. The gating framework owns the gate mechanics and the progressive-trust',
          '  graduation; this playbook only references and invokes it.',
        ]),
    '',
    '## Discipline (regimented context — productive tokens, not reckless burn)',
    '- READ WHAT YOU OWN: read ONLY your own NOTES.md + the single project GET + scalar quality signals.',
    '  NEVER read project source files, worker output, or task-level detail — that lives two tiers down.',
    '  Your context is O(number of projects): a handful of summary blocks, not transcripts.',
    '- DURABLE STATE IS THE FILE: NOTES.md is your truth. Reconstruct from it in one read; assume restart.',
    '  Write before ending EVERY turn.',
    '- PROCESS ONLY THE DELTA: each wake handles the newly finished project against durable NOTES.md state.',
    '  Already-decided projects are never re-pulled — this is what keeps the chain long without the context growing.',
    '- ONE DECISION UNIT PER WAKE: spawn at most one new project per wake unless explicitly batching.',
    `- Always set parent_id=${id} and delegate_mode:true on the PROJECTS you spawn.`,
  ]
}

/**
 * PR-gated harness loop: render a structured "Prior AI Review — Failing Criteria"
 * section from the latest persisted objective_reviews row, listing each FAILING
 * criterion with severity, repro, and expected-vs-actual. Returns '' when there are
 * no structured results (so the caller falls back to free-text findings). Never throws.
 */
export function buildFailingCriteriaSection(objectiveId: number): string {
  try {
    const row = getDb()
      .prepare(
        'SELECT criteria_results FROM objective_reviews WHERE objective_id = ? ORDER BY iteration DESC LIMIT 1'
      )
      .get(objectiveId) as { criteria_results: string } | undefined
    if (!row?.criteria_results) return ''
    const parsed = JSON.parse(row.criteria_results) as Array<{
      id?: string; criterion?: string; status?: string; severity?: string
      repro?: string; expected?: string; actual?: string
    }>
    if (!Array.isArray(parsed)) return ''
    const failing = parsed.filter(c => c.status === 'fail')
    if (failing.length === 0) return ''
    const lines = failing.map(c =>
      `- [${(c.severity || 'major').toUpperCase()}] **${c.id || c.criterion || 'criterion'}** — ${c.criterion || ''}\n`
      + `  - repro: ${c.repro || '(none)'}\n`
      + `  - expected: ${c.expected || '(none)'}\n`
      + `  - actual: ${c.actual || '(none)'}`
    )
    return [
      '## Prior AI Review — Failing Criteria (fix these specific failures)',
      '',
      'A test-agent drove the live PR preview and recorded these failing criteria. Reproduce each,',
      'fix the underlying cause, and make sure the expected behavior holds in the running app:',
      '',
      ...lines,
    ].join('\n')
  } catch {
    return ''
  }
}
