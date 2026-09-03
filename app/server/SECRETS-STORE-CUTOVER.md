# Native Secrets Store — Cutover Runbook (obj-2353 / W3)

> **RETIRED 2026-08-23.** Doppler is no longer in the runtime path.
> `USE_SCOPED_SECRETS` defaults **ON**. Sessions do not get `DOPPLER_TOKEN`.
> The Node process hydrates `process.env` from this store at boot. Operators:
> [docs/product/06-operating.md](../../docs/product/06-operating.md).
> Set `USE_SCOPED_SECRETS=0` to stop injecting into new spawns (does not restore Doppler).
> Historical runbook below.

**Audience:** Mike (or an admin acting on his explicit go-ahead).
**Status of the code that ships with this doc:** the native scoped secrets store
(W1) + admin UI (W2) + this injection seam (W3) are **live but DORMANT**. With the
committed default `USE_SCOPED_SECRETS=0`, **every session's spawn env is
byte-for-byte identical to before** — proven by
`app/server/src/services/session-spawn-env.test.ts` (the locked 8-key contract) and
`app/server/src/services/session-spawn-env-secrets.test.ts` (the flag-OFF path adds
zero keys even when the store is populated). Each step below is **irreversible and
Mike-gated** — do them in order, verifying between each.

> **⚠️ STATUS UPDATE (2026-08-14, obj-706069).** The original text here read
> *"Nothing in this runbook has been executed."* **That is no longer true** — Steps 1
> and 2 were executed against prod on 2026-06-29. See
> **[LIVE STATUS — verified 2026-08-14](#live-status--verified-2026-08-14)** at the
> bottom for the measured state and the remaining Mike-gated checklist. Steps 3–6 are
> still outstanding and the flag is still **OFF**.

> ⚠️ These workers (including the one that built this) run **inside** the platform
> they change, and the secrets store will hold the platform's own credentials. A
> wrong cutover step can brick spawns or lose every secret. Do not batch steps. Do
> not skip the verifies. Do NOT run the import `--apply` or flip the flag casually.

---

## What already shipped (safe, reversible, no live effect)

- **W1 store** (`services/secrets-store.ts` + `secrets-crypto.ts`): the Doppler
  replacement primitive — CRUD, scoped resolution (`global < workspace < user <
  workspace_user`), versioning, and an append-only access log, encrypted at rest
  under a **dedicated** `SECRETS_MASTER_KEY`. Adding it changed zero behavior.
- **W2 admin UI**: surfaces masked secret summaries + audit (values never leave the
  server).
- **W3 injection seam** (this wave):
  - One flag in `config.ts`, **default OFF** = current behavior:
    `USE_SCOPED_SECRETS`.
  - A flag-gated block in `buildSpawnEnv()` (`session-manager.ts`): when ON, it
    `Object.assign`s `resolveSecrets({ workspace, userId, audit: true })` over the
    base env; when OFF, the block does not run (zero keys, byte-identical env). The
    resolution is wrapped so a failure **never blocks a spawn**.
  - A one-time importer `scripts/secrets-import-from-doppler.mjs` (dry-run by
    default; `--apply` writes global rows; never mutates Doppler / rotates / flips).

Until the steps below run, **Doppler stays the source of truth** and the store is
inert in the spawn path. The flag-OFF default means **zero behavior change at
merge**.

---

## Coexistence model

Doppler and the native store **coexist** until Step 6:
- Today (flag OFF): the broadcast Doppler admin token + `doppler …` reads are exactly
  as before; the store is populated (optional) but never injected.
- After import + flag ON (Steps 1–4): `buildSpawnEnv` injects the scoped store set on
  TOP of the still-present base env. The store becomes the effective source for the
  injected keys, but the underlying Doppler reads are not *removed* until Step 6.
- The store always wins for any key it defines (the merge happens after the base).

---

## Step 1 — Provision `SECRETS_MASTER_KEY` (CATASTROPHIC if lost)

Losing this key loses **every** secret in the store (AES-256-GCM, no recovery).

1. **Generate** a 32-byte base64 key off-box (NOT inside a session — it must never
   land in a transcript):
   ```bash
   openssl rand -base64 32
   ```
2. **Write it to the host file**, mode 600, owned by the container user:
   ```bash
   printf '%s' '<BASE64_KEY>' > /home/operator/projects/.secrets-master-key
   chmod 600 /home/operator/projects/.secrets-master-key
   ```
   (`secrets-crypto.ts` reads `SECRETS_MASTER_KEY` from the env first, then falls
   back to this host file. Provisioning the file means the server picks it up after
   a restart with no compose change.)
3. **Off-box encrypted backup (MANDATORY).** Store the key in a separate password
   manager / encrypted vault that is NOT on this droplet and NOT in this repo. If
   the droplet disk is lost and this is the only copy, every secret is gone.
4. **Rotation (document, don't do casually).** To rotate: stand up the new key, then
   re-encrypt every row by reading each value under the OLD key and `setSecret`-ing
   it under the NEW key (a re-encrypt pass), then swap the host file and restart.
   `secrets-crypto.ts` caches the key per-process, so a restart is required after any
   change. Until a re-encrypt tool exists, a naive key swap **breaks decryption of
   all existing rows** — treat rotation as its own gated task.

**Nothing is injected yet — the flag is still OFF.**

## Step 2 — Import the existing Doppler secrets (dry-run, review, then `--apply`)

1. **Dry-run first** (prints KEY NAMES + counts per project; writes nothing; needs no
   master key):
   ```bash
   node scripts/secrets-import-from-doppler.mjs
   ```
   Review the key list per project (`example/prd`, `command-center-infra/prd`). Confirm
   it matches what you expect to migrate. The script NEVER prints values, NEVER
   touches Doppler, NEVER rotates or flips anything.
2. **Apply** (writes `global`-scope rows; requires `SECRETS_MASTER_KEY` and tsx):
   ```bash
   SECRETS_MASTER_KEY="$(cat /home/operator/projects/.secrets-master-key)" \
     ./app/node_modules/.bin/tsx scripts/secrets-import-from-doppler.mjs --apply
   ```
   Idempotent: re-running bumps versions, never duplicates. (Per-workspace / per-user
   scoping can be added later via the W2 admin UI; the importer seeds the `global`
   tier only.)

## Step 3 — Verify rows via the W2 admin UI

Open the secrets admin surface and confirm the imported keys appear as **masked
summaries** at `global` scope, with sensible versions/timestamps and an audit trail.
Values must never be visible. Spot-check the count against Step 2's dry-run total.

## Step 4 — Flip `USE_SCOPED_SECRETS=1` (Mike-gated)

In the server's environment (compose `environment:` or Doppler), set:
```
USE_SCOPED_SECRETS=1
```
Restart the **Node server** only (`self-deploy.sh backend` / `mode=both` — tmux
sessions survive; do NOT rebuild/`up -d`). Do NOT commit this into a default or env
file — set it in the deploy environment only.

**What changes after this:** every NEW spawn's env gets the resolved store set
(`global` + the objective's `workspace` + owner `user` + `workspace_user`) merged on
top of the base env, with one `inject` audit row per resolved key. Already-running
tmux sessions are unaffected until they respawn.

## Step 5 — Verify a spawned session gets the scoped set

Start a throwaway objective (known workspace + owner) and confirm in its env that the
imported keys are present and correct (e.g. via the session's own `printenv <KEY>` or
a one-off echo of a NON-sensitive marker key you imported for the test). Confirm the
audit log shows the `inject` rows. Confirm a session whose owner/workspace has no
extra rows still gets the `global` set (and that a resolution failure does NOT block
the spawn — it falls back to the base env).

## Step 6 — Only THEN retire the broadcast Doppler reads

Once scoped injection is verified end-to-end and stable, you may begin removing the
broadcast Doppler reads (the admin-token broadcast in `buildSpawnEnv`, the
`doppler run --` wrapping, etc.) as a **separate** gated change. Treat the old
broadcast admin token as exposed and rotate it per the
`SPAWN-ENV-SCOPING-CUTOVER.md` flow. Do this last and independently — it is not part
of the W3 default.

---

## Rollback

Each step is reversible **before Step 6's Doppler retirement / token rotation**:
- **Flag:** set `USE_SCOPED_SECRETS=0`, restart the Node server → byte-identical to
  today (the injection block stops running entirely).
- **Imported rows:** harmless while the flag is OFF; delete them via the W2 admin UI
  / `deleteSecret` if you want to start over.
- **After Step 6 token rotation:** the old broadcast admin token is dead — you cannot
  un-rotate. Forward-fix only.
- **`SECRETS_MASTER_KEY` loss is NOT recoverable** — see Step 1.

## Affirmation (state of the obj-2353 / W3 PR that authored this runbook)

None of Steps 1–6 had been executed **at the time W3 shipped**. That PR delivered
**code + script + runbook only**; the live cutover was left as a Mike-gated step.

Steps 1 and 2 were subsequently executed against prod on **2026-06-29** (by a later,
Mike-gated action — not by W3). The **obj-706069** work that added the LIVE STATUS
section below likewise executed **none** of Steps 1–6: it took read-only measurements
only. It did not flip `USE_SCOPED_SECRETS`, did not run the importer, did not write
or decrypt a single secret row, and did not restart anything.

---

# LIVE STATUS — verified 2026-08-14

Measured against the **live prod DB** (`/app/data/command-center.db`, the same file
the running server writes to) and the **live Doppler** account, by obj-706069.
Everything below is READ-ONLY evidence. **The worker did NOT flip the flag, did NOT
run the importer, and did NOT write a single secret row.** Steps 4–6 remain
untouched and Mike-gated.

| Fact | Value | How it was established |
|---|---|---|
| `USE_SCOPED_SECRETS` | **OFF** (unset ⇒ default `false`) | absent from container env, `.env`, `.env.example`, `docker-compose.yml`, and Doppler; **plus zero `inject` audit rows ever** |
| `SECRETS_MASTER_KEY` env var | UNSET | `printenv` |
| Master-key file | **PRESENT** — `/home/operator/projects/.secrets-master-key`, 44 bytes (= base64 of 32), mode `600`, dated Jun 29 14:54 | `ls -la` (value never read) |
| Secrets in native store | **63** — **100% `global` scope** | `SELECT COUNT(*)`, `GROUP BY scope_type` |
| `secret_versions` / `secret_access_log` | 121 / 121 (63 `create`, 58 `update`, **0 `inject`**) | `SELECT action, COUNT(*) GROUP BY 1` |
| Store last written | 2026-06-29 14:56:19 — **every row, same second** (~6.5 weeks stale) | `MIN/MAX(created_at, updated_at)` |
| Secrets in Doppler (`example/prd` ∪ `command-center-infra/prd`) | **68** | `doppler secrets --only-names` |
| Drift | **5 in Doppler not in store; 0 orphans in store** | name-set diff |
| Orgs / users | 6 workspaces (0 archived), 3 users (1 admin, 2 members) | `SELECT slug FROM workspaces`, `SELECT id, username, role FROM users` |

### The proof the flag has never been ON

The ON path writes one `inject` audit row per resolved key on **every** spawn
(`session-manager.ts` → `resolveSecrets({..., audit: true})`). Across thousands of
spawns since the store was seeded:

```
$ node -e "SELECT action, COUNT(*) n, MIN(at) mn, MAX(at) mx FROM secret_access_log GROUP BY 1"   # better-sqlite3 readonly
[{"action":"create","n":63,"mn":"2026-06-29 14:56:19","mx":"2026-06-29 14:56:19"},
 {"action":"update","n":58,"mn":"2026-06-29 14:56:19","mx":"2026-06-29 14:56:19"}]
inject_count = 0
```

Flag source of truth — `app/server/src/config.ts`:

```ts
function spawnEnvFlag(name: string): boolean {
  const v = (process.env[name] || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}
export const USE_SCOPED_SECRETS = spawnEnvFlag('USE_SCOPED_SECRETS')   // unset ⇒ false
```

### Store vs Doppler

```
$ node -e "<set diff, DOPPLER_* pseudo-vars filtered>"
example/prd names                     = 62
command-center-infra/prd names     = 68     (example/prd is a strict subset)
UNION                              = 68
native store distinct keys         = 63
--- IN DOPPLER, NOT IN STORE (5) ---
DS_EB_BASE_URL, DS_EB_KEY, DS_WEBHOOK_SECRET, MERCURY_API_TOKEN, OBJECTIVES_API_TOKEN
--- IN STORE, NOT IN DOPPLER (0) ---
(none)
```

The store is a clean **strict subset** — drift is one-directional and consistent with
5 keys having been added to Doppler *after* the 2026-06-29 import. **Caveat: only
NAMES were compared.** Any of the 63 matched keys could hold a *stale value*, because
comparing values would require decrypting the store — deliberately not done.

### Scope distribution — the thing to fix before flipping

```
$ SELECT scope_type, workspace, user_id, COUNT(*) FROM secrets GROUP BY 1,2,3
{"scope_type":"global","workspace":"","user_id":0,"n":63}
```

All 63 rows are `global`. **Flipping the flag today would give every session in every
organization all 63 secrets** — functionally identical to today's broadcast model, so
it would be safe but would buy none of the least-privilege benefit. The scoping work
(deciding which keys are Command-Center-wide vs per-organization vs per-user) is the
real prerequisite, and it is exactly what the admin UI shipped in obj-706069 is for.

### What could NOT be verified

- **Container name / `docker ps` status / uptime string.** The verifying session's uid
  (1001) is not in the host docker group (987) and there is no `sudo`, so
  `docker ps` / `docker exec` were both blocked. That the server is running was
  established indirectly and unambiguously — `objectives.updated_at` was **2 seconds
  old** at the time of the check. Note this contradicts CLAUDE.md's claim that docker
  works from sessions; it does not, from this container.
- **HTTP health.** Port 3002 is bound `127.0.0.1` only and session egress is
  sandboxed; all probes returned `000`.
- **Whether the 63 stored values are current** — would require decryption.

---

## MIKE-GATED CUTOVER CHECKLIST

Steps 1–2 are **done**. Do the rest in order, one at a time, verifying between each.
Nothing here should be run by an agent without Mike saying so explicitly.

- [x] **1. Provision `SECRETS_MASTER_KEY`** — done 2026-06-29. File exists, mode 600.
      ⚠️ **Open action: confirm the off-box encrypted backup exists.** Loss of this key
      = all 63 secrets unrecoverable (AES-256-GCM, no escrow). If you cannot point at
      a backup right now, treat that as the highest-priority item on this list.

- [x] **2. Import from Doppler** — done 2026-06-29, 63 keys, `global` tier.

- [ ] **2b. Re-run the import to close the 5-key drift** *(new; not in the original runbook)*
      ```
      node scripts/secrets-import-from-doppler.mjs                       # dry run, writes nothing
      SECRETS_MASTER_KEY=… ./app/node_modules/.bin/tsx \
        scripts/secrets-import-from-doppler.mjs --apply
      ```
      Idempotent — re-writes the 63 existing keys as a new version and adds the 5
      missing. This also refreshes any value that drifted since June. Expect
      `secrets` to go 63 → 68.

- [ ] **3. Verify in the admin UI** — `/settings/secrets`. With obj-706069 shipped, the
      default view is **All scopes**: confirm 68 rows, every one badged
      **Command Center**, sane versions/timestamps, and **no value visible anywhere**.

- [ ] **3b. Assign real scopes** *(new; the actual point of the exercise)*
      For each key decide: Command-Center-wide / one Organization / one User, and use
      the UI's **change-scope** control to move it. Suggested first pass:
      - `SUPABASE_*`, `GHL_*`, `CALCOM_*`, `EMAILBISON_*`, `TELNYX_*`, `TWILIO_*` → the
        **Organization** that actually uses them (example / example2 / example-project).
      - `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_WEBHOOK_SECRET`,
        `INTERNAL_API_SECRET`, `MENTOR_SERVICE_TOKEN` → keep **Command Center**.
      - Anything personal to Mike (`MERCURY_API_TOKEN`, `GMAIL_*`) → **User: mike**,
        which follows him into every organization.
      Do this BEFORE step 4 — the flag is what makes scoping load-bearing, and a
      mis-scoped key only becomes visible as a broken spawn after the flip.

- [ ] **4. Flip `USE_SCOPED_SECRETS=1`** — deploy environment ONLY (compose
      `environment:` or Doppler). **Not** in a committed default or `.env`. Then
      restart the Node server via `self-deploy.sh` `mode=backend`. Do **not**
      `docker compose up -d` / rebuild (kills tmux). Running sessions are unaffected
      until they respawn.

- [ ] **5. Verify a live spawn** — throwaway objective with a known
      (organization, owner). Confirm the expected keys are present and the
      *unexpected* ones are absent; confirm `inject` rows now appear in
      `secret_access_log` (they are currently 0, so this is an unambiguous signal);
      confirm an owner with no user-scoped rows still gets the Command-Center set; and
      confirm a deliberate resolution failure does not block the spawn.

- [ ] **6. Retire the broadcast Doppler reads** — separate, later, gated change:
      remove the admin-token broadcast in `buildSpawnEnv` and the `doppler run --`
      wrapper, then **rotate the old broadcast admin token as exposed**
      (`SPAWN-ENV-SCOPING-CUTOVER.md`). ⚠️ This is the point of no return — everything
      before it is reversible by setting the flag back to `0` and restarting.
