# Workspaces & Multi-tenancy / RBAC

OperationKit isolates work by **workspace** — one per team, business unit, or client. Each workspace has its own cards, its own linked repos, its own knowledge context, and its own members.

## Schema

Workspaces are rows in a `workspaces` table keyed by a slug (`app/server/src/db/schema/workspaces.ts`). Membership and role live in a `user_workspaces`-style join (`app/server/src/db/schema/core.ts`), with a `role` column constrained to `admin` or `member` per workspace.

## What role gates

| Role | Can do |
| --- | --- |
| **member** | See and act on cards in workspaces they belong to |
| **admin** (workspace) | Everything a member can, plus workspace-level settings |
| **admin** (global) | Organizations, users, linked repos (Settings → Org), agent roster and skill graph (Settings → Agents), host cron (Settings → Platform) |

Settings is split by scope: **You** (personal — GitHub, Google, API key, personal secrets) vs. **Secrets** / **Org** / **Agents** / **Platform** (workspace- or global-admin only). A user only ever sees cards and context for the workspaces they're a member of.

## Why this matters for self-hosting an SMB

A single OperationKit install can run work for multiple teams or clients without them seeing each other's cards, repos, or knowledge base — the isolation is a schema-level property, not a convention you have to enforce by discipline. That's what makes "self-hosted, multi-tenant" a real claim rather than a hopeful one: you're not running N separate installs to keep N teams apart.

See [Board & Objectives Lifecycle](./Board-and-Objectives-Lifecycle) for how cards move inside a workspace, and [Knowledge Base & Context Loading](./Knowledge-Base-and-Context-Loading) for how per-workspace context is kept separate.
