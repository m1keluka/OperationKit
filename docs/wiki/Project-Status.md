# Project Status

Where OperationKit actually is today, not where the pitch says it's headed. Written 2026-10-19 from the live repos — replace this page's dates as status changes, don't let it go stale silently.

## The three repos

| Repo | Visibility | What it is | Status |
| --- | --- | --- | --- |
| [`m1keluka/OperationKit`](https://github.com/m1keluka/OperationKit) | **Public** | The genericized OSS cut — the actual product code, docs, and this wiki's source | **Live.** Last synced from upstream 2026-10-15. |
| `m1keluka/OperationKit-dev` | **Private** | Early-access mirror of the same cut, for pre-release testers | Private by design — not a staging area for the public repo, a separate access tier |
| [`m1keluka/operationkit-site`](https://github.com/m1keluka/operationkit-site) | **Public** | Marketing site (operationkit.com), hand-authored static HTML, no build step | Live, updated independently of the product repo |

The upstream source of truth for all three is a private internal repo. Nothing here claims star counts, benchmark numbers, or usage stats that aren't independently verifiable from the public repos themselves — check the repo directly rather than trusting a number in a doc.

## How code reaches the public repo

A GitHub Actions workflow (`oss-sync.yml`) mirrors the genericized tracked tree of the private upstream into a rolling "Sync from upstream" PR on the public repo. It runs on a merged PR to the upstream's main branch, a published release, or a version tag — one-way only; nothing on the public repo flows back automatically. Every sync is gated: a denylist scan plus gitleaks must pass clean, or no PR is opened and the previous public state is left untouched (fail-closed, not fail-open).

**Known gap as of 2026-10-19:** the sync gate has failed on the last three feature merges upstream — a read-only files API, live card-progress/artifacts endpoints, and the MCP knowledge connector (see [MCP Connector & Tools](./MCP-Connector-and-Tools)). Those features are live internally and documented on this wiki, but the public repo's `docs/api/README.md` doesn't reflect them yet because the automated sync hasn't cleared the gate since they merged. This is a known, tracked staleness window, not a silent drift — the gate failing closed is the correct behavior; the fix is getting the gate green again, not disabling it.

## What's genuinely shipped (verified against the running code, not a roadmap slide)

- Board / objectives lifecycle with worktree isolation, the AI review gate, and Jobs (scheduled cards) — see [Board & Objectives Lifecycle](./Board-and-Objectives-Lifecycle)
- Three native coding engines (Claude, Codex, Grok) plus Gemini and local open-weight models via the bundled LiteLLM proxy — see [Model Portability](./Model-Portability)
- Workspaces & RBAC, multi-tenant from the schema up — see [Workspaces & Multi-tenancy](./Workspaces-and-Multi-tenancy)
- Subscription seat pooling and routing across multiple accounts per engine — see [Accounts, Subscriptions & Seats](./Accounts-Subscriptions-and-Seats)
- A shared knowledge base plus per-workspace context, loaded automatically before a session starts — see [Knowledge Base & Context Loading](./Knowledge-Base-and-Context-Loading)
- A read-only MCP connector exposing the board and knowledge base to any MCP-capable agent — see [MCP Connector & Tools](./MCP-Connector-and-Tools)
- A remote HTTP API letting a third-party agent (Claude Project, Grok bot, custom GPT) manage the board — see [External Agents](./External-Agents)
- Delegator mode, where one objective fans out into worker sub-sessions — see [Delegator Mode](./Delegator-Mode)

## What's explicitly not here

- No managed/hosted offering — this is self-hosted infrastructure you run on your own server, by design (see [Why Own Your AI Infrastructure](./Why-Own-Your-AI-Infrastructure))
- No write-capable MCP tools yet — the connector is read-only (search, read, list); card creation/status changes still go through the REST API
- No marketplace transaction layer — skill/agent packages are downloadable files, not a paid ingestion pipeline

## Reporting a discrepancy

This wiki is published from `docs/wiki/*.md` in the upstream repo through a gated genericization step (see [Self-Hosting Quickstart](./Self-Hosting-Quickstart)). If something here doesn't match the public repo's actual code, the public repo's tracked source is the tiebreaker — open an issue there.
