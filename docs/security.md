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

### Write-only: values are never shown back

| You can | You cannot |
|---|---|
| Create a secret and give it a description | See the value again after saving it |
| **Rotate** it: replace the value with a new one | Fetch a value from any list or API response |
| Roll back to an earlier version (still encrypted) | Turn on reveal for yourself. Every reveal request is refused and logged. |
| See when it was last updated and **last used** | |

This is the same model GitHub Actions and Vercel's sensitive variables use. A stolen login can
overwrite or delete a secret, and both are logged, but it cannot read the secret.

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
- **Session environment.** Secrets in scope for a job are provided to that job's environment.
  Sessions never receive service-only, seat or webhook-signing keys. By default they also do not
  receive the key that signs logins.
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

Each row records **who**, **when**, **which secret** (name and scope), and **how** (`ui`, `api`,
`spawn`, `broker`, `server`). Values are never logged.

The log is **append-only at the database level**: a trigger aborts any attempt to edit or delete
a row, and deleting a secret keeps its history.

## Hardening checklist for self-hosters

Work through this list when you install, and again after any major upgrade.

**Host and network**

- [ ] Put the app behind TLS (Caddy is included) and, ideally, behind Cloudflare Access or
      another identity-aware proxy that only admits your organization's accounts.
- [ ] Keep SSH key-only, disable password login, and keep the OS patched (`unattended-upgrades`).
- [ ] Firewall everything except 80/443 (and SSH from known addresses).
- [ ] Encrypt the server's disk if your provider supports it.

**Secrets master key**

- [ ] `SECRETS_MASTER_KEY` is set (32 random bytes, base64), **or** the key file exists with
      mode `600`, owned by the service user.
- [ ] Keep the key file **outside any directory that AI sessions can read**. Do not put it in the
      projects folder you mount into sessions. (Roadmap item F1 moves this by default.)
- [ ] Back up the key **separately** from the database, off the server, for example in your
      password manager. Losing the key means losing every stored secret. A database backup
      without the key cannot be restored.
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
- [ ] If you must prune the audit log, export it first. Pruning requires deliberately dropping the
      `trg_secret_access_log_no_delete` trigger, and that step should itself be recorded in your
      change log.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md) for how to report a security issue privately.
