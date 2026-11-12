# Session sandbox: what `/workspace` is, and where session secrets live

Applies when `SESSION_ISOLATION=docker` (the client-installer default). Written
after obj 900038, which fixed three defects found on the Example OVH install on
2026-11-03.

## 1. What gets mounted at `/workspace`

A jail gets exactly two bind mounts: `/workspace` and `/home/jailuser`. The
`/workspace` source is picked by `resolveJailWorkspace()`
(`app/server/src/services/jail-workspace.ts`), in this order:

| # | Condition | `/workspace` source | `reason` |
|---|---|---|---|
| 1 | the card has a git worktree (any project-scoped card) | that worktree | `worktree` |
| 2 | no worktree, workdir is a forbidden bare root | per-card scratch | `scratch:bare-root` |
| 3 | no worktree, the jail uid cannot `cd` into the workdir | per-card scratch | `scratch:not-traversable` |
| 4 | no worktree, workdir missing/empty | per-card scratch | `scratch:no-workdir` |
| 5 | otherwise | the resolved workdir | `workdir` |

**Forbidden bare roots:** `HOME_DIR` (`USER_HOME`), `/`, `/home`, `/root`,
`/tmp`, `/opt`, `/srv`. These are never bind sources, by construction.

`PROJECTS_DIR` and `AI_WORKSPACE_DIR` are deliberately *not* on that list — the
`cto` persona and friends bind them today and work. They are still covered by
rule 3: if the jail uid cannot enter them, the card gets scratch rather than
dying.

**Per-card scratch** lives at `${CC_JAIL_SCRATCH_ROOT:-/tmp/cc-jail-scratch}/<objectiveId>`,
created `0700` owned by the jail uid (default `1000:1000`,
`SESSION_JAIL_UID`/`SESSION_JAIL_GID`). It is per card, so two cards never share
a `/workspace`, and it is reused across restarts of the same card.

### The bug this replaced

A card with no project resolves its workdir via `resolveAgentWorkdir()`, which
maps an unknown agent slug — `general` is the common one — to `HOME_DIR`. On the
OVH install that is `/opt/operationkit/state/home`, **mode 0750 root:root**. The
jail runs as uid 1000, so it could not even traverse the directory, and the
wrapper's `cd /workspace` failed. The card showed *started → 0 tools, 0 tokens,
dead in ~5s → review*. Cards #900029-#900032, #900035 and #900036 all died this
way. `cto` cards (`workdir_kind: 'projects'`) were unaffected, which is why it
looked like a per-agent problem rather than a mount problem.

**Do not "fix" a recurrence with `chmod 755` on the operator home.** That trades
a crash for a disclosure, and it contradicts the jail's premise: the sandbox sees
its own worktree and its own HOME, and nothing else.

## 2. A session that dies before the agent starts

The wrapper now logs *before* it `cd`s, and guards the `cd`
(`buildWorkdirGuard()`, `app/server/src/services/session-startup-failure.ts`).
On failure it writes:

- a human line to the session log: `[wrapper] STARTUP-FAILURE cannot enter workdir …`
  followed by `ls -ld <workdir>` and `id` output;
- a machine-readable event to the transcript:
  `{"type":"error","subtype":"startup_failure","exit_code":78, …}`;
- and exits **78** (`EX_CONFIG`), not a generic `1`.

The poller (`detectStartupFailure()` → `classifyNoOpSpawn()` →
`action: 'startup-failed'`) then moves the card to `review` with
`ai_review_verdict = 'blocked'` and the **exit code plus the stderr tail** in
`ai_review_findings`, and logs an `activity_log` row
(`event_type: 'error'`, title `session_startup_failed`).

It **does not re-spawn.** A startup failure is an environment fault, so retrying
reproduces it exactly — that is how one bad mount became six dead cards. This
deliberately bypasses the `MAX_NOOP_RESPAWNS` loop rather than consuming it.

The detector also recognises the *legacy* silent shape — a transcript with no
events at all and a log that never reached `[wrapper] Starting` — so a session
spawned from a pre-fix wrapper stops being re-spawned too.

### Reading one

```bash
# what the card says (add -H "X-Internal-Secret: $INTERNAL_API_SECRET" when
# INTERNAL_API_REQUIRE_SECRET=1 - see the obj 900027 entry in CHANGELOG.md)
curl -s localhost:3002/api/internal/objectives/<id> | jq -r .ai_review_findings

# the raw wrapper log (jail mode keeps it in the jail HOME until cleanup)
grep -n 'STARTUP-FAILURE\|diagnostic' /home/operator/transcripts/<sessionId>.log
```

## 3. Session secrets on disk

Two files inside the per-session jail HOME hold plaintext credentials:

| File | Contents | Lifetime |
|---|---|---|
| `<sid>.env` | the docker `--env-file`: every injected secret | **deleted the moment `docker run` returns** |
| `<sid>.sh` | the wrapper: one `export KEY="value"` per secret | the session, then scrubbed |

Rules now enforced in `app/server/src/services/jail-home.ts`:

- The HOME and its `.cc/` are created **0700 owned by the jail uid** —
  previously `chmod 0777`, on the shared host `/tmp`, so any process on the box
  could read `<sid>.env`.
- The `--env-file` is unlinked right after `docker run`. The daemon reads it once
  at container-create time and bakes the values into the container config, so it
  has no reason to outlive that call.
- Every session end — clean, early death, crash, or an operator `stop` — runs
  `cleanupJailHome()`: materialise the transcripts (the canonical
  `TRANSCRIPT_DIR` paths are symlinks *into* the HOME), scrub the credential
  files, remove the HOME.
- A sweeper removes jail homes with no live session older than
  `CC_JAIL_HOME_MAX_AGE_MIN` (default **120**), from the poll loop, throttled to
  `CC_JAIL_HOME_SWEEP_MS` (default 10 min). This is the backstop for a SIGKILLed
  control plane, which never reaches `cleanupJailHome()`.

"Live" means *either* tracked in `activeSessions` *or* a running jail container,
so a control-plane restart does not sweep a session that is still working. If
`docker ps` fails, the sweep skips that round rather than guessing.

### Residual risk

When the control plane is **not root** it cannot `chown`, so it degrades: dirs
become `01733` (`-wx` for other plus sticky — enterable and writable, never
listable), and files the jail must read become `0604`. That still leaves the
wrapper script readable by other local uids for the session's lifetime. Run the
control plane as root (the shipped `app/Dockerfile` does) for full `0700`
isolation. The degradation is logged once per process.

### Checking a host

```bash
# no world-readable jail homes
find /tmp/cc-jail-homes -maxdepth 1 -type d -perm -o+r -printf '%M %p\n'   # expect: nothing

# no leftover env files anywhere
find /tmp/cc-jail-homes -name '*.env' -printf '%M %p\n'                    # expect: nothing

# scratch dirs are 0700 and owned by the jail uid
ls -ld /tmp/cc-jail-scratch/*
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `CC_JAIL_HOME_ROOT` | `/tmp/cc-jail-homes` | per-session jail HOME root |
| `CC_JAIL_SCRATCH_ROOT` | `/tmp/cc-jail-scratch` | per-card `/workspace` scratch root |
| `CC_JAIL_HOME_MAX_AGE_MIN` | `120` | age after which an orphan jail home is swept |
| `CC_JAIL_HOME_SWEEP_MS` | `600000` | floor between sweeps |
| `SESSION_JAIL_UID` / `SESSION_JAIL_GID` | `1000` | uid:gid the jail runs as |
| `SESSION_JAIL_TMP_SIZE` | `2g` | size of the jail's in-memory `/tmp` tmpfs (docker size syntax: `512m`, `2g`; an invalid value fails the spawn) |
| `SESSION_JAIL_CLAUDE_TMPDIR` | off | `on` sets `CLAUDE_CODE_TMPDIR=/home/jailuser/.claude-tmp` (disk-backed jail HOME); or a path under `/home/jailuser/` |

## 4. Jail `/tmp` size, and removing the OVH docker shim (obj 900402)

The jail root is `--read-only`, so `/tmp` (a tmpfs) is the only writable scratch
outside the two binds, and Claude Code keeps its own scratch in `/tmp/claude-<uid>`.
It used to be hardcoded at `size=256m`. On 2026-11-09 AI reviews failed with
`/tmp/claude-1000 has 0 MB free` after cloning a ~170 MB repo.

It is now `SESSION_JAIL_TMP_SIZE` (default `2g`), set in `install/docker-compose.yml`
from `JAIL_TMP_SIZE` in `client.conf` (written to the settings env by `install.sh`).
tmpfs only uses RAM for what is written, so 2g is a ceiling, not a reservation.
Optionally `SESSION_JAIL_CLAUDE_TMPDIR=on` (`JAIL_CLAUDE_TMPDIR="on"` in
`client.conf`) moves Claude's scratch off RAM entirely, onto the jail HOME.
`install.sh` / `install/update.sh` no longer need any manual `256m` → `2g` edit.

**The OVH hotfix.** OVH was patched live with two things that a rebuild would lose anyway:
a docker shim at `/usr/local/bin/docker` inside the app container that rewrote
`size=256m` to `size=2g` on every `docker run`, and a hand edit of `session-jail.ts`.
Before updating: `install/update.sh` refuses a repo checkout with local edits. If the hand edit was
also made in the host checkout, drop it first (`git -C <repo> checkout -- app/server/src/services/session-jail.ts`);
this release carries the same fix.

Once this change is merged and deployed (`install/update.sh` rebuilds the image):

```bash
# 1. The shim is gone after the rebuild (the image's docker is under /usr/bin). If it
#    is still there (container not recreated), remove it:
docker exec -u 0 command-center sh -c 'head -c 2 /usr/local/bin/docker 2>/dev/null; echo'   # "#!" = shim
docker exec -u 0 command-center rm -f /usr/local/bin/docker
docker exec command-center sh -c 'command -v docker'      # expect /usr/bin/docker

# 2. The setting reached the app:
docker exec command-center sh -c 'echo $SESSION_JAIL_TMP_SIZE'   # expect 2g

# 3. A new session's jail really got 2g (start any card, then):
docker inspect --format '{{json .HostConfig.Tmpfs}}' $(docker ps -q --filter name=ok-jail- | head -1)
#    expect {"/tmp":"rw,nosuid,nodev,size=2g"}
```

The app container is `command-center` (`install/docker-compose.yml`). The image installs docker to `/usr/bin`, and `/usr/local/bin` comes first on PATH, which is how the shim intercepted every call.
Do the shim removal only AFTER the deploy: before it, the shim is what keeps reviews alive.

## Tests

| What | Where |
|---|---|
| mount choice, bare-root refusal, traversability, modes | `app/server/src/services/jail-workspace.test.ts` |
| 0700 homes, env-file drop, scrub, cleanup, sweeper | `app/server/src/services/jail-home.test.ts` |
| wrapper guard, failure detection, no retry loop | `app/server/src/services/session-startup-failure.test.ts` |
| end-to-end through the real `spawnInTmux` | `app/server/src/services/jail-no-project-card.test.ts` |
| `/tmp` tmpfs size + `CLAUDE_CODE_TMPDIR` | `app/server/src/services/session-jail.test.ts` (obj 900402) |
| live docker proof (rows 8-10) | `scripts/session-jail-proof.sh` |
