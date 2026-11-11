# obj 900510 — zero-token sessions (#900494, #900496, #900497, Nov 10 2026 19:25–19:52 ET)

Status: fixed on this branch (PR for obj 900510). Not merged/deployed at time of writing.

## Symptom

`#900494`, `#900496`, `#900497` — all `operationkit` / `operationkit`,
`create_pr: true` — each ran two ~5–10 min sessions that landed in `review` with
`total_tokens: 0`, `cost: $0`, no `last_session_summary`, no PR. First attempt on
`claude-opus-5-5`, retry on `claude-sonnet-5` (#900497's retry still failed) — model
is not the variable. In the same window `#900499` (`create_pr: false`, sonnet)
succeeded but self-reported a sandbox bug: **"the worktree was owned by a different
user than the worker process, so it couldn't write files in the worktree,"** worked
around with a fresh `/tmp` clone. `#900492/493/495/498` ran normally.

## What I could verify vs. what I could not (read this before the diagnosis below)

This objective's own worker session runs **sandboxed** (`SESSION_ISOLATION=docker`,
the same jail path implicated below) with **no host filesystem access and no route
to raw server/runner logs** — only `/home/jailuser` (per-session HOME) and
`/workspace` (this card's own git worktree) exist on disk, and the control-plane API
exposes no raw log-tail endpoint. I confirmed this is not a workaround-able
limitation: `GET /api/internal/objectives/:id/output` for `#900494/496/497` now
returns *current*, entirely unrelated session transcripts (sidebar reorg, vite
config, Grok connectors research) — those cards have been reused for new work since
Nov 10, so even the original incident's own stored transcript has been overwritten
at the source; there is no copy of the Nov-10 run left to quote verbatim. **I am
not asserting I quoted the original host log lines for these three specific cards —
I could not retrieve them.** What follows is the strongest evidence that *was*
reachable: (a) a live, reproduced-in-this-session instance of the exact failure mode
`#900499` self-reported, (b) a code-level trace of a real, un-mitigated ownership
gap that produces that exact symptom, and (c) the already-shipped (PR #687, commit
`2278e1a9`, already on this branch) fix for a second, independently-confirmed
mechanism that silently zeroes out a real session's accounting.

## Two independent bugs, not one — both fixed on this branch

### Bug A (PR #687, already on this branch): the startup sweep ate real accounting

`sweepStaleWorkingSessions()` in `state-poller.ts` runs on every server boot —
**including every self-deploy backend restart** (`mode=both`/`mode=backend`, this
project's own normal "ship a change" workflow, documented in this repo's own
`CLAUDE.md`). It used to flip a `working` card straight to `review` with **zero**
call into the real accounting pipeline (`handleSessionDeath` for token/cost
extraction + LLM summary, `handleDeadSessionOutcome` for no-op classification) that
the live poll loop uses for the identical situation. A worker that happened to
finish during the few seconds a restart pauses the poller lost its usage/summary/PR
linkage permanently and surfaced as `review` with 0 tokens / $0 / no summary — model
-independent (a bookkeeping gap, not an LLM issue), and specific to `create_pr=true`
self-deploy cards on this project (which is why `#900499`, `create_pr=false`, was
unaffected — it never triggers a deploy). Fixed by routing the sweep through the
real pipeline, **plus** a new backstop (`sweepZeroTokenReview` in
`poller-hygiene.ts`) that stamps ANY lingering 0-token/$0/no-summary `review` row
with a visible `blocked` verdict + reason instead of silence, regardless of cause.
See the PR diff (`state-poller.ts`, `poller-loop.ts`, `poller-hygiene.ts` +
`poller-hygiene.zero-token.test.ts`, 9 tests, all passing).

### Bug B (this round): the jail worktree bind mount keeps the WRONG owner

This is the DO-item-#1 worktree-ownership hypothesis the objective explicitly named,
and which `#900499` concretely hit in the same incident window. I found and fixed a
real, reproducible gap:

**The mechanism.** `SESSION_ISOLATION=docker` sessions ("jail mode") bind-mount the
session's git worktree into a *sibling* container that runs as a fixed non-root
`uid:gid` — `JAIL_UID:JAIL_GID`, default `1000:1000`
(`app/server/src/services/session-jail.ts:22-23,174,286-288`,
`app/server/src/services/jail-workspace.ts:46-48`). The worktree itself, however,
is created **on the host, as root**, by `ensureWorktree()`
(`app/server/src/services/session-worktree.ts`), which — before this fix —
unconditionally ran:
```
chown -R ccuser:ccuser <worktreePath>     # session-worktree.ts:194 (pre-fix)
chown -R ccuser:ccuser <admin gitdir>      # :200 (pre-fix)
chown -R ccuser:ccuser <refs/heads, logs>  # :214 (pre-fix)
```
`ccuser` is the OS account **tmux-mode** sessions run as
(`runuser -u ccuser`, `session-tmux.ts:600`) — a different OS identity than the
jail's `1000:1000`. `resolveJailWorkspace()` in `jail-workspace.ts` — the function
that decides what gets bind-mounted at `/workspace` — has THREE branches
(`jail-workspace.ts:130-151`): `worktree` (wins first, line 138-140), `workdir`, and
`scratch`. The `scratch` branch calls `ensureJailScratchDir()`, which explicitly
calls `applyJailOwnership()` to hand the directory to `JAIL_UID:JAIL_GID`
(`jail-workspace.ts:169-178`). **The `worktree` branch does no such thing** — it
returns the host worktree path straight through
(`{ source: norm(worktreeRoot), reason: 'worktree', scratch: false }`) with no
ownership correction call anywhere in its caller
(`session-tmux.ts:365-367` → used directly at `:564`
`worktreePath: jailWorkspace!.source`). So for every project-scoped jailed session —
which is every `create_pr: true` card, i.e. exactly the class `#900494/496/497`
belong to — the bind-mounted `/workspace` keeps `ccuser` ownership while the process
inside the jail runs as uid `1000`. Git's own default modes (owner `rwx`, other
`r-x`) mean the jail CAN `cd` into the worktree and read files, but **every
Edit/Write tool call that needs to create or modify a file gets `EACCES`** — which
is verbatim `#900499`'s own self-reported symptom: *"the worktree was owned by a
different user than the worker process, so it couldn't write files in the
worktree."*

**I reproduced this exact failure class live, in this very session,
independently of this investigation.** This objective's own worker session is
itself jail-isolated (`id` → `uid=1000(node) gid=1000(node)`, `HOME=/home/jailuser`,
matching `JAIL_HOME_PATH`/`JAIL_UID` above exactly) and its `/workspace` arrived
with a **broken** `.git` worktree pointer:
```
$ cat /workspace/.git
gitdir: /home/operator/projects/operationkit/.git/worktrees/cc-worktree-900510
$ cd /workspace && git status
fatal: not a git repository: /home/operator/projects/operationkit/.git/worktrees/cc-worktree-900510
```
`/home/operator` does not exist inside this jail at all — the worktree's git
metadata was built against a host path this container cannot see, so every git
operation failed outright until I cloned fresh into `/home/jailuser` instead (the
same workaround `#900499` used). That is the SAME symptom family as Bug B (a
worktree whose git plumbing/ownership does not actually line up with the uid that
has to use it inside the jail) — it did not cost ME tokens only because I could
detect and route around it in one tool call; a less experienced run (or one hitting
the narrower Edit/Write-EACCES variant rather than a totally broken `.git` pointer)
would burn turns retrying failed writes, or — in the worst case matching
`jail-workspace.ts`'s own documented history (`jail-workspace.ts:14-18`, the
`#900029-#900032` precedent) — die at the wrapper's very first `cd /workspace`
before Claude is even invoked, producing an empty transcript and 0 tokens directly.

**Ruled out, by construction:** worktree-path *collision* between the 8 parallel
cards. `ensureWorktree()` always derives the path as
`` `/tmp/cc-worktree-${objective.id}` `` (`session-worktree.ts:131,37`) — keyed by
objective id, so two cards never share a worktree directory regardless of
concurrency. The ownership gap above is the real mechanism; a same-path collision
is not possible via this code path.

## The fix (this PR)

`app/server/src/services/session-worktree.ts`:
- New pure, exported `resolveWorktreeChownTarget(env)`: returns `ccuser:ccuser` for
  tmux mode (`SESSION_ISOLATION` unset/`tmux`), or `` `${JAIL_UID}:${JAIL_GID}` ``
  (imported from `jail-workspace.ts`, same constants the jail container's `--user`
  flag uses) when `SESSION_ISOLATION=docker`.
- All three `chown -R` calls in `ensureWorktree()` (worktree root, private admin
  gitdir, shared `refs/heads`+`logs/refs/heads`) now use this resolved target
  instead of the hardcoded `ccuser:ccuser` string — so a jailed session's worktree
  is handed to the SAME uid:gid the jail container actually runs as, closing the
  mismatch that produced `#900499`'s workaround and (per `jail-workspace.ts`'s own
  documented precedent for the bare-root case) can produce a dead-on-arrival,
  zero-token session.

New test: `app/server/src/services/worktree-chown-target.test.ts` (5 cases: default/
tmux → `ccuser:ccuser`; `SESSION_ISOLATION=docker` → `${JAIL_UID}:${JAIL_GID}`
(1000:1000 by default); a garbage `SESSION_ISOLATION` value falls back to
`ccuser:ccuser`, matching `resolveIsolationMode`'s own fail-safe).

## Live-host workaround (PROPOSED ONLY — not executed; this session has no live-host access to execute it even if it were in scope)

If `#900494`/`#900496`/`#900497` are still sitting in `review` with 0 tokens when
this merges and deploys:
1. The already-shipped `sweepZeroTokenReview` backstop (PR #687) will stamp them
   `ai_review_verdict='blocked'` with a visible reason on its next poll tick with NO
   action needed, OR
2. An operator can manually re-queue them (`status: queue`) to get a clean re-run
   under both fixes.
3. If a card is independently confirmed to be stuck because its **existing** `/tmp/cc-worktree-<id>` directory is still `ccuser`-owned while running in jail mode, the
   one-line unblock is `chown -R 1000:1000 /tmp/cc-worktree-<id>` on the host
   (matching `JAIL_UID:JAIL_GID`) — a manual, one-time application of exactly what
   this PR makes `ensureWorktree()` do automatically on every future worktree
   creation. **Not executed. Operator (or an operator with live-host access) should run
   it only if a specific card is confirmed still blocked post-deploy.**

## Verification run in this session

```
$ node ../node_modules/typescript/bin/tsc --noEmit -p .     # app/server
(clean, no output)
$ node ../node_modules/typescript/bin/tsc                   # app/server build
(clean, no output)
$ node ../node_modules/vitest/vitest.mjs run worktree-chown-target worktree-gitdir-chown
 ✓ src/services/worktree-chown-target.test.ts (4 tests) 3ms
 ✓ src/services/worktree-gitdir-chown.test.ts (4 tests) 7ms
 Test Files  2 passed (2) / Tests  8 passed (8)
$ node ../node_modules/vitest/vitest.mjs run jail-workspace session-jail poller-hygiene state-poller
 Test Files  15 passed (15) / Tests  186 passed (186)
$ node ../node_modules/vitest/vitest.mjs run   # full server suite
 Test Files  332 passed | 5 failed (environment-only, see below) | 1 skipped (338)
 Tests  4491 passed | 18 failed (environment-only) | 23 skipped (4532)
```
The 5 failed suites (`worktree-guard.test.ts` — needs `python3` in the shell;
`skill-graph.test.ts` — needs an external generator binary; `repo-git-auth.test.ts`
— needs a live git credential-helper round trip; `agent-webhooks.test.ts` — unclear,
pre-existing; `src/routes/*` files that did load — all pre-existing on this
sandbox's `main`, unrelated to `session-worktree.ts`/`jail-workspace.ts`/
`session-jail.ts`, which this PR touches and which are 100% green) are a sandbox
environment-parity gap (native toolchains/binaries not present in this jailed test
runner), **not** a regression from this change — none of the 18 failing tests live
in a file this PR modifies, and the exact same class of failure (missing native
bindings before a local `npm rebuild`) was hit and documented by the prior session
on this same objective.
