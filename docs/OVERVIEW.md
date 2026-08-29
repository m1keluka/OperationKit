# How OperationKit Works — a one-sitting mental model

## The big picture

You own a VPS (typically a DigitalOcean droplet). Docker runs three services on it:

| Service | What it does | Listens on |
|---|---|---|
| **command-center** | The board UI + session orchestrator | `127.0.0.1:3002` (Caddy proxies → public HTTPS) |
| **litellm** | LLM routing proxy (one endpoint, any model) | `127.0.0.1:4000` (loopback only) |
| **litellm-db** | Postgres backing LiteLLM | internal only |

Caddy sits on the host, terminates TLS on ports 80/443, and reverse-proxies to the board. The app and LiteLLM proxy are never directly reachable from the public internet.

---

## Cards and sessions

**A card on the board is a job.** Each card is called an *objective*: a goal statement with acceptance criteria. You create it, describe what done looks like, and assign it to a workspace.

When you start an objective, the platform opens an **agent session** — a `claude` (or `grok`, or other) process running inside tmux on the droplet. The card is the source of truth; it moves through a state machine:

```
queue → working → ai review → human review → done
```

Fast-track types (`bug`, `task`) skip review stages. You can watch the session live through the board's terminal panel. Tmux keeps the session alive even if you close the browser or the Node backend restarts.

---

## Models

Three native engines ship out of the box:

| Engine | Provider | How to use |
|---|---|---|
| **Claude** | Anthropic | Authenticate a Claude Pro or Max subscription (see [CLAUDE-CODE-AUTH.md](./CLAUDE-CODE-AUTH.md)) |
| **Grok** | xAI | Set `OPENAI_API_KEY` to your xAI API key; point the LiteLLM config at the xAI endpoint |
| **OpenAI** | OpenAI | Set `OPENAI_API_KEY` in `.env` |

Every engine is routed through the bundled **LiteLLM proxy**, which means you can also plug in any OpenAI-compatible endpoint — Ollama running on a GPU box, Together AI, Mistral, or any hosted or local model that speaks the OpenAI chat completions API. Add it to `config/litellm/config.yaml`.

**Agent sessions are powered by your Claude subscription, not your API key.** The `ANTHROPIC_API_KEY` in `.env` powers only a small server-side summarizer. Leave it blank to skip that feature. See [CREDENTIALS.md](./CREDENTIALS.md) for the full breakdown.

---

## Workspaces and teams

A **workspace** scopes everything to a project or team:

- its own objectives board
- its own user membership list
- its own linked repositories
- its own credential store (API keys, webhook secrets)

Create as many as you need from the admin UI. A user can belong to multiple workspaces; a workspace can have multiple users with different roles (admin, member).

---

## Files stay on your machine

Agent sessions run with access to the directories bind-mounted into the container from your host (configured in `docker-compose.yml`). By default these include:

- `~/projects` — your code repositories
- `~/ai-workspace` — skill/agent/tool files the board reads
- `~/second-brain` — knowledge vault

Everything the agent reads and writes goes through the filesystem on your droplet, not through a third-party cloud. You own the data.

---

## What you need

| Requirement | Notes |
|---|---|
| Ubuntu 24.04 droplet (or any Linux host) | 4 GB / 2 vCPU recommended for the three-container stack |
| Docker Engine + Compose v2 | The installer sets this up on a fresh droplet |
| A domain name + DNS A record | For Caddy auto-TLS. Required for a public deployment; local runs work over `127.0.0.1` without a domain |
| A **Claude Code subscription** (Pro or Max) | **This is how agent sessions run.** You authenticate it into the platform via OAuth after the stack is up |
| API keys (optional) | Anthropic API key powers a server-side summarizer only. OpenAI and Gemini keys are for LiteLLM routing. None of these are required to start |

---

## Depth references

This document is intentionally short. For more:

- **Architecture:** [docs/architecture/README.md](./architecture/README.md) — component diagram, data flow, session lifecycle
- **Product guide:** [docs/product/README.md](./product/README.md) — objective types, workspace setup, operating the board
- **Setup (all steps):** [docs/SETUP.md](./SETUP.md) — clone → env → first login → first objective
- **DigitalOcean walkthrough:** [docs/DIGITALOCEAN.md](./DIGITALOCEAN.md) — step-by-step droplet setup
