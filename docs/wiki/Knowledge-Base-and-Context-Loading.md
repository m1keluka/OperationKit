# Knowledge Base & Context Loading

Every session starts with context already loaded, not a blank prompt. OperationKit draws on two layers:

- **A shared knowledge base (vault)** — a markdown-over-files store searchable from the product (`GET /api/docs/search`, `GET/PUT /api/docs/file` on the agent API; a `knowledge-search.ts` service does the grep underneath). This is where decisions, architecture notes, and durable learnings accumulate over time.
- **Per-workspace context** — a context file scoped to a single workspace, so a session working a card in one workspace doesn't load another workspace's history, clients, or conventions. This is the same isolation boundary described in [Workspaces & Multi-tenancy](./Workspaces-and-Multi-tenancy), applied to knowledge rather than just access control.

## Why this is infrastructure, not a feature bullet

The knowledge base lives in plain files on your own server — the same property that makes [model portability](./Model-Portability) real. Swap the model underneath a workload and the knowledge base doesn't move, doesn't need re-ingesting into a new vendor's memory format, and isn't subject to a different provider's retention policy. It's the same filesystem either way.

## Docs are part of this too

Markdown docs for a linked repository live alongside the code (`docs/product/`, `docs/architecture/`, etc. in this repo) and are readable/searchable the same way the vault is — a card working on a repo gets that repo's own living docs as context, not just the shared vault.

See the [Agent API](https://github.com/m1keluka/OperationKit) docs in the repo (`docs/api/README.md`) for the exact search/read/write endpoints, and [Architecture Overview](./Architecture-Overview) for where context loading sits in the execute loop.
