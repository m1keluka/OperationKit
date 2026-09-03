# Spawn-Env Scoping — Cutover Runbook (obj-2202 / onboarding gate B1–B4)

**Audience:** Mike (or an admin acting on his explicit go-ahead).
**Status of the code that ships with this doc:** the refactor is **live but DORMANT**.
With the committed defaults, **every session's env is byte-for-byte identical to
before** (proven by `app/server/src/services/session-spawn-env.test.ts`). Nothing
in this runbook has been executed. Each step below is **irreversible and
Mike-gated** — do them in order, verifying between each.

> ⚠️ These workers (including the ones that built this) run **inside** the platform
> they change. A wrong cutover step bricks the platform. Do not batch steps. Do not
> skip the verifies.

---

## What already shipped (safe, reversible, no live effect)

- `buildSpawnEnv()` in `session-manager.ts` is the **single** place every session's
  identity/secret env is built; all 5 spawn sites call it.
- Two flags in `config.ts`, **both default OFF** = current behavior:
  - `USE_SCOPED_DOPPLER_TOKENS` (gate B1)
  - `SCOPE_SUPABASE_ACCESS_TOKEN` (gate B4)
- A two-tier policy (`spawnSecurityPolicy(isAdminSpawn)`) and a tier seam
  (`resolveSpawnTier`). **FILLED (obj-2411):** it resolves the spawn tier from the
  objective owner's (`created_by`) GLOBAL role in `users` — a `member` owner ⇒
  `'member'`, anything else (admin, or no resolvable owner) ⇒ `'admin'` (**fails
  safe** to today's full-capability tier). The member tier still has **no live
  effect** until a scoping flag is ON (the flags, not the tier, gate the env
  change). Every objective today is owned by an admin, so this returns `'admin'`
  for all of them — byte-identical.
- A scoped-token **seam** (`getScopedDopplerToken`). **FILLED (obj-2411):** it
  resolves a **read-only**, workspace-scoped Doppler service token from the
  encrypted `doppler_scoped_tokens` map (`services/doppler-scoped-tokens.ts`),
  selected by `objective.workspace`. It **fails CLOSED** — returns `''` when the
  workspace has no provisioned token, so a member session gets **no**
  `DOPPLER_TOKEN`, never the admin token. **The map is EMPTY today** (no tokens
  minted — that is Step 1 below, Mike-gated), so the seam returns `''` and nothing
  changes until both a token is provisioned AND the flag is flipped.
- The W4 extension hook (`userGitIdentityEnv`) is **now FILLED** (obj-2221): for an
  objective whose owner has a linked GitHub token it injects per-user identity env;
  for an unlinked owner it returns `{}` (shared bot identity, unchanged). This is
  **additive and decoupled from the flags above** — see "Per-User GitHub PR
  Attribution" below.
- **Commented (inert) target mounts** in `docker-compose.yml` for the docker socket,
  the admin-token file, and sibling homes. They change nothing on restart.

None of the above changes a single byte of any admin session's env until the steps
below are taken. (The W4 hook adds keys **only** for an objective whose owner has
linked a token — zero keys, byte-identical env, for every objective today.)

---

## Per-User GitHub PR Attribution (obj-2221 / W4) — enablement

> **DECOUPLED from the Doppler/Supabase cutover above.** This feature needs **none**
> of Steps 1–6, no flag flip, no container restart, no token rotation, and no
> member-tier service. It ships live the moment the W4 branch merges to `main` and
> deploys normally. It is **purely additive**: it changes a session's identity env
> **only** for an objective whose owner has linked a personal GitHub token; every
> other objective keeps today's shared bot identity byte-for-byte.

### How it works (what merged)

- `userGitIdentityEnv(ownerId)` in `session-manager.ts` looks up the **objective
  owner** (`objective.created_by`)'s linked token via `services/user-github-tokens.ts`
  (`getForUser` for the masked login/email, `getDecryptedForUser` for the PAT).
- If linked, `buildSpawnEnv` merges these **additive** keys into every spawn site:
  - `GH_TOKEN` + `GITHUB_TOKEN` — the PR **"opened by"** actor (the token that runs
    `gh pr create`).
  - `GIT_AUTHOR_NAME/EMAIL` + `GIT_COMMITTER_NAME/EMAIL` — the commit **author** and
    **committer** (the user's GitHub login + verified/`noreply` email resolved at
    link time).
- If **not** linked (or any error), it returns `{}` → the session falls back to the
  shared bot identity (`gh` at `/etc/gh`, rotation-home `.gitconfig`). **Work is
  never blocked.**
- The **push transport is unchanged** (shared SSH deploy key, `GIT_SSH_COMMAND`) —
  attribution comes from `GH_TOKEN` + author email, not the push.
- The **server-side harness gate is unchanged** — `state-poller.ts` `ghExecEnv` still
  pins `/etc/gh` (the bot token), so PR status checks stay bot-owned. Only the
  **session's own** `gh pr create` + commits switch to the user.

### Onboard & verify a user (e.g. Eva)

1. **Eva links her token.** She opens **Settings → Account** (`/settings/account`,
   ungated for every authenticated user), pastes a **fine-grained PAT** scoped to the
   your-org repos she'll work on with **Contents: read/write** + **Pull requests:
   read/write**. If the org enforces SSO she must **Authorize** the token for the
   your-org org. The server validates it against `GET /user` (+ `/user/emails`),
   stores it **encrypted**, and shows her resolved `github_login` + masked `…last4`.
2. **Start an objective Eva owns** (`created_by` = Eva). The session spawns with her
   identity injected (no flag, no restart).
3. **Verify attribution on the resulting PR (the live operator step):**
   - PR **"opened by"** badge = Eva's GitHub account, and
   - HEAD commit author **and** committer = Eva. Confirm via:
     ```bash
     # opener (actor):
     gh pr view <PR_URL> --json author -q .author.login
     # commit author + committer on the PR head:
     gh pr view <PR_URL> --json commits \
       -q '.commits[-1] | "\(.authors[0].login) | author \(.authors[0].name) <\(.authors[0].email)>"'
     git -C <worktree> log -1 --format='author %an <%ae> / committer %cn <%ce>'
     ```
   Both levers must resolve to Eva. If the commit shows an **unlinked plain name**,
   her author email isn't verified on GitHub — re-link choosing a verified email (the
   `noreply` form is always verified).

> **Sandbox limitation (why no live PR is attached to this PR):** the build/CI
> sandbox has no second real user PAT (and no SSO-authorized your-org token), so a
> live `git push` + `gh pr create` as a non-bot user is not possible here. The
> shipped proof is the **deterministic harness** in
> `src/services/session-user-git-identity.test.ts` (the "E2E ATTRIBUTION PROOF"
> block), which constructs the exact `GH_TOKEN` + `GIT_AUTHOR_*`/`GIT_COMMITTER_*`
> env `buildSpawnEnv` hands a spawned child for a linked owner. Step 3 above is the
> one-time live confirmation Mike/Eva run after merge.

### Rollback / kill

- **Per user:** Eva clicks **Revoke** in Settings → Account (`DELETE
  /api/user/github-token`) — her next session falls back to the bot identity. (Also
  revoke on GitHub: deleting our copy stops *our* use, not the token itself.)
- **Global, instant:** there is no flag for the hook, but it is inert unless rows
  exist in `user_github_tokens`. To disable platform-wide without a deploy:
  `DELETE FROM user_github_tokens;` (every session reverts to the bot identity on its
  next spawn). To disable in code, revert the `userGitIdentityEnv` body to `return {}`
  and redeploy (`commit → PR → merge → deploy from main`).

---

## Pre-flight (must all be true before starting)

1. The PR for obj-2202 is **merged to `main`** and deployed normally
   (`commit → PR → merge → deploy from main`). Do NOT run from a dirty/branch tree.
2. You have decided to actually onboard a non-admin member (this work is only worth
   cutting over for that). If not, **stop here** — leaving it dormant is correct.
3. The sibling tracks are understood: W4 (per-user GitHub attribution) fills
   `userGitIdentityEnv`; gates B5+ (internal-route auth, JWT secret assertion, etc.)
   from the audit are **separate** and still required before onboarding.

---

## Step 1 — Provision the scoped, read-only Doppler service token(s) (gate B1)

**The code is already implemented (obj-2411).** `getScopedDopplerToken` resolves
from the encrypted `doppler_scoped_tokens` table via
`services/doppler-scoped-tokens.ts`; the only thing missing is the **rows** (the
minted tokens). This step mints them. It is **irreversible-ish and Mike-gated**: it
creates real Doppler service tokens and writes real DB rows.

The map is **table-based**, not a host file — one encrypted row per
`(workspace, config)`, keyed by `objective.workspace`. The raw token is stored
AES-256-GCM (`services/crypto.ts`, same key as `user_github_tokens`,
`TEST_CRED_ENCRYPTION_KEY`) and decrypted **server-side only at spawn**; it is never
mounted into any member session.

1. **Confirm the target map.** Open
   `app/server/scripts/provision-scoped-doppler-tokens.ts` and edit the `TARGETS`
   array so each workspace maps to the correct **Doppler project** + **config**.
   Verify each name against `doppler projects` / `doppler configs --project <p>`.
2. **Preview (DRY-RUN — mints/writes nothing):**
   ```bash
   cd app/server
   tsx scripts/provision-scoped-doppler-tokens.ts            # prints exactly what it WOULD mint + store
   ```
3. **Mint live (Mike-gated — requires BOTH the flag and the env guard):**
   ```bash
   cd app/server
   # doppler CLI must be logged in as an identity that can create service tokens;
   # TEST_CRED_ENCRYPTION_KEY + DB_PATH must match the server so rows encrypt under
   # the key the server decrypts with at spawn.
   PROVISION_SCOPED_DOPPLER_COMMIT=1 tsx scripts/provision-scoped-doppler-tokens.ts --commit
   ```
   Each token is created with `--access read` (READ-ONLY) scoped to one
   project/config — least privilege, the opposite of today's broadcast admin token.
   A stray `--commit` **without** `PROVISION_SCOPED_DOPPLER_COMMIT=1` is refused.
4. **Confirm the map (masked):**
   ```bash
   tsx scripts/provision-scoped-doppler-tokens.ts --status   # shows workspace/config/…last4, no raw tokens
   ```

**Verify (still flags OFF):** unit tests already prove the resolver
(`doppler-scoped-tokens.test.ts`) and the flag-ON member-scoped env
(`session-spawn-env-doppler.test.ts`: member tier + populated map ⇒ only the scoped
token, no `SUPABASE_ACCESS_TOKEN`). With the flags still OFF after minting, **live
behavior is unchanged** — the rows sit unused until Step 4 flips the flag.

## Step 2 — Move the admin-token file out of the member-reachable mount (gate B3)

1. Relocate `/home/operator/projects/.doppler-admin-token` to a host dir NOT bind-mounted
   into member sessions (e.g. `/home/operator/.cc-secrets/.doppler-admin-token`,
   `mode 600`).
2. Uncomment the INERT target mount in `docker-compose.yml` (projects-mount note) and
   set `DOPPLER_TOKEN_PATH` (env/config) to the new in-container path.
3. This requires a **container restart** (compose mount change) — see Step 5; do it
   together with Step 5, not separately.

## Step 3 — Stand up the member-tier service without host root (gate B2 + B3 homes)

The docker socket and sibling homes cannot be dropped per-session from one container.
At cutover, run **member-tier sessions in a separate service/container** (or a
`runuser` identity not in the `dockerhost` group) that:

- **omits** the `/var/run/docker.sock` mount,
- mounts **only** the account home(s) it needs (no blanket `ccuser-*` fan-in),
- does **not** mount the admin-token file.

Wire `resolveSpawnTier` to return `'member'` for objectives owned by a non-admin
`created_by`, and route member-tier spawns to that service. The admin service keeps
today's mounts unchanged.

## Step 4 — Flip the flags (gate B1 + B4)

In the server's environment (compose `environment:` or Doppler), set:

```
USE_SCOPED_DOPPLER_TOKENS=1
SCOPE_SUPABASE_ACCESS_TOKEN=1
```

After this, **member** sessions get the scoped Doppler token (Step 1) and no
`SUPABASE_ACCESS_TOKEN`; **admin** sessions are unchanged. Do NOT commit these into a
default — set them in the deploy environment only.

## Step 5 — Restart with the new mounts, then ROTATE the broadcast admin token

1. Restart the container so the new mounts (Step 2) + flags (Step 4) take effect.
   This is a `rebuild`-class change (compose mounts) — it WILL kill tmux sessions;
   schedule it when the board is quiet.
2. **Only after** verifying scoped tokens work, **rotate** the old broadcast Doppler
   admin token (it was previously handed to every session, so treat it as exposed):
   replace it on the host and in Doppler, confirm the new value flows to admin
   sessions.

## Step 6 — Verify

- Admin session: `doppler projects` still works (broadcast/rotated admin token);
  `echo $SUPABASE_ACCESS_TOKEN` non-empty; `docker ps` works.
- Member session (test member objective): `doppler projects` shows **only** its
  scoped project (or fails closed); `echo $SUPABASE_ACCESS_TOKEN` empty;
  `docker ps` fails (no socket); cannot `cat` the admin-token file or sibling
  `~/.claude/.credentials.json`.
- Drift guard green; site healthy.

---

## Rollback

Each step is independently reversible **before Step 5's token rotation**:
- Flags: set both back to `0`, redeploy → byte-identical to today.
- Mounts: re-comment the target mounts, restore `DOPPLER_TOKEN_PATH` → restart.
- **After Step 5 rotation:** the old admin token is dead — you cannot un-rotate.
  Forward-fix only (provision a fresh admin token if needed).

## Out of scope for this runbook (separate gates)

Internal-route auth (B5/T6), `JWT_SECRET` assertion (A1), password rotation (A5),
status-leak gating (S1), vault symlink containment (V1) — see
`/home/operator/second-brain/workspaces/personal/audits/2026-06-27-user-system-security-audit.md`
§7. Onboarding a non-admin member requires those too, not just B1–B4.
