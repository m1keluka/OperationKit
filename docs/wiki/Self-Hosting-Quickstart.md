# Self-Hosting Quickstart

OperationKit runs via Docker Compose on a server you control — a VPS, a home box, whatever you've got. The compose stack has three core services: the OperationKit app itself, and (optionally) a LiteLLM proxy + its own small Postgres, for routing model groups to non-native providers (see [Model Portability](./Model-Portability)).

## Prerequisites

- Docker + Docker Compose on the host.
- A domain (or just an IP) you'll point at the host, with TLS handled at your edge (a reverse proxy in front of the container is the documented pattern).
- At minimum, an API key for whichever model provider you're starting with (Anthropic, OpenAI, xAI, or just a local Ollama endpoint if you're going straight to open-weight).

## Steps

1. **Clone the repo** and copy the env template:
   ```
   git clone https://github.com/m1keluka/OperationKit.git
   cd OperationKit
   cp .env.example .env
   ```
2. **Fill in `.env`.** Required: a JWT secret and an internal-API secret (generate both with `openssl rand -base64 48`). Fill in whichever model provider key(s) you're using; everything else in the template is optional.
3. **Start the stack:**
   ```
   docker compose up -d
   ```
4. **Log in** and generate your first API key from Settings → You if you want an external agent or script talking to the board (see [External Agents](./External-Agents)).
5. **Create your first workspace** (Settings → Org, admin) and invite the people who should see it.
6. **Point a card at a model.** Claude, Codex, and Grok work out of the box once their keys are set; Gemini and local-Ollama routes go through the LiteLLM sidecar — see [Model Portability](./Model-Portability) for exactly which model groups route where today.

## Keeping it running

- A code change rebuilds in place most of the time — no container rebuild needed for TS/TSX/CSS/markdown changes. A Dockerfile, package.json, or compose change does need a rebuild, and that one does take all active sessions down.
- Secrets live encrypted in the database once you add them through Settings → Secrets, not in `.env` — `.env` is only the bootstrap set the container needs to start.
- See `docs/product/06-operating.md` in the repo for the full operating rundown (deploy modes, worktrees, secrets rotation).

## Next

- [Workspaces & Multi-tenancy](./Workspaces-and-Multi-tenancy) — set up more than one team
- [Skills, Tools & Agents](./Skills-Tools-Agents) — write your first skill
- [FAQ](./FAQ)
