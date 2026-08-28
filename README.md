# OperationKit

Self-hosted AI operations board — run Claude, Grok, and OpenAI coding agents as real jobs on a VPS you own. Your data stays on your machine.

**In a sentence:** you open a card, pick a model, and an agent session starts in tmux. The card is the source of truth: queue → working → review → done.

## Models

Native engines: **Claude** (Anthropic), **Grok** (xAI), and **OpenAI** (GPT-4o / o-series). Every engine is routed through the bundled **LiteLLM proxy**, so you can also plug in any OpenAI-compatible endpoint — Ollama, Together, Mistral, or any provider with a compatible API.

## Workspaces & teams

OperationKit is multi-workspace from the start. Each **workspace** scopes objectives, users, integrations, and credentials to a project or team. Create as many as you need from the admin UI — each one gets its own board, its own linked repos, and its own secret store. Multiple users can share a workspace; a user can belong to multiple workspaces.

## Docs

| | |
| --- | --- |
| Human docs (setup, guides, API) | [https://m1keluka.github.io/operationkit-site/docs/](https://m1keluka.github.io/operationkit-site/docs/) |
| Setup (clone → running board) | [docs/SETUP.md](./docs/SETUP.md) |
| Product (what it is, how to use it) | [docs/product/README.md](./docs/product/README.md) |
| Agent / HTTP API | [docs/api/README.md](./docs/api/README.md) · [portable prompt](./docs/api/AGENT-PROMPT.md) |
| Architecture | [docs/architecture/README.md](./docs/architecture/README.md) |
| Security / threat model | [SECURITY.md](./SECURITY.md) |
| Deploy / self-deploy | [docs/product/06-operating.md](./docs/product/06-operating.md) |

## Status

Built to be a respectable open-source self-host: TLS, fail-loud secrets, login throttle, CSP, signed webhooks. It is **not** PE-diligence / SOC 2 SaaS. The Docker socket and auto-approved agent sessions are the product, and they are documented as such.

Read [SECURITY.md](./SECURITY.md) before you expose it to a network.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
