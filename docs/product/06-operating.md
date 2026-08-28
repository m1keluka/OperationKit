# Operating

## Deploy

| Change | Command | Sessions |
| --- | --- | --- |
| TS/TSX/CSS/MD | `bash scripts/quick-deploy.sh both` | survive (~5s WS blip) |
| Frontend only | `… frontend` | untouched |
| Dockerfile / package.json / compose | `… rebuild` | **all tmux die** |

From a session: `scripts/self-deploy.sh` with the same modes. Never `docker compose build` / `up -d` for code.

## How we ship

1. Every card with a linked repo works in `/tmp/cc-worktree-<id>/`, never the live checkout.
2. Push a branch. If the card is set to open a PR, `gh pr create --repo owner/repo` against that GitHub repo (from Settings → Org → linked repos).
3. **`gate` is the test** (typecheck, unit, build). Merge when it is green. You click merge.
4. Then `quick-deploy.sh both`. Rebuild only for Docker / package.json.

The “open a PR” checkbox is how the branch comes back (own PR vs fold into a parent). Isolation always happens.

## Worktrees

Editing `/home/operator/projects/<repo>` from a project card is a production incident waiting to happen. The session starts in the worktree; a hook blocks writes to the live tree.

## Secrets

Source of truth is **Settings → Secrets** (AES-256-GCM in SQLite, master key at `/home/operator/projects/.secrets-master-key`). Sessions get those keys as env vars. They do **not** get a Doppler token.

- Add or rotate a key in the UI. New spawns pick it up; running tmux sessions keep the old env until they respawn.
- Host cron / `docker exec` that needs a value: `docker exec command-center tsx /app/server/src/scripts/secrets-get.ts KEY_NAME`
- Compose still supplies process-start vars (`CC_JWT_SECRET`, provider API keys). Those win over the store if both exist.
- Losing the master key loses every stored secret. Keep an off-box backup.

Rollback: set `USE_SCOPED_SECRETS=0` and restart Node. That stops injecting store keys into new spawns; it does not bring Doppler back.

Threat model and the open-source baseline (JWT, CSP, webhooks, what we are *not*): [SECURITY.md](../../SECURITY.md).

## Architecture map

Engineers: [`../architecture/README.md`](../architecture/README.md). Product language lives in this folder; do not fork it into CLAUDE.md except as a pointer.
