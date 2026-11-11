# Security

*How Operation Kit keeps your data and your secrets safe, and what to check when you host it yourself.*

> This page is written so it can also be used on operationkit.com. For the full engineering threat
> model, see [SECURITY.md](../SECURITY.md). For a one-page summary for IT leads, see
> [SECURITY-OVERVIEW.md](SECURITY-OVERVIEW.md). The secrets roadmap is in
> [proposals/SECRETS-PROPOSAL.md](proposals/SECRETS-PROPOSAL.md).

## The short version

- **Your install, your server, your data.** Each Operation Kit runs on a server you control. There
  is no shared Operation Kit cloud and no vendor login into your install.
- **Secrets are encrypted and write-only.** API keys and tokens you store are encrypted with
  AES-256-GCM before they touch the database. Once saved, a value is **never shown again**: not in
  the app, not through the API, not to an administrator. To change one, you rotate it.
- **AI agents use secrets without seeing more than they need.** Agents can call approved services
  through a broker that adds the credential server-side. Text that leaves a session is scrubbed
  for known secret values before it is stored or shown.
- **Everything that touches a secret is logged, and the log cannot be edited.** Creating,
  rotating, deleting, using or trying to reveal a secret leaves a permanent audit record. It
  records who, when, which secret and how, and never the value.

## How your secrets are protected

### Stored encrypted

Every secret value is encrypted with **AES-256-GCM** under a dedicated master key before it is
written to the database. GCM is authenticated, so a tampered value fails to decrypt instead of
silently changing. The master key is kept outside the database. A copy of the database or a
database backup does not contain it, so a leaked backup holds only ciphertext.

### Encryption key

The key that encrypts the store (the *key-encryption key*, KEK) lives in **its own file on the
host**, outside every folder an AI session can see:

| | |
|---|---|
| On the host | `/opt/operationkit/secrets/secrets-kek`: owned by root, mode `400`, inside the root-only `secrets/` folder |
| In the app | mounted **read-only** at `/run/secrets/operationkit-secrets-kek` (`SECRETS_KEK_FILE`) |
| In a session | **not present**. Session sandboxes mount only their own work folder and home. The key is no longer an environment variable of the app, so no child process inherits it. |

The installer creates the file from the key the install already has, so stored secrets keep
decrypting. It refuses to continue if the file and `secrets/stack.env` disagree. The app refuses
a key file that other users can read, and logs at every start where the key came from and whether
that place is safe. Administrators can check this at `GET /api/secrets/kek-status`, which returns
a location and never the key.

Other key sources plug in through one interface (`KekProvider` in
`app/server/src/services/secrets-kek.ts`). A cloud KMS or a 1Password-held key can be added there
later without touching the rest of the store. Neither is built yet.

### Write-only: values are never shown back

| You can | You cannot |
|---|---|
| Create a secret and give it a description | See the value again after saving it |
| **Rotate** it: replace the value with a new one | Fetch a value from any list or API response |
| Roll back to an earlier version (still encrypted) | Turn on reveal. There is no reveal feature and no setting that adds one. Every reveal request is refused and logged. |
| See when it was last updated and **last used** | |

This is the same model GitHub Actions and Vercel's sensitive variables use. A stolen login can
overwrite or delete a secret, and both are logged, but it cannot read the secret. Write-only is a
permanent product decision, not a default you can change: if you lose track of a value, rotate
it at the vendor and store the new one.

### Scoped access

Each secret has a scope, and access is checked on the server for every request:

- **Command Center**: shared across the install. Only administrators manage these.
- **Organization**: for everyone working in one organization. Its members manage these.
- **User**: follows one person into every organization they work in. Only that person manages these.
- **Organization + User**: one person, inside one organization only.

The server's own credentials can be marked **service-only**. They are used by background jobs
and are never handed to an AI session.

### How agents use secrets

- **Broker (use without reveal).** An agent writes `{{secret:NAME}}` in a request. The server
  swaps in the real value on the way out, and only to hosts that secret is allowed to reach. The
  agent never receives the value.
- **Session environment: allowlist only.** A session's environment receives only the secrets
  **allowlisted for its agent or its skills** (see [Session secret allowlist](#session-secret-allowlist)).
  Every other secret stays reachable through the broker. Sessions never receive service-only,
  seat or webhook-signing keys, or the encryption key. By default they also do not receive the
  key that signs logins.
- **Redaction.** Session transcripts, board text, file previews and broker responses are scrubbed
  before they are stored or shown. Scrubbing covers every stored secret value plus common
  credential shapes (API-key prefixes, JWTs, private keys, `password=`, connection strings).
- **Keys pasted in chat.** If an owner pastes a key into a card chat, it is moved into the
  encrypted store and replaced with `[REDACTED:NAME]`. The key is then added to a "rotate later"
  list.

### Audit log

Settings → Secrets → **Audit log** (administrators) shows every secret event. Each secret's
**History** shows that secret's own activity to anyone who can see it.

| Event | When |
|---|---|
| Created / Updated / Rotated / Description changed / Deleted / Rolled back | Someone changed a secret |
| Injected into session | A job started with the secret in its environment |
| Used via broker | An agent used the secret through the broker |
| Read by server | A server-side job decrypted it |
| Reveal attempt (refused) | Someone asked to see a value. Always refused and always recorded, including requests from people without access. |
| `env_policy` | The session allowlist or its mode changed (the detail says what) |
| `audit_prune` | The retention job exported and removed rows older than one year (the detail names the file and its hash) |

Each row records **who**, **when**, **which secret** (name and scope), and **how** (`ui`, `api`,
`spawn`, `broker`, `server`, `cli`, `retention`). Values are never logged. A `read` with source
`cli` is the host script `secrets-get.ts`, which host cron jobs use. It is a machine path for
people with root on the server, not a way to see values in the app.

The log is **append-only at the database level**: a trigger aborts any attempt to edit or delete
a row, and deleting a secret keeps its history.

### Audit log retention

The audit log keeps **one year** in the database. Once a month a scheduled job
(`/etc/cron.d/operationkit-secrets-audit-retention`, written by the installer) moves older rows
out:

1. It writes them to `/opt/operationkit/state/data/audit-exports/secret-audit-before-<date>-<time>.jsonl`
   (one JSON object per row, mode `600`) with a `.sha256` file next to it. That folder is part of
   the nightly backup.
2. It reads the file back and checks the row count and hash. If anything differs, it stops and
   deletes nothing.
3. In **one database transaction** it lifts the delete guard, removes exactly the exported rows,
   puts the guard back, and appends an `audit_prune` row with the count, cutoff date, file name
   and hash. If the number of rows removed does not match the export, the transaction is rolled
   back. The guard against editing rows is never lifted.

Run it by hand (a dry run unless you add `--apply`):

```bash
docker exec command-center tsx server/src/scripts/secrets-audit-retention.ts            # what would move
docker exec command-center tsx server/src/scripts/secrets-audit-retention.ts --apply    # export + prune
sha256sum -c /opt/operationkit/state/data/audit-exports/<file>.jsonl.sha256              # check an export
```

The window cannot be set below 365 days (`--days` accepts longer). Keep the export files for as
long as your own policy requires. They hold names, scopes and actors, never values.

### Session secret allowlist

A session gets only the secrets allowlisted for its **agent** (for example `cto`), for `*` (every
session), or for a **skill** it may use. Names are managed by administrators:

```bash
S="docker exec command-center tsx server/src/scripts/secrets-env-allowlist.ts"
$S status                                  # mode, allowlist size, log size, broker on/off
$S report --days 30                        # which non-allowlisted names sessions actually used
$S allow --agent cto STRIPE_API_KEY        # or --skill crm-sync, or --agent '*'
$S apply --min-sessions 2                  # dry run: allowlist what the report suggests
$S apply --min-sessions 2 --yes            # write it
$S mode enforce                            # switch to allowlist-only
```

The same actions are available to administrators over the API: `GET /api/secrets/env-policy`,
`PUT /api/secrets/env-policy/mode`, and `POST`/`DELETE /api/secrets/env-policy/allowlist`. Every
change writes an `env_policy` audit row.

**Two modes.**

- **Migration**. This is the mode for installs that existed before this release. Sessions still
  receive every secret in scope, as before. When a session ends, the app records which
  **non-allowlisted** names the session's own commands referenced, for example `$NAME` or
  `process.env.NAME`. It records names and counts only.
- **Enforce**. This is the mode for new installs. Sessions receive only allowlisted names. The app
  keeps recording references to withheld names, so a missing entry shows up in `report` under
  *withheld*. The session's instructions list only the names it holds, and point it to the broker
  for the rest.

**Moving an existing install to enforce.** Run in migration mode for a few weeks of normal work.
Review `report`, allowlist what each agent really needs (`apply` gives you a starting point), turn
on the broker (Settings, `session_secret_access`) so sessions can still reach other names without
holding them, then run `mode enforce`. If something breaks, `mode migration` restores the previous
behaviour immediately. `CC_SECRETS_SESSION_ENV_MODE=migration|enforce` in the app's environment
overrides the setting.

Known limit: the log sees names the agent writes in its own tool calls. A program that reads a
variable internally, without the agent ever naming it, does not show up until enforce mode
withholds it.

## Hardening checklist for self-hosters

Work through this list when you install, and again after any major upgrade.

**Host and network**

- [ ] Put the app behind TLS (Caddy is included) and, ideally, behind Cloudflare Access or
      another identity-aware proxy that only admits your organization's accounts.
- [ ] Keep SSH key-only, disable password login, and keep the OS patched (`unattended-upgrades`).
- [ ] Firewall everything except 80/443 (and SSH from known addresses).
- [ ] Encrypt the server's disk if your provider supports it.

**Secrets master key**

- [ ] `GET /api/secrets/kek-status` shows `provider: host-file` with **no warnings**. The installer
      sets this up: `secrets/secrets-kek` is root-owned with mode `400`, and the app mounts it
      read-only. A `legacy` or `sessionVisible` warning means the key still comes from an
      environment variable or a folder sessions can read. Re-run the installer, or follow
      [Moving the key on a custom setup](#moving-the-key-on-a-custom-setup).
- [ ] Keep the key file **outside any directory that AI sessions can read**. Do not put it in the
      projects folder you mount into sessions.
- [ ] Back up the key **separately** from the database, off the server, for example in your
      password manager. The nightly backup already includes `secrets/` (encrypted when it goes
      off the server). Keep one more copy somewhere you control. Losing the key means losing every
      stored secret. A database backup without the key cannot be restored.
- [ ] Never commit the key and never paste it into chat. If the key is missing or the wrong
      length, every secret read or write fails with an error. The store never falls back to plaintext.

**Accounts and access**

- [ ] Use a strong, unique password for every admin, and turn on passkeys or MFA when available.
- [ ] Give people the narrowest role and organization membership that works. Organization members
      cannot list or manage Command-Center-wide secrets.
- [ ] Remove people's accounts when they leave. Their audit history stays.
- [ ] Treat **anyone who can start a session as trusted with the server**. Agents run with broad
      permissions, and the default setup mounts the Docker socket, which is equivalent to root.
      Do not give session access to people you would not give SSH.

**Secrets hygiene**

- [ ] Give every secret a description: what it is for, and who owns it at the vendor.
- [ ] Prefer **organization** or **user** scope over Command-Center-wide.
- [ ] Mark server-only credentials (OAuth client secrets, shared mailbox tokens) **service-only**.
- [ ] Prefer vendor keys with the least privilege and an expiry date.
- [ ] Rotate anything that appears in Settings → Secrets → *Rotate later*, and anything with an
      unexpected **Reveal attempt** or **Used via broker** entry in the audit log.
- [ ] Check **Last used**. A secret nobody has used in months is a candidate for deletion.

**Monitoring and backups**

- [ ] Run the nightly database backup (`scripts/backup-db.sh`) and copy it off the server.
- [ ] Review the Secrets audit log regularly, and watch the alert bell for drift and failed jobs.
- [ ] Never prune the audit log by hand. The monthly retention job (see
      [Audit log retention](#audit-log-retention)) is the only supported way. It exports first
      and records itself. Copy `state/data/audit-exports/` off the server along with your backups.
- [ ] Move existing installs from **migration** to **enforce** once the allowlists are built
      ([Session secret allowlist](#session-secret-allowlist)).

## Moving the key on a custom setup

Installs made with `install.sh` are moved by re-running it. For a hand-built deployment, such as
the upstream operator's own compose file, the app keeps starting from the old location and warns
at every start. To move the key:

1. Write the existing key, unchanged, to a file outside every folder sessions can see, for example
   `/etc/operationkit/secrets-kek`. Set it to root-owned, mode `400`. Do not generate a new key:
   that would orphan every stored secret.
2. Mount that file read-only into the app container only, and set
   `SECRETS_KEK_PROVIDER=host-file` and `SECRETS_KEK_FILE=<path inside the container>`.
3. Remove `SECRETS_MASTER_KEY` from the app's environment, and delete the old key file from the
   session-visible folder only after the app has restarted cleanly and `kek-status` is clean.
4. Recreate the container (`docker compose up -d`). This restarts every running session, so pick
   a quiet time.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md) for how to report a security issue privately.
