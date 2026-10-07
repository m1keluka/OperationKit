# Features

OperationKit's category claim is **self-hosted, multi-tenant work infrastructure, model-agnostic by design** (see [Why Own Your AI Infrastructure](./Why-Own-Your-AI-Infrastructure)). The features below support that claim. The ones marked **secondary** are real, shipped features — but they're specific integrations or mechanisms built on top of the core system, not the category claim itself.

## Primary

| Feature | What it does | Page |
| --- | --- | --- |
| Workspaces & multi-tenancy / RBAC | Isolated workspaces per team or business unit, with admin/member roles gating who can see and act on what | [Workspaces & Multi-tenancy](./Workspaces-and-Multi-tenancy) |
| Board & objectives lifecycle | Cards move queue → working → review → done; acceptance criteria are tracked on the card | [Board & Objectives Lifecycle](./Board-and-Objectives-Lifecycle) |
| Model-agnostic engine routing | Claude, Codex, Grok natively; Gemini and local open-weight models via the bundled LiteLLM proxy | [Model Portability](./Model-Portability) |
| Skills / Tools / Agents + CLI | Composable, versioned knowledge and procedure files, surfaced in an admin skill graph | [Skills, Tools & Agents](./Skills-Tools-Agents) |
| Knowledge base & context loading | Team knowledge and per-workspace context load automatically before a session starts | [Knowledge Base & Context Loading](./Knowledge-Base-and-Context-Loading) |

## Secondary (real, but supporting)

| Feature | What it does | Page |
| --- | --- | --- |
| Review gate | A fresh-context AI reviewer grades generated work against the card's locked acceptance criteria before a human sees it — a QA mechanism, not the category claim | [Review Gate](./Review-Gate) |
| External agents driving the board via API key | A Claude Project, a Grok custom bot, a ChatGPT custom GPT, or any HTTP client can create and manage cards through a minted API key | [External Agents](./External-Agents) |
| Delegator mode | A session that decomposes an objective into worker sub-sessions, dispatches them, and reviews the results | [Delegator Mode](./Delegator-Mode) |

## Not covered here

RBAC is documented as part of [Workspaces & Multi-tenancy](./Workspaces-and-Multi-tenancy) rather than as its own page, since the two are implemented together (the same schema governs both workspace isolation and per-workspace roles).
