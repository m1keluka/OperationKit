/**
 * AI-reviewer prompt + Playwright MCP config — extracted from session-manager.ts
 * (behavior frozen). Pure prompt builder; spawn stays in session-manager.
 */
import fs from 'fs'
import path from 'path'
import type { Objective } from '@command-center/shared'
import { getDb } from '../db/index.js'
import { classifyObjectiveRepo } from './objective-prs.js'
import { PR_LINKAGE_REPO } from './pr-linkage.js'
import { getEffectiveGateMode, buildVisionRubricBlock, isBackendOnlyChange, type UiGateMode } from './design-context.js'
import { maskWorkerScratch, buildReviewerArtifactBlock } from './prompt-builder.js'

const TMUX_SCRIPT_DIR = process.env.CC_SCRIPT_DIR || '/tmp/cc-scripts'

export function buildReviewerPrompt(
  objective: Objective,
  filesTouched: string[],
  testCred: { slug: string; loginUrl: string; fieldNames: string[] } | null,
  isDelegatorWorker = false,
  // EFFECTIVE mode for THIS objective's project: file-backed config + per-platform
  // allowlist, env (UI_GATE_MODE) as fallback, default 'off'. Replaces the raw global
  // read so 'advisory on example-project only' is expressible without a restart. With
  // no file and UI_GATE_MODE unset this is 'off' ⇒ prompt byte-identical to Wave A.
  gateMode: UiGateMode = getEffectiveGateMode(objective.project)
): string {
  const planSection = objective.approved_plan
    ? `## Approved Plan\n\n${maskWorkerScratch(objective.approved_plan)}\n\nVerify each acceptance criterion against the implementation.`
    : '## Approved Plan\n\n(none — bug or task; use the description, plus the completion goal when one is set, as the acceptance bar)'

  // The state-poller increments this BEFORE spawning, so iter is 1+ here.
  const iteration = Math.max(1, objective.ai_review_iteration || 1)
  // A delegator pre-supplies its worker's acceptance_criteria at creation time, so
  // the rubric is already locked — the reviewer loads it instead of generating one,
  // even on iteration 1. Review is then graded against the delegator's intended scope.
  const isFirstPass = iteration === 1 && !objective.acceptance_criteria
  const criteriaUrl = `http://localhost:3002/api/internal/reviews/${objective.id}/criteria`

  // ── Acceptance-criteria rubric flow ──────────────────────────────────────
  // Iteration 1: reviewer must generate a 3-7-item rubric and POST it to the
  // internal endpoint. The server locks the rubric onto the objective so
  // iteration 2 and 3 cannot diverge.
  // Iteration 2+: reviewer must GET the locked rubric and only test against
  // those items — no new bar may be invented.
  const rubricSection = isFirstPass
    ? [
        '## Step 0 — Generate and lock the acceptance criteria (FIRST PASS ONLY)',
        '',
        `This is iteration ${iteration}. Before running any verification you MUST:`,
        '',
        '1. Read the plan / description / completion goal above.',
        '2. Draft 3-7 acceptance criteria — concrete, testable, with no overlap. Each criterion needs:',
        '   - `id`: short kebab-case identifier (e.g. "login-redirect")',
        '   - `criterion`: one-sentence statement of what must be true',
        '   - `type`: one of "functional" | "visual" | "data"',
        '   - `method`: one of "browser" | "api" | "doc" — how YOU will verify it',
        '',
        '   DO NOT author any criterion that depends on PR LIFECYCLE state — i.e. that the',
        '   branch is pushed, that a PR is open, that CI/commit-status checks are green, or',
        '   that the PR is merged. Your review IS the gate those steps pass through: PR',
        '   creation is the worker’s final step (it can lag your spawn by minutes), CI runs',
        '   after the PR, and merge is owner-driven / auto-merge-on-green — all DOWNSTREAM of',
        '   this review. Grade the DELIVERABLE (does the code on the worker’s branch satisfy',
        '   the objective; does it typecheck; do its own tests pass). Never make "PR merged"',
        '   or "PR opened" an acceptance bar.',
        '3. POST the rubric to the internal endpoint to lock it:',
        '',
        '   ```bash',
        `   curl -s -X POST ${criteriaUrl} \\`,
        '     -H "Content-Type: application/json" \\',
        '     -d \'{"criteria":[{"id":"...","criterion":"...","type":"functional","method":"browser"}, ...]}\'',
        '   ```',
        '',
        '   A 201 means accepted. A 409 means another reviewer already locked it — the response body contains the existing rubric; use that.',
        '',
        '   READ THE RESPONSE FROM STDOUT. Reviewer sessions all run as the same OS user and',
        '   SHARE `/tmp`, so NEVER write the rubric to a fixed scratch path like `/tmp/crit.json`:',
        '   a concurrent review leaves ITS rubric there, and `curl -o` does NOT truncate the file',
        '   when the fetch fails (server mid-restart ⇒ HTTP `000`), so you would silently read a',
        `   SIBLING objective's rubric. If you must persist it, use an id-scoped filename`,
        `   (\`/tmp/crit-${objective.id}.json\`) and use \`curl -fsS\` so a failed fetch exits non-zero.`,
        '4. Only then proceed to the verification steps below.',
      ].join('\n')
    : [
        `## Step 0 — Load the locked acceptance criteria (iteration ${iteration})`,
        '',
        'A previous iteration locked the rubric. You MUST fetch it and test against the same items — do not invent new bars or change wording.',
        '',
        '   ```bash',
        `   curl -fsS ${criteriaUrl}`,
        '   ```',
        '',
        'Read the rubric FROM STDOUT and parse it inline. Reviewer sessions all run as the same OS',
        'user and SHARE `/tmp`, so **never fetch it into a fixed scratch path like `/tmp/crit.json`**:',
        'a concurrent review leaves ITS rubric there, and `curl -o` does NOT truncate the file when the',
        'fetch fails (server mid-restart ⇒ HTTP `000`), so you would silently grade against a SIBLING',
        `objective's criteria. If you must persist it, use an id-scoped filename`,
        `(\`/tmp/crit-${objective.id}.json\`) — and \`curl -fsS\` so a failed fetch exits non-zero instead`,
        'of leaving you with stale bytes.',
        '',
        `The response is \`{"criteria": [...]}\`. VERIFY the fetch before you trust it: \`curl -fsS\` must`,
        `exit 0 and the body must be non-empty JSON for objective ${objective.id}. Sanity-check that the`,
        'returned criteria plausibly describe THIS objective — if the ids reference work you were not',
        'asked to review, you are holding a stale/foreign rubric.',
        '',
        '**A failed fetch or a stale/mismatched rubric is a RE-FETCH condition, NOT a block.** Wait a few',
        'seconds and re-run the command (the server may be restarting); retry a handful of times. Only',
        'emit `<verdict>blocked</verdict>` when the endpoint is reachable (curl exits 0) and it still',
        'returns `criteria: null` for your objective — then explain the missing rubric in `<findings>`.',
      ].join('\n')

  // ── Test credentials (optional) ──────────────────────────────────────────
  const credSection = testCred
    ? [
        '## Test credentials (already in your environment)',
        '',
        `Login URL: \`TESTCRED_LOGIN_URL\` (= ${testCred.loginUrl})`,
        'Available fields (read from the env block):',
        ...testCred.fieldNames.map(n => `- \`TESTCRED_${n.toUpperCase()}\``),
        '',
        'Use these when the rubric needs you to log into the deliverable. Never echo credential values into your transcript — reference them by env var name only.',
      ].join('\n')
    : ''

  // ── Mode hint ─────────────────────────────────────────────────────────────
  // The state-poller parses <mode> too, so emit it alongside the verdict.
  const modeSection = [
    '## Mode (emit alongside verdict)',
    '',
    'Choose the mode that matches how you actually verified:',
    '- `browser` — drove Playwright MCP against a UI',
    '- `api` — hit HTTP endpoints with curl/fetch',
    '- `doc` — verified a document/decision/report only',
    '- `noop` — research-only deliverable with no testable surface (auto-pass)',
    '',
    'Emit as `<mode>browser</mode>` (or api/doc/noop) anywhere in your final message.',
  ].join('\n')

  // ── Adversarial stance ────────────────────────────────────────────────────
  // You are NOT a second optimist. The worker already believes its work is done;
  // your job is the opposite — to find the ways it is broken. Default to fail and
  // make the work earn a pass with concrete evidence, not prose.
  const adversarialSection = [
    '## Your stance: adversarial verifier (READ THIS FIRST)',
    '',
    'You are NOT a second pair of friendly eyes. The worker already concluded its work is done — your job is to disprove that. Adopt the mindset of a skeptical reviewer who expects to find the work broken.',
    '',
    '- **Assume the work is BROKEN until proven otherwise.** The burden of proof is on the deliverable, not on you. Do not extend the worker the benefit of the doubt.',
    '- **DEFAULT to a `fail` verdict** (or `blocked` when you genuinely cannot verify). A criterion only earns `[PASS]` when you hold concrete evidence in hand. Absence of evidence is a FAIL, not a pass.',
    '- **Under ANY uncertainty, missing evidence, or ambiguity → fail.** "Looks plausible", "the code appears to…", "should work", and "the worker says…" are NOT verification. If you are not sure, the answer is fail.',
    '- **Each acceptance criterion requires a CONCRETE ARTIFACT** to pass — one of:',
    '  - a quoted command output (the actual stdout/stderr you ran read-only, pasted verbatim),',
    '  - a specific `file:line` reference you read and that demonstrably satisfies the criterion,',
    '  - a screenshot path you captured via Playwright, or',
    '  - an actual API response body you observed.',
    '  A prose claim with no artifact behind it = FAIL for that criterion. Restating the worker\'s summary is not evidence.',
    '- **Mechanism-fallback for `method:browser` VISUAL/LAYOUT criteria (applies to UI PRs too):** when a `browser` criterion\'s screenshot/preview artifact is genuinely UNOBTAINABLE in your environment — the worker had no Playwright AND you cannot stand up a seeded/authed preview that actually exhibits the required state — do NOT auto-fail solely for the missing screenshot. Instead verify by MECHANISM: read the governing CSS/DOM at `file:line` and decide whether it structurally satisfies the criterion (e.g. `height:100dvh` + portal-to-body makes a drawer\'s height independent of list length). Grade PASS or FAIL on that mechanism evidence and label the line `verified by mechanism (browser not driven: <one-line why>)`. This fallback is ONLY for visual/layout criteria whose satisfaction is fully determined by readable code — a FUNCTIONAL claim you cannot exercise end-to-end (a flow genuinely works) still DEFAULTS to fail.',
    '- Do not invent reasons to pass. If you find yourself reaching for an excuse to mark something passed, mark it failed.',
  ].join('\n')

  // ── PR lifecycle is downstream of your review (obj 700481/700538/700542) ──
  // The reviewer once raced ahead of the worker's final push+PR (PR appeared
  // 1.5–4 min after a "no PR exists" FAIL) and authored an unsatisfiable
  // "PR merged" criterion — merge is owner-driven and happens AFTER a passing
  // review. Neither is legitimately gradable here; forbid both.
  const prLifecycleSection = [
    '## PR lifecycle is DOWNSTREAM of your review — do not grade it',
    '',
    'Your review is the gate a PR passes through. Therefore:',
    '- The absence of a PR is NEVER grounds for `fail`. PR creation (`git push` +',
    '  `gh pr create`) is the worker’s LAST step and routinely completes 1–4 minutes',
    '  AFTER you are spawned. If the worker’s branch/worktree has commits that satisfy',
    '  the rubric but no PR is visible yet, grade the CODE. If a PR link is genuinely',
    '  required to verify a criterion, emit `<verdict>blocked</verdict>` (re-checked on',
    '  retry) — NOT `fail`, which reads as "the worker did no work."',
    '- A PENDING or absent CI / `gate` check is NOT a `fail`. Those checks',
    '  run after the PR and are gated by this review, not the other way around.',
    '- "PR merged" is NEVER a valid criterion. Merge is owner-driven / auto-merge-on-green',
    '  and happens only AFTER a passing review — it cannot be true while you grade.',
    '- Grade the deliverable on the worker’s branch/worktree (see the section below on',
    '  where the deliverable lives), not the PR’s GitHub state.',
  ].join('\n')

  // ── UI/UX vision gate (Wave C) ────────────────────────────────────────────
  // Returns '' (dropped by the filter(Boolean) below) when the gate is `off`, the
  // objective is not a UI objective, OR this PR touches no client/UI files (obj 1453,
  // via filesTouched) — making the off-mode prompt byte-identical to the Wave A
  // foundation. Non-empty only for advisory/soft/hard on UI work that actually edits UI.
  const uiRubricSection = buildVisionRubricBlock(objective, gateMode, isDelegatorWorker, filesTouched)

  // ── Backend-only PR notice (obj 1453) ─────────────────────────────────────
  // When the change touches no UI file we ALSO strip visual/ds-* bars from the locked
  // rubric the reviewer fetches (GET /api/internal/reviews/:id/criteria does the strip).
  // Tell the reviewer explicitly so it grades correctness/tsc/tests and does not go
  // hunting for a screen to render — that hunt is what caps backend PRs out at 3/3 FAIL.
  const backendOnlyNotice = isBackendOnlyChange(filesTouched)
    ? [
        '## Backend-only change — visual criteria are NOT applicable',
        '',
        `This PR touches ${filesTouched.length} file(s), NONE of them client/UI files (nothing under`,
        'app/client/ or other frontend paths). It has no screen to render. Accordingly:',
        '- Any visual / ds-* / screenshot criterion (type:"visual", method:"browser"/"static", or a',
        '  `ds-*` id) is N/A and has been removed from your locked rubric — do NOT re-introduce one,',
        '  and do NOT fail the verdict for the absence of a rendered screen or screenshot.',
        '- Grade ONLY correctness: the diff satisfies the objective, it typechecks, and the',
        '  GitHub Actions `gate` job is green. Use `doc`/`api` verification, not `browser`.',
        '- Emit `<mode>doc</mode>` (or `api`) — `browser` mode is not expected here.',
      ].join('\n')
    : ''

  // ── PR-gated test-agent scenario (harness loop) ───────────────────────────
  // Only present when objective.pr_number is set. The reviewer becomes a human
  // test-agent driving the LIVE PREVIEW deployment via Playwright — it must NOT
  // grade the diff. Emits a machine-readable <criteria_results> block (parsed by
  // the state-poller) plus <screenshot_paths>/<artifact_paths> for evidence.
  //
  // obj 704718 — `pr-<n>.cc.example.com` is the preview host for PR_LINKAGE_REPO
  // ONLY, and `pr_number` is not repo-scoped (obj 2040 carries 202 for example3, 702028
  // carries 245 for example-project — both colliding with cc-infra numbers). Keying the
  // preview URL on the bare number sends the reviewer to a cc-infra preview host for an
  // unrelated repo's PR: it either grades the wrong application or, more often, finds
  // nothing there and returns `blocked` — a RED required status on a PR whose code is
  // fine. Suppressed only when the objective is demonstrably in ANOTHER repo: an
  // `unknown` repo is the normal state of a fresh cc-infra worker whose PR has not been
  // recorded yet, and withholding test-agent mode there would change how every such
  // review is conducted to dodge a hazard that only exists for a KNOWN foreign repo.
  // An explicit PREVIEW_BASE_URL is an operator override and still wins.
  // `buildReviewerPrompt` is a pure prompt builder that its unit tests call with no
  // initialised database, so the repo check must degrade to pr_url/project rather than
  // throw. A missing DB only costs us the `objective_prs` fallback.
  const tryGetDb = () => { try { return getDb() } catch { return null } }
  const previewOverride = process.env.PREVIEW_BASE_URL
  const previewIsForThisObjective =
    !!previewOverride || classifyObjectiveRepo(tryGetDb(), objective, PR_LINKAGE_REPO) !== 'other'
  const previewBaseUrl = previewOverride || `https://pr-${objective.pr_number}.cc.example.com`
  const testAgentSection = objective.pr_number && previewIsForThisObjective && !isBackendOnlyChange(filesTouched)
    ? [
        '## TEST-AGENT MODE (PR preview — DRIVE THE APP, DO NOT READ THE DIFF)',
        '',
        `This objective has an open PR (#${objective.pr_number}) deployed to a live preview at:`,
        '',
        `    ${previewBaseUrl}`,
        '',
        'Seeded login (present in every preview DB):',
        '- username: `mike`',
        '- password: `changeme`',
        '',
        'Your verdict MUST be grounded in what you OBSERVE in the running browser, not in reading the source diff.',
        'You are a human user exercising the deployed app. Use the Playwright tools: `browser_navigate`,',
        '`browser_type`, `browser_click`, `browser_take_screenshot`, `browser_console_messages`.',
        '',
        'Run AT LEAST ONE real end-to-end scenario against the preview:',
        `1. \`browser_navigate\` to ${previewBaseUrl} and log in with the seeded creds above.`,
        '2. Create a new objective through the UI.',
        '3. Verify it appears on the board.',
        'Take a `browser_take_screenshot` at each meaningful step as evidence. If the PR clearly changes a',
        'DIFFERENT primary flow, adapt the scenario to exercise that flow instead — but it MUST be a real',
        'user flow against the running preview, with screenshots as evidence.',
        '',
        'ANTI-CHEAT (hard rules):',
        '- Do NOT edit application code or test files. Your job is to USE the app, not change it.',
        '- Do NOT base your verdict on the diff. Every PASS/FAIL must cite what you saw in the browser.',
        '- Save the browser console output via `browser_console_messages` to a file and reference its path.',
        '',
        'In ADDITION to the `<verdict>` and `<findings>` tags, you MUST emit these machine-readable blocks',
        'in your final message:',
        '',
        '<criteria_results>',
        '[',
        '  {"id":"login","criterion":"User can log in with seeded creds","status":"pass","severity":"critical","repro":"navigate to preview, enter mike/changeme, submit","expected":"board loads","actual":"board loaded"},',
        '  {"id":"create-objective","criterion":"User can create an objective via the UI","status":"fail","severity":"major","repro":"click New Objective, fill title, submit","expected":"card appears on board","actual":"500 error toast"}',
        ']',
        '</criteria_results>',
        '',
        '<screenshot_paths>',
        '["/absolute/path/to/login.png","/absolute/path/to/board.png"]',
        '</screenshot_paths>',
        '',
        '<artifact_paths>',
        '["/absolute/path/to/console.log"]',
        '</artifact_paths>',
        '',
        'Each `<criteria_results>` element: {"id": string, "criterion": string, "status": "pass"|"fail",',
        '"severity": "critical"|"major"|"minor", "repro": string, "expected": string, "actual": string}.',
        '`<screenshot_paths>` and `<artifact_paths>` are JSON arrays of ABSOLUTE file paths.',
        '',
        '### STAKEHOLDER FEATURE BRIEF (required on a PASS verdict)',
        '',
        'You drove this feature in a real browser, so you are the best-placed reviewer to explain what',
        'shipped to a NON-TECHNICAL stakeholder. When (and only when) your verdict is `pass`, you MUST',
        'ALSO emit these two blocks at the very end of your final message:',
        '',
        '<feature_brief>',
        '{ "headline": "<one-line plain-English headline a non-technical stakeholder gets>",',
        '  "description": "<1–3 plain-English sentences on what this does for users — NO jargon, no file/function names>",',
        '  "overview": "<how it works: the user-facing flow / what happens behind the scenes, in plain terms>",',
        '  "audience_worthy": true }',
        '</feature_brief>',
        '',
        '<screenshots>',
        `/tmp/cc-review-shots/${objective.id}/screenshot1.png`,
        `/tmp/cc-review-shots/${objective.id}/screenshot2.png`,
        '</screenshots>',
        '',
        'Rules for the brief:',
        '- ONLY required when your verdict is `pass` — a failing/blocked PR is not shipping, so on',
        '  `fail`/`blocked` you may omit `<feature_brief>` entirely.',
        '- Write it as if announcing the change to a CUSTOMER. Plain stakeholder English only:',
        '  NO code identifiers, NO file/function names, NO PR/diff/commit references, NO jargon.',
        '- Set `"audience_worthy": false` for pure refactors, chores, or internal-only changes a',
        '  stakeholder would not care about; `true` for user-visible features, fixes, or improvements.',
        '- `<screenshots>` is a NEWLINE-separated list of ABSOLUTE screenshot file paths (NOT JSON).',
        `  REUSE the screenshots you already captured: when you call \`browser_take_screenshot\`, pass`,
        `  its \`filename\` argument an ABSOLUTE path under \`/tmp/cc-review-shots/${objective.id}/\``,
        `  (create the directory first: \`mkdir -p /tmp/cc-review-shots/${objective.id}\`), then list`,
        '  those same absolute paths here, one per line.',
        '- If you took no screenshots (api/doc/noop mode), emit an empty `<screenshots></screenshots>`.',
      ].join('\n')
    : ''

  return [
    `You are the AI reviewer for Command Center objective #${objective.id} (iteration ${iteration}).`,
    '',
    `Workspace: ${objective.workspace}`,
    `Type: ${objective.type}`,
    // The TITLE is echoed prose like the rest — and an objective ABOUT the mask puts the
    // scratch name straight in it (this one does). Masked for the same reason as the
    // criteria text: the prompt must print the objective-memory directory to point at the
    // artifact, so any surviving basename reconstructs the path.
    `Objective: ${maskWorkerScratch(objective.title)}`,
    '',
    adversarialSection,
    '',
    [
      '## Speed',
      '',
      'One verification pass. Do not tour the repo. Do not spawn sub-agents unless a',
      '`method:browser` criterion actually requires Playwright. Read only the diff /',
      'files in scope, run the checks, emit verdict tags, stop.',
    ].join('\n'),
    '',
    prLifecycleSection,
    '',
    `## Description`,
    // Masked, not raw: this prompt ECHOES operator-authored prose, and a delegator
    // brief routinely spells out the worker's scratch path. See maskWorkerScratch.
    maskWorkerScratch(objective.description) || '(no description)',
    // obj 708817: UI-created objectives carry no completion_goal. Emit an explicit
    // fallback instead of an empty string so the reviewer is never left with a
    // dangling/absent acceptance bar — the title + description ARE the bar.
    objective.completion_goal
      ? `\n## Completion Goal\n${maskWorkerScratch(objective.completion_goal)}`
      : '\n## Completion Goal\n(none set for this objective — grade against the Title and Description above: the work is done when it delivers exactly what they ask for.)',
    '',
    planSection,
    '',
    // ── Reviewer causal mask (P1-1, obj 707060) ────────────────────────────
    // Injects the TOP of the worker's producer stack — its final artifact
    // (objective-memory ARTIFACT.md when present, else branch/PR/last summary)
    // plus the locked acceptance criteria inline — and explicitly withholds the
    // worker's mid-run scratch file in that same directory. Built in
    // prompt-builder.ts, which owns context-section conventions; the invariant
    // "the reviewer prompt never carries the scratch path" is asserted in
    // reviewer-prompt-mask.test.ts.
    buildReviewerArtifactBlock(objective),
    '',
    rubricSection,
    '',
    backendOnlyNotice,
    uiRubricSection,
    testAgentSection,
    credSection,
    '',
    '## Files touched by the worker session',
    filesTouched.length > 0 ? filesTouched.map(f => `- ${f}`).join('\n') : '(none captured)',
    '',
    '## Where the worker\'s deliverable lives (READ BEFORE GRADING)',
    'Your shell starts in the main project checkout, which stays on `main`. The worker almost'
      + ' never edits `main` directly — it works on its own branch and/or an isolated git'
      + ' worktree (e.g. `/tmp/cc-worktree-<id>/`). If you grade the main checkout blind you will'
      + ' falsely FAIL real work as "absent" (this happened to obj 658 and 633).',
    objective.branch_name
      ? `The worker recorded its branch as \`${objective.branch_name}\`. Before grading, make it`
        + ` visible read-only: \`git fetch --all -q && git checkout ${objective.branch_name}\``
        + ` (or \`git worktree list\` to find its tree), then read the touched files THERE.`
      : 'No branch was recorded for this worker. The deliverable may be on an unmerged branch or'
        + ' an isolated worktree: run `git branch -a` and `git worktree list`, and inspect the'
        + ' worker transcript for its branch/worktree path before concluding anything is missing.',
    '',
    '## Your task',
    '',
    '1. (See Step 0 above — generate or load the rubric.)',
    '2. Locate the worker\'s branch/worktree (see section above), THEN read every file it touched'
      + ' on that branch. Compare against the locked rubric — looking for where it FALLS SHORT, not where it succeeds.',
    '3. Run read-only verification per each criterion\'s `method` (browser/api/doc). Do NOT modify code. For each criterion, capture the concrete artifact (command output / file:line / screenshot path / API response) that proves it — no artifact means that criterion FAILS.',
    '   If a deliverable appears absent, you MUST first confirm you are on the worker\'s branch/worktree.'
      + ' If you cannot locate the worker\'s tree at all, emit `<verdict>blocked</verdict>` — NOT `fail`.'
      + ' "I looked on `main` and didn\'t see it" is never grounds for `fail`.',
    '4. Emit your verdict at the end of your response in this exact shape. Every `[PASS]` line MUST cite its concrete artifact; a line without one is a `[FAIL]`:',
    '',
    '<verdict>pass</verdict>  ← or fail / blocked',
    '',
    '<findings>',
    '# AI Review Findings',
    '',
    '- [PASS|FAIL|BLOCKED] <criterion id>: <concrete artifact — quoted command output / file:line / screenshot path / API response>',
    '- [PASS|FAIL|BLOCKED] <criterion id>: <concrete artifact>',
    '',
    '## Issues',
    '- …',
    '',
    '## Recommendations (only on fail)',
    '- …',
    '</findings>',
    '',
    modeSection,
    '',
    'Verdict semantics (default is fail — pass must be earned):',
    '- pass: EVERY criterion in the locked rubric passed AND each is backed by a concrete artifact you cited above. If even one criterion lacks an artifact or you are unsure about it, this is NOT a pass.',
    '- fail: at least one criterion failed, lacks a concrete artifact, or left you uncertain. This is the DEFAULT verdict — choose it whenever the evidence does not fully and unambiguously support a pass. The worker will be respawned with your findings as a follow-up (up to iteration 3, then human review).',
    '- blocked: you could not run the verification at all (env down, missing creds, rubric unreachable, etc.), OR a criterion is unmet ONLY because it awaits an event the objective explicitly instructed the worker to wait for and then stop before — of two kinds: (a) a HUMAN reply/approval the worker was told to solicit and stop for (a "present → await human → finalize" card), or (b) a SCHEDULED/CLOCK-GATED event the objective pins the deliverable to (a nightly cron, a shift-end time like "after 22:00 UTC", a routine fire) that has not yet occurred at review time — AND the worker correctly executed the pre-event step (finished all pre-gate work and stopped where instructed). Escalates to human. In BOTH cases this is NOT a worker error: do NOT record fail (fail respawns the worker against a finalized state that cannot exist until the event happens), and do NOT stamp individual criteria [FAIL] for artifacts whose precondition has not fired — mark those criteria [BLOCKED] and, when you can read it, state the not-before timestamp so re-review is expected at T rather than read as a defect. Otherwise, use blocked only when verification was impossible — not as a softer alternative to fail.',
    '',
    'You MAY NOT call Edit, Write, NotebookEdit, or any side-effecting Bash command. Read-only operations only.',
  ].filter(Boolean).join('\n')
}

/**
 * True when this objective is a delegator→worker task — `type==='task'` with a
 * parent objective in `delegate_mode`. Mirrors `delegatorParentOf` in state-poller
 * (the exact population RB-23 came from). Used to scope `soft` UI-gate enforcement.
 */
export function isDelegatorWorkerObjective(objective: Objective): boolean {
  const parentId = (objective as Objective & { parent_id?: number | null }).parent_id
  if (objective.type !== 'task' || parentId == null) return false
  try {
    const parent = getDb()
      .prepare('SELECT delegate_mode FROM objectives WHERE id = ?')
      .get(parentId) as { delegate_mode: number } | undefined
    return !!(parent && parent.delegate_mode)
  } catch {
    return false
  }
}

/**
 * Write a per-session MCP config registering the Playwright browser server, and
 * return its path. The reviewer's UI rubric (browser mode) needs browser tools to
 * screenshot; the spawn historically relied on the ambient `claude mcp add --scope
 * user` registration (host-run setup-playwright-mcp.sh), which is implicit and
 * breaks silently on a fresh account / image rebuild. Passing this file via
 * `--mcp-config` makes the registration explicit and guaranteed. Mirrors the args
 * in scripts/setup-playwright-mcp.sh; the Chromium binary is resolved dynamically
 * so it survives Playwright version bumps. Returns null if the config can't be
 * written (reviewer then falls back to the ambient user-scope registration).
 */
export function writeReviewerPlaywrightMcpConfig(sessionId: string, homeDir: string): string | null {
  try {
    const profileDir = path.join(homeDir, '.cache', 'playwright-mcp')
    // Resolve the shared Chromium install (PLAYWRIGHT_BROWSERS_PATH); pick the
    // newest chromium-* dir rather than hardcoding a version.
    const browsersRoot = '/usr/local/share/playwright'
    let chromiumBin = path.join(browsersRoot, 'chromium-1223', 'chrome-linux64', 'chrome')
    try {
      const dirs = fs.readdirSync(browsersRoot)
        .filter((d) => d.startsWith('chromium-'))
        .sort()
      for (const d of dirs.reverse()) {
        const candidate = path.join(browsersRoot, d, 'chrome-linux64', 'chrome')
        if (fs.existsSync(candidate)) { chromiumBin = candidate; break }
      }
    } catch { /* keep default */ }

    const config = {
      mcpServers: {
        playwright: {
          command: 'npx',
          args: [
            '-y', '@playwright/mcp@latest',
            '--user-data-dir', profileDir,
            '--executable-path', chromiumBin,
            '--no-sandbox',
            '--headless',
          ],
        },
      },
    }
    fs.mkdirSync(TMUX_SCRIPT_DIR, { recursive: true })
    const cfgPath = path.join(TMUX_SCRIPT_DIR, `${sessionId}.mcp.json`)
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2))
    fs.chmodSync(cfgPath, 0o666)
    return cfgPath
  } catch (err) {
    console.warn(`[session-manager] reviewer: failed to write Playwright MCP config for ${sessionId}:`, (err as Error).message)
    return null
  }
}
