# Knowledge Base & Context Loading

Every session starts with context already loaded, not a blank prompt. OperationKit draws on two layers:

- **One knowledge base** — a markdown-over-files store searchable from the product (`GET /api/docs/search`, `GET/PUT /api/docs/file` on the agent API; a `knowledge-search.ts` service does the search underneath). This is where imported files, chat and call imports, compiled wiki pages, saved answers, decisions and durable learnings accumulate over time.
- **Per-workspace context** — a context file scoped to a single workspace, so a session working a card in one workspace doesn't load another workspace's history, clients, or conventions. This is the same isolation boundary described in [Workspaces & Multi-tenancy](./Workspaces-and-Multi-tenancy), applied to knowledge rather than just access control.

## One knowledge base, no source to pick

There is exactly one knowledge base per install, and every reader and writer uses it: the **Knowledge base** page, search, the MCP tools (`search`, `list_folders`, `read_file`, `write_doc`, `file_answer`), and every import (files, Claude/ChatGPT exports, call transcripts). Nobody — person, agent or chat — chooses a "source".

- **Where it lives:** the vault folder when the install has one (`SECOND_BRAIN_DIR`), otherwise `/app/data/knowledge-base` (kept in backups of `data/`).
- **Shape:** each workspace is a folder inside it, holding the raw sources (`sources/`), the compiled wiki pages, an `index.md` and the backlinks between pages. Members see only their own workspaces' folders (plus any shared folder they are given).
- **Not knowledge, not in the tree:** agent instructions and skills (manage them on **Agents** / **Settings → Agents**) and code repositories (**Development**). Pages there stay readable by path for agents that already link to them; they are just not part of the knowledge base.
- **Upgrading:** nothing moves on disk. A workspace whose knowledge folder sits outside the knowledge base (a custom folder set in Settings → Org) appears in the same page list as its own top-level folder, so every page that was reachable under an old "source" is still reachable.

## Why this is infrastructure, not a feature bullet

The knowledge base lives in plain files on your own server — the same property that makes [model portability](./Model-Portability) real. Swap the model underneath a workload and the knowledge base doesn't move, doesn't need re-ingesting into a new vendor's memory format, and isn't subject to a different provider's retention policy. It's the same filesystem either way.

## Docs are part of this too

Markdown docs for a linked repository live alongside the code (`docs/product/`, `docs/architecture/`, etc. in this repo) and are readable/searchable the same way the vault is — a card working on a repo gets that repo's own living docs as context, not just the shared vault.

See the [Agent API](https://github.com/m1keluka/OperationKit) docs in the repo (`docs/api/README.md`) for the exact search/read/write endpoints, and [Architecture Overview](./Architecture-Overview) for where context loading sits in the execute loop.
