# Architecture Overview

OperationKit is a single self-hosted stack: a board (React client + Express server), a SQLite-backed database, a WebSocket/terminal bridge into tmux sessions, and an optional LiteLLM proxy sidecar for model routing.

## The execute loop

1. **Create a card** (an objective) in a workspace, with a title, description, and acceptance criteria.
2. **Start it.** A session spawns — an agent working in an isolated worktree, not your live checkout.
3. **The card is the source of truth.** It moves through a state machine: `queue → working → review → done` (an AI review stage sits between `working` and a human looking at it on contested or high-stakes work — see [Review Gate](./Review-Gate)).
4. **You get pinged for a decision, a missing secret, or a click the session can't reach** — not for routine progress.

## The pieces

| Layer | What it is | Where |
| --- | --- | --- |
| Board / objectives state machine | The card lifecycle, worktree isolation, spawn pipeline | `app/server/src/routes/`, `app/server/src/services/session-manager.ts` |
| WebSocket + terminal bridge | Live session output streamed to the browser over tmux + a PTY | `app/server/src/ws/` |
| Workspaces & RBAC | Multi-tenant isolation per team/org, admin vs. member roles | `app/server/src/db/schema/workspaces.ts`, `core.ts` |
| Model registry | Which models are enabled, which engine (Claude/Codex/Grok) each maps to | `app/server/src/services/model-registry.ts` |
| LiteLLM sidecar (optional) | Routes model groups to non-native providers (Gemini, local Ollama) | `config/litellm/config.yaml`, `docker-compose.yml` |
| Skills / Tools / Agents graph | Composable knowledge/procedure files, surfaced in the Agents admin tab | `app/client/src/components/SkillGraph.tsx`, `app/server/src/services/skill-graph.ts` |
| Knowledge base / context loading | Per-workspace context + a shared vault, loaded before a session starts | see [Knowledge Base & Context Loading](./Knowledge-Base-and-Context-Loading) |
| Adversarial review gate | A fresh-context AI reviewer grades generated work against the card's acceptance criteria | `app/server/src/services/poller-ai-review.ts` |
| Agent HTTP API | Lets an external chat agent (Claude Project, Grok bot, custom GPT) manage the board | `docs/api/README.md`, `docs/api/AGENT-PROMPT.md` |

## Deploy model

OperationKit runs via Docker Compose on a server you control — a VPS, a box in a closet, whatever you've got. Source is bind-mounted, not baked into the image, so most code changes deploy in place without a full rebuild (a frontend-only change never restarts the backend; a backend change restarts the process but tmux sessions survive it). See [Self-Hosting Quickstart](./Self-Hosting-Quickstart).

## Where to go next

- [Features](./Features) — the full feature index, grouped primary/secondary
- [Model Portability](./Model-Portability) — engine routing in detail
- [Self-Hosting Quickstart](./Self-Hosting-Quickstart) — get it running
