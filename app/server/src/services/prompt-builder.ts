/**
 * Session spawn prompt assembly. Maps, workdir, history, and playbook blocks
 * live in prompt-builder-workdir.ts / prompt-builder-history.ts /
 * prompt-builder-blocks.ts. This file is buildPrompt + re-exports.
 */
import fs from 'fs'
import type { Objective, AcceptanceCriterion } from '@command-center/shared'
import { getDb } from '../db/index.js'
import { buildContext } from './context-builder.js'
import { PROJECTS_DIR } from '../config.js'
import { isUiObjective, buildDesignContextBlock, isUiInjectionActive } from './design-context.js'
import { deriveBranchName, deriveWorktreeBranchName } from './branch-scope.js'
import { resolveAvailable } from './resource-assignments.js'
import { isStrategyNode } from './delegation.js'
import { isStrategyTierEnabled } from './strategy-governance.js'
import { HUMAN_VOICE } from '../lib/human-voice.js'
import {
  AGENT_MAP,
  readAgentInstructions,
  resolveOnBehalfUser,
  resolveWorkdir,
} from './prompt-builder-workdir.js'
import {
  buildDelegatorBlock,
  buildFailingCriteriaSection,
  buildStrategyBlock,
  objectiveArtifactPath,
  objectiveMemoryDir,
  objectiveScratchPath,
} from './prompt-builder-blocks.js'

export {
  AGENT_MAP,
  COMPACTION_SESSION_SENTINEL,
  MAX_OBJECTIVE_HISTORY_CHARS,
  OBJ_COMPACTION_TAIL_TURNS,
  OBJ_COMPACTION_THRESHOLD,
  WORKDIR_MAP,
  loadWorkspacesConfig,
  readAgentInstructions,
  resolveWorkdir,
  type ObjectiveTurn,
} from './prompt-builder-workdir.js'

export {
  assembleFlattenedFollowUpPrompt,
  buildObjectiveHistory,
  extractObjectiveTurns,
  formatObjectiveTurns,
  refreshObjectiveSummary,
} from './prompt-builder-history.js'

export {
  DEFAULT_OBJECTIVE_MEMORY_ROOT,
  WORKER_SCRATCH_REDACTION,
  buildDelegatorBlock,
  buildReviewerArtifactBlock,
  buildStrategyBlock,
  maskWorkerScratch,
  normalizeAcceptanceCriteria,
  objectiveArtifactPath,
  objectiveMemoryDir,
  objectiveMemoryRoot,
  objectiveScratchPath,
} from './prompt-builder-blocks.js'

/**
 * Canonical GitHub `owner/repo` for a card's project, from `workspace_repos`.
 * Used so `gh pr create --repo` hits the org repo, not a leftover personal remote.
 */
export function resolveGithubRepo(objective: Pick<Objective, 'project'>): string | null {
  const project = (objective.project || '').trim()
  if (!project) return null
  try {
    const row = getDb()
      .prepare(
        `SELECT github FROM workspace_repos
          WHERE github IS NOT NULL AND github != ''
            AND (
              github = ?
              OR github LIKE '%/' || ?
              OR name = ?
            )
          LIMIT 1`,
      )
      .get(project, project, project) as { github: string } | undefined
    const g = (row?.github || '').trim()
    return g.includes('/') ? g : null
  } catch {
    return null
  }
}

// Strategy Layer dark-launch flag — the ONE shared helper (isStrategyTierEnabled,
// env CC_STRATEGY_TIER OR settings.strategy_tier_enabled). Read at the point of use
// so the flag can be flipped without a restart. When off, prompt construction is
// byte-identical to pre-Strategy-Layer behavior.

/**
 * Does this delegator orchestrate PROJECTS (a strategy node) rather than tasks?
 *
 * Two complementary signals, OR'd, both gated by the flag at the call site:
 *  - `is_strategy` — the stored marker (obj 2383), written at creation for a
 *    top-level delegator (depth 0). This is what makes the FIRST spawn work:
 *    a freshly-created strategy node has no children yet, so a children-only
 *    test would mislabel it as an ordinary delegator and never teach it to
 *    decompose into projects (chicken-and-egg).
 *  - `isStrategyNode` (P3) — "has at least one delegate_mode child", the actual
 *    structural property of a delegator-of-delegators. Covers a delegator that
 *    has already spawned project children but predates/omits the stored marker.
 *
 * NOTE: only consulted when isStrategyTierEnabled() is already true (see buildPrompt),
 * so with the flag off this function is never called and the DB is never queried —
 * the flag-off prompt is byte-identical for every node type.
 */
function isStrategyDelegator(objective: Objective): boolean {
  if (!objective.delegate_mode) return false
  if (objective.is_strategy) return true
  try {
    return isStrategyNode(getDb(), objective.id)
  } catch {
    return false
  }
}

export function buildPrompt(objective: Objective): string {
  const agent = AGENT_MAP[objective.agent_context]
  const context = buildContext(objective)
  const workspace = objective.workspace || 'example'
  const onBehalf = resolveOnBehalfUser(objective)

  const parts: string[] = []
  // Inline agent instructions server-side — saves 1-3 setup tool calls per session
  const agentInstructions = readAgentInstructions(agent)
  if (agentInstructions) {
    parts.push(
      `You are the ${agent} agent. Your instructions are inlined below (source: ~/ai-workspace/agents/${agent}.md):`,
      '',
      agentInstructions,
    )
  } else {
    parts.push(`You are the ${agent} agent. Read ~/ai-workspace/agents/${agent}.md for your instructions.`)
  }

  // Delegator MODE — additive on top of the agent persona above. The owning
  // agent keeps its identity/context but, for this objective, orchestrates
  // worker objectives instead of implementing directly. The playbook is injected
  // from code (mechanical control-API recipes + the wake-on-completion contract)
  // and is re-established on every respawn path (native --resume keeps context;
  // the history-flatten fallback re-runs buildPrompt), so the role survives wakes.
  if (objective.delegate_mode) {
    // P4 (flag-gated): a depth-0 STRATEGY node (a delegator whose children are
    // themselves delegate_mode projects) gets the decompose-into-PROJECTS
    // playbook instead of the one-tier worker loop. The flag is evaluated FIRST,
    // so with CC_STRATEGY_TIER unset this is always buildDelegatorBlock and the
    // prompt is byte-identical to pre-P4 for every node type (no DB query either).
    const block = isStrategyTierEnabled() && isStrategyDelegator(objective)
      ? buildStrategyBlock(objective)
      : buildDelegatorBlock(objective)
    parts.push('', ...block)
  }

  parts.push(
    '',
    HUMAN_VOICE,
    '',
    '## Operating Principles',
    '',
    '- Before reporting progress, audit each claim against a tool result from this session. Only report work you can point to evidence for; if something is not yet verified, say so.',
    '- Pause for the human only when Talking to the human says so: a decision, a missing secret, or a click you cannot do.',
    '- If your deliverable is a FILE (report, design doc, PRD, CSV, data pool, research landscape), write it to its FINAL target path EARLY — a skeleton with the required section headers, or the first computed rows — then fill it in place as you go. Do NOT hold the whole artifact in context for one single final write: a session can be killed by a spend or session ceiling with zero warning, and everything not already on disk is lost — the reviewer then finds an empty directory and the whole objective must be re-run from scratch.',
    '- The skeleton is scaffolding, not a deliverable: BEFORE you route to review or end your turn, grep your artifact (ARTIFACT.md and any file a criterion names) for leftover placeholder tokens — `TBD`, `[TO BE FILLED …]`, `_… pasted here …_`, "see … below", "pasted below", "(after deployment)" — because the reviewer reads that file AS the deliverable and hard-fails any GRADED field still holding one, even when the underlying work is finished. Each such token has exactly two valid exits: (a) paste the REAL result in its place — if the work is done, the number/output/screenshot already exists in your NOTES or run log, so copy it over (obj 708457 lost credit on a completed 187,088-row dump whose ARTIFACT still said "Fresh count: TBD", then PASSed on re-review once the number was transcribed); or (b) if the result genuinely cannot be obtained this session, DELETE the placeholder and mark that criterion "deferred to obj <N>" per the async-gated-evidence rule — never leave a token that silently reads as "pending/done" (obj 708543 shipped `[TO BE FILLED after second run]` in two graded fields).',
    '- Before declaring done, run the relevant tests/build/typecheck for whatever you changed and paste the ACTUAL command output into NOTES.md (not the thread). Do not claim done on prose alone — if you changed code, show it running; if there is nothing executable to run, say so explicitly and explain how you verified instead.',
    '- If you spawn background or detached jobs (a trailing `&`, `nohup`, `setsid`, or sharded `--apply` runs), you MUST block until they EXIT before you route to review or report completion: wait on their PIDs (`until ! ps -p <pids> >/dev/null 2>&1; do sleep 5; done`), PROVE no shard is still alive (`ps -eo pid,comm,args | grep <job>` → no rows), and only THEN capture the final measured artifact. A projection ("it will finish at N"), a mid-run baseline, or an "IN FLIGHT / re-run after exit" note is NOT evidence — the reviewer will fail it and the review loop will thrash to its iteration cap. Measure after exit; report after measuring.',
    ...(objective.delegate_mode
      ? []
      : ['- Async-gated evidence: when an acceptance criterion\'s proof depends on a future wall-clock event (a cron\'s NEXT natural fire, a multi-minute job still in flight), do NOT end your turn against it. Ending the turn finalizes the deliverable and triggers the adversarial review IMMEDIATELY — so a `[to be completed]` section, an empty stub, or a "watchers armed, ending to let wall-clock pass" hand-off is a guaranteed FAIL even when your setup was perfect. Choose by wait length. SHORT wait (roughly under 25 minutes): stay in the session and wait it out, but poll in a loop that emits VISIBLE tool output rather than one long silent sleep — a silent session reads as hung (30 minutes with no output flags a blocker; 90 minutes force-routes you into review anyway, which is the same failure involuntarily). Then capture the post-event evidence and declare done. LONG or unbounded wait: do NOT leave a placeholder and do NOT claim the criterion. There is NO way to schedule a delayed start, so create the follow-up verification objective NOW (POST /api/internal/objectives) containing the exact post-event check to run, say in your summary that it lands in `queue` and needs starting after <time>, mark the criterion "deferred to obj <N>", and paste your complete setup evidence for everything that WAS reachable.']),
    '- If you are looping without new evidence, stop and report what is blocked instead of burning the rest of the turn budget. Do not restart the same investigation from scratch.',
  )

  // Context & sub-agent discipline — applies to execution sessions (workers and
  // standalone objectives), NOT a delegator-mode session (which delegates to
  // full worker sessions, not in-session sub-agents). The goal is top-down
  // context preservation: push mundane/parallelizable execution DOWN into
  // sub-agents so it never pollutes this session's context, and so the summary
  // that flows UPWARD (to a delegator or to session-intel) stays high-level.
  if (!objective.delegate_mode) {
    parts.push(
      '',
      '## Context & Execution Discipline',
      '',
      'Your context window is a scarce resource, and a concise summary of your work flows upward to higher-level sessions. Keep your own context focused on planning, coordination, and synthesis — push detailed, mechanical, or parallelizable execution DOWN into sub-agents:',
      '- Use the Agent tool only for a large, parallelizable chunk that would drown this session (a full test suite, a wide repo exploration). Do the work yourself for a single-file edit, a small research question, or anything you can finish in a few tool calls. Nested sub-agents bill the same account.',
      '- For larger parallel efforts, use TeamCreate to run a team of sub-agents concurrently, then integrate their reports.',
      '- Reserve your own turns for decomposition, delegation, integrating sub-agent results, and verifying the outcome. Do not do in your own context what a sub-agent can do in theirs.',
      '- When you finish, report a tight summary of what changed and the outcome — not a play-by-play. That summary is what your supervising session sees.',
    )
  }

  parts.push(
    '',
    '## Objective Memory',
    '',
    `This objective has a persistent memory directory: ${objectiveMemoryDir(objective.id)}/`,
    'If NOTES.md exists there, read it before starting. As you work, write durable state, decisions, and progress to NOTES.md — follow-up and future sessions on this objective will read it.',
    '',
    'That directory holds TWO files with different audiences — keep them separate:',
    `- \`${objectiveScratchPath(objective.id)}\` — YOUR private scratch. Hypotheses, dead ends, restart state, self-narration. Write freely; nobody grades it. The AI reviewer is deliberately masked off this file, so nothing you need judged may live only here.`,
    `- \`${objectiveArtifactPath(objective.id)}\` — YOUR final artifact, and the thing consumers actually read. Write it before you finish: what you delivered, where it lives (branch / PR / file paths), and the evidence for each acceptance criterion. This is what the reviewer reads in place of your scratch, so an unstated deliverable is an ungraded deliverable.`,
  )

  parts.push(
    '',
    `Workspace: ${workspace}`,
    `Read ~/ai-workspace/workspaces/${workspace}/context.md for business context.`,
  )

  // Per-workspace agent overlay. Convention: workspaces/<ws>/agent-profiles/<agent>.md
  // contains workspace-specific priorities, conventions, integrations, or tone notes
  // that layer on top of the canonical agent file. Injected only when the file exists,
  // so workspaces without overlays produce identical prompts to before.
  const overlayAbs = `/home/operator/ai-workspace/workspaces/${workspace}/agent-profiles/${agent}.md`
  if (fs.existsSync(overlayAbs)) {
    parts.push(
      `Read ${overlayAbs} for ${workspace}-specific overlay on the ${agent} role (priorities, conventions, integrations).`,
    )
  }

  // obj-2388: scoped skill assignment. When an admin has scoped skills to this
  // workspace/project (resource_assignments), gate the session to that allow-list
  // so it doesn't reach for skills it isn't assigned. No assignment for this
  // context = unrestricted (legacy), so this block is silent by default.
  const skillUserId = objective.assigned_user_id ?? objective.created_by ?? null
  const skillAvail = resolveAvailable('skill', {
    workspace,
    project: objective.project ?? null,
    userId: skillUserId,
  })
  if (skillAvail.restricted) {
    parts.push(
      '',
      '## Skill Assignments (scoped)',
      '',
      skillAvail.allowed.length
        ? `For this ${objective.project ? `project (${objective.project})` : `workspace (${workspace})`}, only these skills are assigned and available to you: ${skillAvail.allowed.join(', ')}. Do not invoke other skills.`
        : `No skills are assigned to this ${objective.project ? `project (${objective.project})` : `workspace (${workspace})`}. Operate without skills unless an admin assigns one.`,
    )
  }
  if (onBehalf) {
    parts.push(
      '',
      `User: you are working on behalf of ${onBehalf.username} (${onBehalf.role}, workspaces: ${onBehalf.workspaces.join(', ') || 'none'}).`,
    )
    if (onBehalf.profilePathAbs) {
      parts.push(
        `Read ${onBehalf.profilePathAbs} for this user's preferences (tone, defaults, areas owned, escalation rules).`,
      )
    }
  }

  parts.push(
    '',
    '## Identity (this session — do not improvise)',
    '',
    'Google and GitHub for this session belong to the assigned user (or the creator if unassigned). Env tells you which:',
    '- `CC_ACTING_USER_ID` — Command Center user id you are acting as.',
    '- `GOOGLE_WORKSPACE_CONNECTION=user` + `USER_GOOGLE_EMAIL` — send/read mail and Docs ONLY as that address. Never pick another account from disk.',
    '- `GOOGLE_WORKSPACE_CONNECTION=absent` — this user has no Google connection. Do NOT send email. Tell them to connect at Settings → Account → Google Workspace.',
    '- `GH_TOKEN` / `GIT_AUTHOR_EMAIL` — GitHub actor for this user. Do not fall back to another person\'s token or a sibling credential file.',
  )
  parts.push(
    '',
    `Objective: ${objective.title}`,
    '',
    `Context: ${objective.description}`,
  )
  if (objective.project) {
    parts.push('', `Project: ${objective.project}`)
  }

  // Approved plan from the planning stage — only present for project-type
  // objectives that went through /api/objectives/:id/planning/approve. Always
  // prepend it verbatim so the executor starts from the agreed acceptance
  // criteria instead of re-discovering scope.
  if (objective.approved_plan) {
    parts.push(
      '',
      '## Approved Plan (EXECUTE THIS — do not redesign)',
      '',
      objective.approved_plan,
      '',
      'You are now in the Execute phase. Follow the plan above. If you discover the plan is wrong, STOP and report back to Operator with the conflict instead of silently deviating.',
    )
  }

  // AI Review pushback — when a reviewer failed the worker, its findings live
  // in `ai_review_findings` and we re-spawn the worker via sendFollowUp (which
  // appends the findings as a follow-up message). For the initial worker spawn,
  // findings will be null. For subsequent resumes from a failed AI review, the
  // findings get prepended here so the worker sees them up front.
  if (objective.ai_review_findings && objective.ai_review_verdict === 'fail') {
    // PR-gated harness loop: when structured criteria_results exist for the latest
    // review, render a failing-criteria table ABOVE the free-text findings so the
    // worker gets precise repro/expected/actual per failing criterion. Falls back to
    // the historical free-text-only behavior for non-PR objectives (or no structured
    // results). Additive — the free-text findings always still follow.
    const structured = objective.pr_number ? buildFailingCriteriaSection(objective.id) : ''
    if (structured) {
      parts.push('', structured)
    }
    parts.push(
      '',
      '## Prior AI Review Findings (you are being respawned to address these)',
      '',
      objective.ai_review_findings,
    )
  }

  // Completion goal — hard criterion the session must meet before declaring done.
  //
  // obj 708817: the human create form no longer collects a completion goal, so
  // `completion_goal` is legitimately NULL for every UI-created objective (it is
  // still set by delegator children via POST /api/internal/objectives). Rather
  // than silently dropping the section — which left the prompt with no stated
  // definition of done at all — the null case emits an explicit fallback that
  // names the title + description as the bar. Never an empty or half-written
  // '## Completion Goal (HARD REQUIREMENT)' heading.
  if (objective.completion_goal) {
    parts.push(
      '',
      '## Completion Goal (HARD REQUIREMENT)',
      '',
      'Do NOT declare this objective done until the following criterion is met:',
      objective.completion_goal,
      '',
      'If you cannot meet this criterion, explain why in your final response.',
    )
  } else {
    parts.push(
      '',
      '## Completion Goal (HARD REQUIREMENT)',
      '',
      'No separate completion goal was supplied for this objective. The definition of done is the objective itself:',
      `deliver exactly what the title ("${objective.title}") and the description above ask for, in full.`,
      '',
      'Do NOT declare this objective done until every part of that request is delivered and verified. If you cannot deliver part of it, explain why in your final response.',
    )
  }

  // Acceptance criteria — the concrete, testable rubric a fresh-context adversarial
  // reviewer will grade this worker against before it can complete (QW1 / audit W4).
  // Surfacing it up front lets the worker self-check against the actual gate instead
  // of discovering it only after a failed review. Graceful no-op when none authored.
  // acceptance_criteria can reach buildPrompt in TWO shapes: a parsed
  // AcceptanceCriterion[] (mapped rows) OR the raw JSON string stored in SQLite
  // (raw rows passed straight through by startSession / sendFollowUp). A raw
  // string passes a `.length` truthy check but `.map()` throws TypeError — and
  // because this runs inside async route handlers with no try/catch, that throw
  // becomes an unhandled rejection that crash-loops the whole server (obj 1180:
  // every follow-up/nudge to any of the ~515 criteria-bearing objectives took
  // the process down → 502s + blank logs). Normalize to an array first.
  let criteria: unknown = objective.acceptance_criteria
  if (typeof criteria === 'string') {
    try { criteria = JSON.parse(criteria) } catch { criteria = null }
  }
  if (Array.isArray(criteria) && criteria.length > 0) {
    parts.push(
      '',
      '## The bar you are graded against (acceptance criteria)',
      '',
      'Before you can complete, a fresh-context adversarial reviewer will grade your work against EXACTLY these criteria. Treat each as a hard requirement and self-check against it before declaring done:',
      '',
      '**When a criterion names a specific proof ARTIFACT, satisfy it by PRODUCING that artifact — not by arguing your code is correct.** The reviewer greps for the exact artifact the criterion demands (a pasted API round-trip, a signed URL returning HTTP 200 + the report that prints it, an actually-open PR *URL*, per-role DISTINCT screenshots) and FAILS you if it is absent, merely self-asserted, or contradicted — even when your code is genuinely correct. "The code is right, trust me" is not acceptance. A report that says "PR opened" with no URL fails. One screenshot reused across roles (byte-identical files) is a hard fail — each per-item proof must be genuinely distinct. Run the command, paste its literal output, and verify each named artifact actually exists before you declare done.',
      '',
      '**The proof must be YOURS and land on YOUR branch — never re-attribute or splice in a sibling objective\'s artifact.** If a criterion\'s deliverable (a file, migration, normaliser, PR, or verdict) already exists on a SIBLING objective\'s branch/PR, that does NOT satisfy YOUR criterion — the reviewer greps YOUR branch and finds it empty. Do not copy the sibling\'s file into your report, write "see obj NNNN / deferred to obj NNNN," or present the sibling\'s table/verdict as your own. If you discover your work was already shipped by a twin (your branch is byte-identical to `main`) or your deliverable landed on a twin\'s branch, STOP and report `outcome` BLOCKED naming the collision — do NOT manufacture a passing-looking report from the twin\'s output.',
      '',
      '**Every `file:line` CITATION must resolve at the GRADED ref AND actually say what you claim.** The reviewer does not `ls` your working tree — it reads your branch/PR head and `main` (`git ls-tree`, `git show <ref>:path`). A file that exists only as an uncommitted/untracked file in your worktree — or, worse, a leftover in a SIBLING objective\'s worktree on the shared filesystem — is INVISIBLE to the reviewer, so a citation to it FAILS even though `ls` from your session finds it (obj 708381: a gate-enumeration table cited `workers/mls_reconciler/reconciler.py:32-44`, a file absent from the PR head and `main`, present only as obj 708383\'s untracked leftover; a linked pytest "passed" locally for the same reason). Before you cite `path:line`: confirm it is committed on YOUR branch (`git ls-files <path>` non-empty AND `git show HEAD:<path>` succeeds), then RE-OPEN it and confirm that line says what you assert — a citation to a source whose content contradicts your claim is a hard fail (obj 708111: cited `706719/NOTES.md` for a send-ledger figure; that file actually reads "0 new CSV rows delivered … blocked on Telnyx funding").',
      '',
      ...(criteria as AcceptanceCriterion[]).map(
        (c) => `- [${c.id}] ${c.criterion} (type: ${c.type}, verify via: ${c.method})`,
      ),
    )
  }

  // Workflow hint — suggest a Dynamic Workflow pattern for complex tasks
  if (objective.workflow_hint) {
    const workflowDescriptions: Record<string, string> = {
      'fan-out': 'Fan-out-and-synthesize: split into independent chunks, process in parallel subagents, merge.',
      'adversarial': 'Adversarial verification: a fresh-context agent reviews the work critically.',
      'tournament': 'Tournament ranking: generate multiple candidates, compare pairwise to pick a winner.',
      'loop-until-done': 'Loop until done: keep iterating until a hard stop condition is met.',
      'classify-and-act': 'Classify-and-act: classify the work into subtypes, route each to the right handler.',
    }
    const description = workflowDescriptions[objective.workflow_hint] || objective.workflow_hint
    parts.push(
      '',
      '## Recommended Workflow Pattern',
      '',
      description,
      '',
      'Use this pattern to structure your work. If the task is simple enough that a single-context approach works, say so and proceed directly.',
    )
  }

  // Git workflow — every project-scoped session is isolated into a pre-created
  // worktree (obj 1059). The server creates the worktree BEFORE spawn and starts
  // the shell INSIDE it; the live checkout is never the cwd, and a PreToolUse
  // guard hard-blocks any Edit/Write to the live tree. `create_pr` + parent
  // linkage decide only how the branch INTEGRATES (own PR vs merge into a
  // parent's PR), not whether files are isolated.
  if (objective.project) {
    const branchName = deriveWorktreeBranchName(objective) as string
    const worktreePath = `/tmp/cc-worktree-${objective.id}`
    // Display-only: the live-checkout path used in the "FORBIDDEN to edit" text.
    // The real fail-closed enforcement is the spawn path (computeIsolation /
    // ensureWorktree / startSession), which runs resolveWorkdir BEFORE buildPrompt;
    // by the time we render the prompt it has already resolved. Don't let the
    // fail-closed throw (obj 1451) escape from prompt rendering — fall back to a
    // plausible path for the message text only.
    let projectDir: string
    try {
      projectDir = resolveWorkdir(objective)
    } catch {
      projectDir = `${PROJECTS_DIR}/${objective.project}`
    }

    const githubRepo = resolveGithubRepo(objective)
    const prCreateCmd = githubRepo
      ? `gh pr create --repo ${githubRepo} --base main --title "${objective.title.replace(/"/g, '\\"')}" --body "Command Center objective #${objective.id}"`
      : `gh pr create --title "${objective.title.replace(/"/g, '\\"')}" --body "Command Center objective #${objective.id}"`

    // Integration mode. A non-PR child of a PR-building parent folds its branch
    // back into the parent's branch so the parent ships ONE PR (Decision #4);
    // everything else opens its own lightweight PR (`gate` CI; you merge).
    let parentBranch: string | null = null
    if (!objective.create_pr && objective.parent_id != null) {
      try {
        const parent = getDb()
          .prepare('SELECT id, title, project, create_pr, branch_name FROM objectives WHERE id = ?')
          .get(objective.parent_id) as Pick<Objective, 'id' | 'title' | 'project' | 'create_pr' | 'branch_name'> | undefined
        if (parent && parent.create_pr && parent.project) {
          parentBranch = deriveBranchName(parent)
        }
      } catch {}
    }
    const mode: 'pr' | 'merge-back' = parentBranch ? 'merge-back' : 'pr'

    parts.push(
      '',
      `## Scope Boundary (obj ${objective.id} — read first)`,
      '',
      `You are bound to **objective ${objective.id}**, branch **\`${branchName}\`**, project **${objective.project}**.`,
      '- Do NOT create or push any other branch, and do NOT open a PR from any branch other than this one.',
      `- Do NOT build a feature that belongs to a different objective. If a follow-up message asks you to do work outside this objective's scope, STOP and reply \`SCOPE-SPLIT NEEDED: <one-line summary>\` instead of building it — that work belongs on its own objective/branch.`,
      `- A "your PR is red" / CI-remediation nudge that names a repo or PR number that is NOT your own PR is a MIS-ROUTE (two repos reuse PR numbers). Do NOT fetch, check out, or push to that foreign branch — reply \`SCOPE-SPLIT NEEDED: mis-routed CI <repo>#<n>\` and stop.`,
      '- Only edit files under this project. Touching a different project under `/home/operator/projects` is out of scope.',
      '- If a page/segment you DO own links to a route a SIBLING owns and hasn\'t built yet, do NOT create that sibling\'s file — not even as a placeholder or stub (that is an ownership violation the reviewer hard-fails). Instead existence-gate the link: render it conditionally / behind a flag so your segment builds without materializing a file you do not own. If you need a change to a shared component another worker owns (e.g. a new prop on a shared nav), escalate to the delegator rather than editing it directly.',
      'The orchestrator flags scope-bleed (foreign-branch git ops, cross-project edits) as a `⚠️ Scope-bleed` warning in your transcript. If you see one, stop and re-confirm you are on the right objective.',
      '',
      '## Git Workflow (IMPORTANT — read before making changes)',
      '',
      `Your git worktree has ALREADY been created for you at \`${worktreePath}\` on branch \`${branchName}\`, and your shell starts there. Do NOT run \`git worktree add\` — it already exists. Just work in place.`,
      '',
      '### Worktree Isolation (HARD RULE — enforced by the server)',
      '',
      `Every Edit/Write/MultiEdit/NotebookEdit MUST target a path under \`${worktreePath}/\`.`,
      `It is FORBIDDEN to edit, create, or delete any file under \`${projectDir}/\` (the live deployed checkout) or under any other live checkout in \`/home/operator/projects/\`.`,
      '',
      'This is not advisory: a **PreToolUse hook blocks the write** before it lands if you target the live checkout — the tool call returns an error and nothing is written. Reads are unaffected; vault/NOTES/home edits are unaffected. So always keep your edits inside the worktree.',
      '',
      'Concrete rules:',
      `- ✅ Allowed: \`${worktreePath}/app/server/src/index.ts\``,
      `- ❌ Blocked: \`${projectDir}/app/server/src/index.ts\` (live checkout — the hook denies this write)`,
      '- ❌ Avoid relative paths unless your cwd is the worktree (it starts there). Prefer absolute paths under the worktree.',
      '',
      'Why this matters: a session once edited `index.ts` in the live checkout to import a file that only existed inside its worktree. When the worktree was cleaned up the import target vanished and the deployed server crash-looped. Isolation makes that impossible.',
      '',
      '**Do your work inside the worktree.** Make changes, test, verify.',
    )

    if (mode === 'merge-back') {
      parts.push(
        '',
        `### Integration — fold into your parent's PR (you are a child of objective ${objective.parent_id})`,
        '',
        `Your branch \`${branchName}\` is based off your parent's branch \`${parentBranch}\`. Your parent objective collects all of its children into ONE pull request — so you do NOT open your own PR.`,
        '',
        '**When your work is complete:**',
        '```bash',
        'git add -A',
        'git commit -m "your descriptive message"',
        `git push -u origin ${branchName}`,
        '```',
        '',
        '**Before you report done — PROVE the branch actually carries your work (do NOT skip):**',
        '```bash',
        'git status --porcelain                         # MUST print nothing — a dirty tree = uncommitted work',
        `git rev-list --count ${parentBranch}..HEAD      # MUST be > 0 — zero commits = nothing to fold`,
        '```',
        'If the tree is dirty or the commit count is 0, your deliverable lives ONLY in the worktree and is INVISIBLE to your parent and the reviewer — you have delivered NOTHING. Commit and push before finishing. If you genuinely cannot commit (e.g. a shared-worktree/concurrent-writer conflict), report `outcome` as BLOCKED with that reason — do NOT report success.',
        'NEVER write "PR opened", "staged in a PR", or "tests pass" in your session summary unless you actually ran the command and saw it succeed. A claim without the artifact is a false completion and the reviewer WILL hard-fail it.',
        '',
        `Then report your branch so the parent can integrate it:`,
        '```bash',
        `curl -s -X POST http://localhost:3002/api/internal/pr-created -H 'Content-Type: application/json' -d "{\\"objective_id\\":${objective.id},\\"branch_name\\":\\"${branchName}\\",\\"pr_url\\":\\"\\"}"`,
        '```',
        '',
        'Do NOT run `gh pr create`. Do NOT merge into the parent branch yourself — the parent serializes all child merges into its single PR (concurrent children merging the same branch would conflict).',
      )
    } else {
      parts.push(
        '',
        '### Integration — open a pull request (the branch firewall)',
        '',
        'Your work reaches production ONLY through a merged PR — never by editing the live tree. Broken code on your branch cannot touch the running server until the PR is green and merged.',
        '',
        '**When your work is complete, commit, push, and open a PR:**',
        '```bash',
        'git add -A',
        'git commit -m "your descriptive message"',
        `git push -u origin ${branchName}`,
        prCreateCmd,
        '```',
        '',
        '**If any `gh` command fails with `401`/`Bad credentials`:** the per-user GitHub token injected into your env (`GH_TOKEN`/`GITHUB_TOKEN`, for PR attribution) is stale. Do NOT unset it globally — retry only the failing call with the bot token by prefixing `env -u GH_TOKEN -u GITHUB_TOKEN` (a valid token lives in `/etc/gh/hosts.yml`). This also applies to the `gh pr view` calls in the verification block below.',
      )
      // A delegator parent (create_pr=1) aggregates its children's branches into
      // this one PR before opening it.
      if (objective.create_pr && objective.delegate_mode) {
        parts.push(
          '',
          'Because you are a delegator parent, FIRST integrate your completed children. Each code-producing child pushes a branch `cc/obj-<childId>-<slug>` based off your branch and reports it via the pr-created callback (visible to you as `branch_name`). Before opening your PR, merge each child branch into your branch from inside your worktree:',
          '```bash',
          'git fetch origin --quiet',
          'git merge --no-edit origin/cc/obj-<childId>-<slug>   # repeat per completed child; resolve any conflicts',
          '```',
          'Then commit (if a merge added anything), push, and open the single PR above.',
        )
      }
      parts.push(
        '',
        '**Before you report done — PROVE the PR actually exists (do NOT skip):**',
        '```bash',
        'git status --porcelain                    # MUST print nothing — a dirty tree = uncommitted work',
        'git rev-list --count origin/main..HEAD    # MUST be > 0 — zero commits = no PR is possible',
        'gh pr view --json url -q .url             # MUST print a real URL, not empty',
        '```',
        'If the tree is dirty, the commit count is 0, or `gh pr view` is empty, there is NO PR — your work has not shipped. Commit, push, and open the PR before finishing. If you genuinely cannot commit (e.g. a shared-worktree/concurrent-writer conflict), report `outcome` as BLOCKED with that reason — do NOT report success.',
        'NEVER write "PR opened", "staged in a PR", or "tests pass" in your summary unless you ran the command and can paste its output (the real PR URL; the literal test/typecheck output). A claim without the artifact is a false completion the reviewer WILL hard-fail.',
        '',
        '**Then report the PR URL back:**',
        '```bash',
        `PR_URL=$(gh pr view --json url -q .url 2>/dev/null)`,
        `curl -s -X POST http://localhost:3002/api/internal/pr-created -H 'Content-Type: application/json' -d "{\\"objective_id\\":${objective.id},\\"branch_name\\":\\"${branchName}\\",\\"pr_url\\":\\"$PR_URL\\"}"`,
        '```',
        '',
        'The PR is gated by GitHub Actions job `gate` (typecheck, unit tests, build). That is the lock. An adversarial review may also run; it is extra, not the merge requirement. You merge when `gate` is green. Broken code cannot reach the running server until the PR merges.',
      )
    }
  }

  // Design-context injection (Wave B) — placed AFTER the worktree block (so the
  // worktree path rules are already established: the worker styles inside the
  // worktree, not the live checkout) and BEFORE the vault-capture block.
  //
  // Double-gated, both conditions required:
  //   1. isUiInjectionActive(objective) — the FILE-backed, per-platform gate resolves
  //      this objective's project to a non-'off' mode (`.ui-gate.json` allowlist, env
  //      `UI_GATE_MODE` fallback, default 'off'). With the file absent + env unset, or
  //      mode 'off', or a project outside a non-empty allowlist, this short-circuits so
  //      EVERY prompt is byte-identical to pre-activation behavior. This is the dormancy
  //      guarantee. Shares the control-plane with the reviewer half (session-manager.ts),
  //      so a single live file write turns conditioning on for the chosen platforms.
  //   2. isUiObjective()   — the objective's project is registered in
  //      .design-registry.json OR it carries a visual/browser criterion. Non-UI and
  //      unregistered-repo objectives get no block even once the gate is active.
  if (isUiInjectionActive(objective) && isUiObjective(objective)) {
    parts.push('', ...buildDesignContextBlock(objective))
  }

  parts.push('', 'Knowledge base is at ~/second-brain/ for reference.')

  // Vault Capture (MANDATORY) — workspace-aware path, forced "no capture" escape clause.
  // Without this block in the spawn prompt, sessions skip Phase 6 of the pipeline silently.
  const vaultDir = !workspace || workspace === 'personal'
    ? '~/second-brain/personal/decisions/'
    : `~/second-brain/workspaces/${workspace}/decisions/`
  parts.push(
    '',
    '## Vault Capture (MANDATORY before you finish)',
    '',
    'If this session produced any architectural decision, evaluation outcome, research finding,',
    'tradeoff resolved, or non-obvious learning that future sessions would benefit from, you MUST',
    `write a decision doc to ${vaultDir}YYYY-MM-DD-<slug>.md before ending the session.`,
    '',
    'Use the template at ~/ai-workspace/protocols/vault-capture.md (frontmatter + Decision /',
    'Context / Rationale / Alternatives / Implications sections).',
    '',
    'If nothing in this session qualifies (e.g. routine bug fix, mechanical cleanup, no choices',
    'made), explicitly state in your final response: "No vault capture: <one-line reason>".',
    'Do NOT silently skip — the orchestrator now flags `capture-gap` when decisions are claimed',
    'in the summary but no `/decisions/*.md` write occurred.',
  )

  // Jobs disposition — routine-spawned objectives ("jobs") must record an
  // end-of-run disposition so they land in the right lane on the Jobs board.
  if (objective.routine_id != null) {
    parts.push(
      '',
      '## Jobs Disposition (REQUIRED — you are an automated daily job)',
      '',
      'This run is a scheduled **job**, logged on the Jobs board (not the main Board). As the FINAL step of your run, record your disposition so Operator can triage at a glance:',
      '',
      '```bash',
      '# Clean run, nothing for Operator to do:',
      `curl -s -X POST http://localhost:3002/api/internal/objectives/${objective.id}/job-disposition \\`,
      "  -H 'Content-Type: application/json' \\",
      `  -d '{"disposition":"complete"}'`,
      '',
      '# You have a question, OR you saw a concrete way to improve our system:',
      `curl -s -X POST http://localhost:3002/api/internal/objectives/${objective.id}/job-disposition \\`,
      "  -H 'Content-Type: application/json' \\",
      `  -d '{"disposition":"needs_review","note":"<one-line reason Operator should look>"}'`,
      '```',
      '',
      'Use `needs_review` only when you genuinely want Operator\'s attention (a question, a decision, or a system-improvement opportunity you noticed while running). Otherwise use `complete`.',
      '',
      `If Operator later replies in this thread asking you to "create an objective for X", create it with \`POST http://localhost:3002/api/internal/objectives\` (a JSON array of objective objects). Include \`"source_job_id":${objective.id}\` on each so the new card links back to this job. Then reply telling Operator the new objective id(s). Example:`,
      '```bash',
      `curl -s -X POST http://localhost:3002/api/internal/objectives \\`,
      "  -H 'Content-Type: application/json' \\",
      `  -d '[{"title":"<objective>","description":"<full self-contained brief>","agent_context":"${objective.agent_context}","workspace":"${objective.workspace}","type":"project","source_job_id":${objective.id}}]'`,
      '```',
    )
  }

  if (context) {
    parts.push('', context)
  }
  return parts.join('\n')
}
