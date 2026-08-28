# Command Center — system map

Web control plane at `cc.example.com`. It runs AI coding agents (Claude Code, Codex) as **objectives** on a kanban board. Each working objective is a tmux session on the VPS. The Node process is a thin supervisor over host bind-mounts (projects, vault, transcripts, Claude account homes, Docker socket).

## Loop

```
capture          dispatch              execute                    archive
Gmail/Granola    UI or                 tmux Claude/Codex          session-intel
Jarvis/loops     /api/internal         3s state-poller            vault writes
dev-items        routines              AI review + floors         dream-cycle
meetings         Hermes (planned)      PR health (flag-gated)     daily digest
```

The board (`objectives` table) is the source of truth. An agent's claim that it is done is not.

## Process topology

```
Browser ──Caddy──► command-center :3002
                     Express REST + SPA
                     WS /ws (board)  /ws/shell (admin PTY)
                     state-poller (3s)
                     schedulers (see MODULES.md)
                     tmux ── ccuser-{a-e,codex} ── Claude/Codex

compose siblings:  litellm :4000 + litellm-db
host systemd:      Caddy
not in this repo's compose: OpenHands, n8n, Hermes
```

Self-deploy bind-mounts `app/server/src`, `app/client/src`, `app/shared`, `app/client/dist`. `docker compose up -d` kills tmux. Code changes use `scripts/self-deploy.sh` / `quick-deploy.sh` which restart only the Node loop in `entrypoint.sh`.

## Stack

| Layer | Choice |
|---|---|
| Frontend | React 19, Vite 6, Tailwind 3. Hand-rolled pathname router + `lazy()`. |
| Backend | Node 22, Express 4, TypeScript ESM, run via `tsx` (not compiled in prod) |
| DB | SQLite + better-sqlite3, WAL, `initDb()` in `app/server/src/db/index.ts` |
| Sessions | tmux + Claude Code CLI / Codex CLI |
| Auth | JWT httpOnly cookie, 7d |

## What is in-process vs sibling

**In this Node process (must stay green):** session spawn, poller, intel, Jarvis/mentor, costs, workspaces, board HTTP, flag-gated gates/watchdogs.

**Siblings:** LiteLLM, Caddy, host cron (`scripts/install-*-cron.sh`), optional Hermes/n8n/OpenHands/telegram-rolodex.

## How to change this file

Refactor extracts do not change this document's meaning. If you add a boot-time `startX()`, add it to MODULES.md schedulers. If you add a public route prefix, that is a CONTRACTS.md change → product PR.
