# God-file split queue

LOC from `origin/main` at catalog time (approx `wc -l`). Split by **moving exports + re-exporting from the original path**. One responsibility per PR. No behavior change.

Pattern origin already uses: `prompt-builder.ts`, `stream-parser.ts`, `session-lease.ts`, `session-spawn-clock.ts` were pulled out of `session-manager.ts`. Continue that.

## Server (order = risk)

| # | File | ~LOC | Next extract | Facade remains |
|---|---|---:|---|---|
| 1 | `app/server/src/services/session-manager.ts` | 3800 | **done** — `session-usage.ts` | `ensureUser`, `ensureObjectiveMemoryDir`, `selectPredecessorsToReap`, `reapPredecessorSessions` + re-exports |
| 2 | same | | **done** — `session-spawn-env.ts` + `session-spawn-command.ts` | |
| 3 | same | | **done** — prompts + `session-subsessions.ts` (`spawnPlannerSession` / `spawnReviewerSession` / `stopPlannerSession`) | |
| 4 | same | | **done** — registry, tmux, jsonl, death, worktree, follow-up, `session-start.ts` (`startSession`) | |
| 4b | same | | **done** — leftovers: `session-telemetry.ts`, `session-control.ts`, `session-account-status.ts`, `session-interrupted.ts` | |
| 5 | `app/server/src/services/state-poller.ts` | 3500 | **done** — `poller-decisions.ts` (pure: repark, no-op, worker-end, backstop, tag/criteria parsers, bounce cap, watchdog) | `startPoller`, `stopPoller` |
| 6 | same | | **done** — `poller-ai-review.ts` (cap-out, watchdog force-route, verdict parse/upload, persist loop, harness status, PR-linkage sweep) | |
| 7 | same | | **done** — `poller-delegator.ts` + `parkDelegatorIfWaiting` now in `poller-loop.ts` | |
| 8 | same | | **done** — `poller-hygiene.ts` (queue-orphan drainer, top-level queue starter, auto-accept, digest) | |
| 9 | `isLocalhost` | copied | **done** — `lib/is-localhost.ts` (loopback + Docker 172.x.0.1). `routes/internal.ts` re-exports. | |
| 10 | `app/server/src/routes/objectives.ts` | 2300 | **done** — thin facade (`requireAuth` + register*). CRUD/status/planning/uploads/output/control extracted | default router |
| 11 | `app/server/src/routes/internal.ts` | 1550 | **done** — thin facade (`isLocalhost` re-export + register*). deploy/progress/Hermes/create/preview/gmail/mentor extracted | default router |
| 12 | `app/server/src/db/index.ts` | 3070 | **done as designed** — CREATE TABLE in schema modules. CHECK probe-INSERT rebuilds + ALTERs stay in `initDb()` (order is interleaved with later `init*Schema` calls) | `initDb`, `getDb` |

Target after the queue: `session-manager.ts` and `state-poller.ts` each under ~400 lines (loop + re-exports).

### `session-manager.ts` public exports (group = future files)

**Usage (PR 1):** `extractFinalUsage`, `sumResultEventsFromContent`, `extractUsageFromResultEvent`, `TRANSCRIPT_LIST_TTL_MS`, `listTranscriptJsonl`, `__resetTranscriptListCache`, `computeObjectiveSpend`, `extractUsageForSessionId`

**Spawn policy / env:** `SpawnSessionKind`, `spawnSecurityPolicy`, `resolveSpawnTier`, `SAFE_FALLBACK_GIT_IDENTITY`, `userGitIdentityEnv`, `userGoogleCredentialEnv`, `buildSpawnEnv`, `codexAuthAvailable`

**JSONL / telemetry:** `readJsonlTail`, `extractClaudeSessionId` (session-jsonl). `scanStreamTelemetry` (session-telemetry).

**tmux / lifecycle:** `selectPredecessorsToReap` / `reapPredecessorSessions` stay on the facade. `buildClaudeCommand`, `spawnInTmux`, death/auto-resume/start already extracted. `queueFollowUp`, `interruptSession`, `stopSession`, `getSessionStartedAt`, `getSessionState`, `listSessions`, `isSessionActive` live in `session-control.ts`. `setQueueDrainCallback` lives in `session-account-status.ts`.

Re-exported from `session-followup.ts`: `sendFollowUp`, `reopenObjective`.

**Worktree / leases:** `computeIsolation`, `isPrivateWorktreeGitDir`, `isGitRepo`, `WORKTREE_GUARD_SCRIPT`, `BranchLeaseConflictError`, `SessionLeaseConflictError`

**Planner / reviewer:** `spawnPlannerSession`, `stopPlannerSession`, `buildReviewerPrompt`, `writeReviewerPlaywrightMcpConfig`, `spawnReviewerSession`

**Other:** `getAccountRouterStatus` (dashboard overlay, `session-account-status.ts`)

Re-exports already: `buildPrompt`, `resolveWorkdir`, `refreshObjectiveSummary` from prompt-builder; `getSessionOutput*` from stream-parser.

### `state-poller.ts` public exports

Facade still re-exports all of these. Pure subset now lives in `poller-decisions.ts`: `NoOpDecision`, `DeadReparkAction`, `decideDeadSessionRepark`, `classifyNoOpSpawn`, `resolveWorkerEndStatus`, `DelegatorBackstopAction`, `delegatorBackstopDecision`, `extractFeatureBriefTag`, `extractScreenshotsTag`, `extractJsonArrayTag`, `parseCriteriaResults`, `extractScreenshotPaths`, `parseAcceptanceCriteria`, `AI_REVIEW_ITERATION_CAP`, `AI_REVIEW_BUDGET_CEILING_USD`, `budgetCeilingForEffort`, `decideRespawnAction`, `failingCriterionIds`, `WatchdogReason`, `watchdogDecision`.

Re-exported from `poller-ai-review.ts`: `escalateCapOut`, `forceRouteStuckWorker`, `ghExecEnv`, `withRetry`.

Re-exported from `poller-delegator.ts`: `delegatorParentOf`, `continueDelegationOnCommit`.

Re-exported from `poller-hygiene.ts`: `HygieneDigest`, `selectOrphanedQueueChildren`, `selectAutoAcceptCandidates`, `selectTopLevelQueueStarterCandidates`, `buildHygieneDigest`.

Worker-tick helpers now live in `poller-worker.ts`: knowledge/scope scans, limit/overload/turns death, floor wrappers, arena promote.

`poller-loop.ts` owns `pollActiveSessions` + `parkDelegatorIfWaiting`. Facade is `startPoller` / `stopPoller` + re-exports.

## Client (after server kernel)

| File | ~LOC | Split |
|---|---:|---|
| `ConfigPage.tsx` | 1900 | **done** — tab shell + `config/{Workspaces,Users,AgentsSkills,Assignments,Cron,Tools}Tab.tsx`. Skill Graph stays `SkillGraphTab` |
| `LoopsPage.tsx` | 1140 | **done** — page shell + `loops/{types,NewLoopModal,LoopDetailModal,LoopCard,Lane,BulkActionBar,Scratchpad,ReviewQueue}` |
| `ObjectiveModal.tsx` | 1125 | **done** — state/submit shell + `objective-modal/{GoalDrafter,AgentPicker,TypeAndAttachments,PlacementFields,FlagsRoutingHistory,FooterActions}` |
| `SecretsPage.tsx` | 1040 | **done** — page shell + `secrets/{scope,SecretRow,SecretModal,VersionHistoryModal}` |
| `SessionViewer.tsx` | 895 | **done** — drawer shell + `session-viewer/{types,ViewerHeader,CorrectionPanel,BriefPanel,ThreadPane,Composer}` |
| `AccountSettings.tsx` | 870 | **done** — page shell + `account-settings/{Github,GoogleWorkspace,YourAssistant,MySecrets}Section` |
| `DevelopmentPage.tsx` | 825 | **done** — page shell + `development/{types,BoardToolbar,boardColumns,KeyboardHelpModal}` (drawer/chips/changelog already extracted) |

Out of Phase 1 originally: replacing the pathname ternary with `react-router-dom` (behavior: 404s, deep links) — done as the last Phase 1 item.

## Phase 2 (order = size)

Structure-first extracts of files that were never on the Phase 1 queue. Same rules: copy-unchanged, re-export from the original path, `gate` must pass.

| File | ~LOC | Next extract | Facade remains |
|---|---:|---|---|
| `app/server/src/services/pr-health-watchdog.ts` | 1799 | **done** — decisions + owner + sweep + digest. Facade is timer + `buildDefaultDeps` + re-exports | `startPrHealthWatchdog`, `stopPrHealthWatchdog` |
| `app/server/src/services/external-remediation.ts` | 84 | **done** — classify + resolve + act. Facade is re-exports | re-export facade |
| `app/server/src/services/daily-retro.ts` | 409 | **done** — config + scan + gate. Facade is `runDailyRetro` + re-exports (classifiers already in `daily-retro.detect.ts`) | `runDailyRetro` |
| `app/shared/types.ts` | 26 | **done** — core + surfaces + runtime. Facade is package entry + workflow re-exports | re-export facade |
| `app/server/src/services/prompt-builder.ts` | 566 | **done** — workdir + history + blocks. Facade is `buildPrompt` + re-exports | `buildPrompt` |
| `app/server/src/services/dev-items.ts` | 87 | **done** — schema + query + mutate. Facade is re-exports | re-export facade |
| `app/server/src/services/session-intel.ts` | 22 | **done** — parse + summary + pipeline. Facade is re-exports | re-export facade |
| `app/server/src/services/ci-green-gate.ts` | 119 | **done** — decide + github + run. Facade is re-exports. Callers still import the facade (structural pathway scan is of poller/routes, not this file) | re-export facade |
| `app/server/src/services/deterministic-floor.ts` | 59 | **done** — run + gate + outcome/oracle. Facade is re-exports | re-export facade |
| `app/server/src/routes/admin.ts` | 23 | **done** — accounts + ops + jobs. Facade applies auth and composes routers (users/workspaces already separate) | re-export/compose facade |

## Verification per extract

- `npx tsc --noEmit -p app/server/tsconfig.json`
- `npx tsc -b --noEmit` in `app/client`
- `npm run test --workspace=server` and `--workspace=client`
- CI `gate` (required on `main`)
- Diff contains no SQL, no route-prefix strings, no Claude CLI flag edits
- Old path still re-exports the moved names

## Phase 1 + Phase 2 complete

The extract queue is done. Original paths stay as **re-export facades** (the public API). Do not delete them in a mega-PR — callers, tests, and the CI-green structural scan still import the original path.

Importer scan (2026-08-23, basename import of the facade file):

| Facade | ~LOC now | Importers (excl. self) | Keep? |
|---|---:|---:|---|
| `session-manager.ts` | 201 | 30 | yes — kernel public API |
| `state-poller.ts` | 196 | 12 | yes — `startPoller` / `stopPoller` + test imports |
| `objectives.ts` | 24 | 1 (`index.ts`) | yes — router mount |
| `internal.ts` | 22 | 1 (`index.ts` mount) | yes — router compose; `isLocalhost` re-export dropped |
| `db/index.ts` | 1001 | 110 | yes — `initDb` / `getDb` |
| `pr-health-watchdog.ts` | 239 | 2 | yes |
| `external-remediation.ts` | — | 0 | **dropped** — callers import classify/resolve/act directly |
| `daily-retro.ts` | 409 | 2 | yes |
| `shared/types.ts` | 26 | 13 | yes — package entry |
| `prompt-builder.ts` | 567 | 11 | yes |
| `dev-items.ts` | 87 | 4 | yes |
| `session-intel.ts` | — | 0 | **dropped** — callers import parse/summary/pipeline directly |
| `ci-green-gate.ts` | 120 | 8 | yes — pathway scan of poller/routes |
| `deterministic-floor.ts` | 59 | 16 | yes |
| `admin.ts` | 23 | 1 (`index.ts`) | yes — router compose |

No facade has zero importers. A later PR can retarget individual callers to the extracted module, then drop that one re-export — one facade at a time, with `gate` still green.

SQL, spawn CLI flags, HTTP paths, and the status machine stay frozen (`CONTRACTS.md`). Those are product PRs, not cleanup PRs.

CLI scripts under `app/server/src/scripts/` and `db/seed.ts` are entrypoints (no in-repo importer) — not dead code.
