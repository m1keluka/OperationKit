# External Agents Driving the Board via API Key

OperationKit has a remote HTTP API so a person — or a third-party agent (a Claude Project, a Grok custom bot, a ChatGPT custom GPT, a cron, a bot) — can project-manage the board without sitting in the UI. The agent reads the board, creates cards, follows up on them, and only escalates to a human for a decision only a human can make.

This is a specific, secondary integration pattern built on top of the core board and model-portability layers — not the category claim (see [Why Own Your AI Infrastructure](./Why-Own-Your-AI-Infrastructure)).

## How it works

1. Generate an API key from Settings → You (`cc_live_…` prefix). It is shown once.
2. Give the key to whichever assistant you want acting as a project-management layer, along with the portable prompt (`docs/api/AGENT-PROMPT.md` in the repo).
3. Every call authenticates as `Authorization: Bearer <key>`.
4. The machine-readable API spec is self-describing: `GET /api/openapi.json`.

## What the key can do

The same key unlocks board management (create/read/update cards, follow up, mark done) plus knowledge-base search and read/write (`GET /api/docs/search`, `GET/PUT /api/docs/file`). It is deliberately scoped to the **board / PM surface** — admin, secrets, shell, and deploy endpoints stay out of this contract.

## What the external agent is NOT

It is not the coding agent that works the card. It doesn't open a terminal, doesn't edit your repos, doesn't run commands. It sits beside the board as a project manager — creating and triaging work — while the actual execution happens through OperationKit's own session/worker pipeline described in [Board & Objectives Lifecycle](./Board-and-Objectives-Lifecycle).

## Naming note

Named deployments of this mechanism (e.g. a specific Grok bot you've configured) are just instances of the general pattern above — there's nothing bot-specific in the underlying API.
