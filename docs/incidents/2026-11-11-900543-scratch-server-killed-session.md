# 2026-11-11: #900543's sessions killed by their own scratch server; follow-ups need several sends (obj 900547)

## A. #900543 died twice and was recorded as 0 tokens

**Timeline (UTC, from the app log and the card transcript)**
- 05:04:31: `cc-900543-1794373470759` spawned on seat s1 in jail `ok-jail-900543`.
- The worker booted a scratch Command Center for screenshots: `env -i … NODE_ENV=production PORT=3902 DB_PATH=<temp> nohup npx tsx src/index.ts`.
  Its log shows `[worktree-reaper] started`, `[account-router] Queue drain timer started` and `Command Center running on port 3902`.
- 05:11:00: the session ended with 44 tool calls and no final result. The seat's "Tokens today" stayed at 144278239. 05:11:33: the card landed in review with 0 tokens / $0.
- 05:14:43: a follow-up started a history-flattening respawn. The worker booted the scratch server again, this time on port 3912. 05:18:39: the session ended again (86 tool calls, no result).

**Root cause (code)**
1. `index.ts` ran the whole host boot path in any process, so the scratch server started the state poller as well.
2. On the poller's first 3s tick, `poller-loop.ts` called `sweepOrphanWorkerTmux()` (`session-manager.ts`).
   That ran `tmux ls`. Inside a jail it lists exactly one session, the worker's own `cc-900543-…`.
   The temp DB had no live `session_id` matching it, so the sweep ran `tmux kill-session` on it.
3. The jail's PID 1 is `while tmux has-session -t cc-900543-…; do sleep 5; done`, so the jail exited too. The CLI was killed mid-turn and never wrote a `result`.
4. Both token paths count only `result` events: `sumResultEventsFromContent` (seat ledger) and `extractDeterministic` (session_intel → card totals). So both deaths were recorded as 0 tokens / $0.

**Reproduction:** `services/scratch-instance.test.ts` › "does NOT kill a worker tmux session for an objective this DB has never heard of".
It creates `cc-900543-1794373470759` on an isolated tmux server with an empty DB and runs the real `sweepOrphanWorkerTmux()`.
With the new guard disabled, the test logs `[session-reaper] killed orphan worker tmux 'cc-900543-1794373470759'` and fails.

**Fixes**
- `services/scratch-instance.ts` + `index.ts`: a scratch instance starts no host daemons. Any of these marks a process as scratch:
  - `CC_SCRATCH_SERVER=1` / `OK_SCRATCH=1` / `NODE_ENV=test`
  - an inherited `CC_OBJECTIVE_ID`, `CC_SESSION_TOKEN` or `CC_WORKTREE_ROOT`
  - a worker tmux session, a jail or worktree path, or a `claude` / worker-wrapper ancestor in `/proc`

  The ancestor check still works after `env -i`. `CC_HOST_INSTANCE=1` overrides all of them.
- `sweepOrphanWorkerTmux` and `reapPredecessorSessions` never kill the tmux session the process runs inside. The sweep also skips objectives its DB does not know.
- `services/unresulted-usage.ts`: usage of a process that ended without a `result` is taken from the per-message `usage` in the transcript, deduplicated by `message.id`. Cost is estimated from list prices. Clean sessions are counted exactly as before.
- `services/abnormal-end-retry.ts`: the first mid-turn death (real work, no result) gets one resume with context. The next one goes through PR 673's flag path (`stalled_at` → `needs_agent` kind `stalled`, plus an AlertBell alert) and parks the card as blocked, with the cause stated. Both share PR 673's `stall_restarts` once-only budget.
- `CLAUDE.md` › "Scratch server for screenshots": the safe way to start a scratch server.

## B. One human follow-up didn't wake the card (#900412, Casey, 2026-11-10)

`session_starts` shows four `follow_up` starts in 10 minutes, and the transcript has no new output after 17:21:32.

`POST /:id/message` sets the card to `working`, responds, and spawns on the next tick. Until the spawn shows up, the card is `working` with no live process and a transcript that ends in the previous turn's `result`. The tmux/jail liveness snapshots (1s/2s) can also be older than the spawn.

In that window `getSessionState` returns `review`. The poller then moves the card back to review and runs `handleSessionDeath` on the session being respawned; in jail mode that removes its HOME. The message is shown, but the card never starts.

The PR 676 queue only handles messages sent while a turn is running, so it did not cause this and could not fix it: the 17:31:27 message was queued correctly and delivered at 17:31:31.

**Fix:**
- `holdPollerForRespawn()` reuses the poll loop's existing `overloadRetryPending` skip. The hold runs from the status change until 20s after the spawn returns (`CC_RESPAWN_HOLD_GRACE_MS`). It is released at once if the spawn fails, and it never shortens a real 529 backoff.
- `sendFollowUp` clears the liveness snapshots right after `spawnInTmux`.
- Test: `routes/objectives.message-wake.test.ts`. Its 3 wake cases fail without the fix.

'Ryan Issue' (your-org) could not be read from this operationkit-scoped session (403 `workspace_forbidden`).
