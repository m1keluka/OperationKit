# Operating

## Running a client install

A client install is made by `install.sh` ([INSTALL.md](../../INSTALL.md)). The code lives in
`/opt/operationkit-src`, everything else in `/opt/operationkit` (change it with `INSTALL_DIR`).

| Task | How |
| --- | --- |
| **Update to a newer version** | `sudo bash install/update.sh --config client.conf` (or `--ref <tag or commit>`). It backs up the database, seat logins and secrets first, keeps the old image for rollback, checks out the new code, re-runs `install.sh`, and prints the rollback steps. Do it when no cards are running. [INSTALL.md, Updating](../../INSTALL.md#updating). |
| **Which version is running** | Settings → bottom of the page (**Build**), or `curl -s http://127.0.0.1:3002/api/health` on the server (`commit`). |
| **Check it is healthy** | `bash install/verify.sh --config client.conf`. Every line should say PASS. |
| **Change a setting** (name, allowed emails, agents, time zone) | Edit `client.conf`, re-run `./install.sh --config client.conf`. |
| **New one-time admin password** | `bash install/admin-password.sh --config client.conf` |
| **Reconnect Claude** (expired or changed account) | Settings → Seats → **Reconnect** on the seat (or **Add Claude seat**) → Sign in with Claude, paste the code. No terminal. The server-token path is `install/claude-login.sh` (INSTALL.md step 7), which uses the same link + code. |
| **Back up** | Automatic: every night into `/opt/operationkit/backups`, and encrypted to a bucket when `BACKUP_TARGET` is set. By hand: `sudo bash install/backup.sh run --config client.conf`. Restore: `install/backup.sh restore <folder> … --yes`. [INSTALL.md, Backups and restore](../../INSTALL.md#backups-and-restore). |
| **Add a secret** (an API key for a connector or agent) | Settings → Secrets in the app. Values are write-only. |
| **Remove everything** | `bash install/uninstall.sh --config client.conf --yes` |

Plain-language security summary for the client: [Security overview](../SECURITY-OVERVIEW.md).
Letting outside AI apps in through Cloudflare: [Connect your AI, Step 0](../CONNECT-YOUR-AGENT.md).

## Developing and deploying this repo (hosted instance)

The rest of this page is for the team that develops Operation Kit on its own hosted instance.

### Deploy

| Change | Command | Sessions |
| --- | --- | --- |
| TS/TSX/CSS/MD | `bash scripts/quick-deploy.sh both` | survive (~5s WS blip) |
| Frontend only | `… frontend` | untouched |
| Dockerfile / package.json / compose | `… rebuild` | **all tmux die** |

From a session: `scripts/self-deploy.sh` with the same modes. Never `docker compose build` / `up -d` for code.

### How we ship

1. Every card with a linked repo works in `/tmp/cc-worktree-<id>/`, never the live checkout.
2. Push a branch. If the card is set to open a PR, `gh pr create --repo owner/repo` against that GitHub repo (from Settings → Org → linked repos).
3. **`gate` is the test** (typecheck, unit, build). Merge when it is green. You click merge.
4. Then `quick-deploy.sh both`. Rebuild only for Docker / package.json.

The “open a PR” checkbox is how the branch comes back (own PR vs fold into a parent). Isolation always happens.

### Worktrees

Editing the live checkout (`<projects dir>/<repo>`) from a project card is a production incident waiting to happen. The session starts in the worktree; a hook blocks writes to the live tree.

### Secrets

Source of truth is **Settings → Secrets** (AES-256-GCM in SQLite, master key in `<projects dir>/.secrets-master-key`). Sessions get those keys as env vars. They do **not** get a Doppler token.

- Add or rotate a key in the UI. New spawns pick it up; running tmux sessions keep the old env until they respawn.
- Host cron / `docker exec` that needs a value: `docker exec command-center tsx /app/server/src/scripts/secrets-get.ts KEY_NAME`
- Compose still supplies process-start vars (`CC_JWT_SECRET`, provider API keys). Those win over the store if both exist.
- Losing the master key loses every stored secret. Keep an off-box backup.

Rollback: set `USE_SCOPED_SECRETS=0` and restart Node. That stops injecting store keys into new spawns; it does not bring Doppler back.

Threat model and the open-source baseline (JWT, CSP, webhooks, what we are *not*): [SECURITY.md](../../SECURITY.md).

### Architecture map

Engineers: [`../architecture/README.md`](../architecture/README.md). Product language lives in this folder; do not fork it into CLAUDE.md except as a pointer.
