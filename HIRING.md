# Founding Engineer (Open Source, Self-Hosted AI Infrastructure)

**OperationKit** · Remote · Full-time or serious contract  
**Repo:** https://github.com/m1keluka/OperationKit (Apache-2.0, public, real code)  
**Comp:** Market-competitive base; founding-engineer equity grant. Both discussed in the first conversation, not at the end.

## What OperationKit is

OperationKit is a self-hosted operations board for AI coding agents. You stand it up on a VPS you own. A card on the board is a job: you write a goal and acceptance criteria, pick a model, and the platform opens a real agent session — a `claude` or `codex` process running in tmux on your host — that does the work and moves the card through `queue → working → ai_review → review → done`.

The board is the source of truth, deliberately. An agent's claim that it's finished is not a state transition. There's a poller on a 3-second tick that reads real session state, an AI review stage that reads the work adversarially against the acceptance criteria before a human sees it, and a set of deterministic gates that can fail a session that a language model was perfectly happy with.

Everything runs on your machine. Your code, your credentials, your model subscriptions, your transcripts. Nothing routes through a third-party orchestration cloud.

## Honest about the stage

- **It's early and it's one person.** Mike (founder) is the technical team today. The system runs a real fleet daily — this is not a demo — but there are sharp edges, uneven docs, and decisions worth revisiting. You would have unusual latitude to change them.
- **The security blast radius is real, and we document it instead of hiding it.** Read [`SECURITY.md`](./SECURITY.md) before you decide anything about this role. Agent CLIs run auto-approved. The default compose file mounts the Docker socket. Workspaces are a SQL filter, not a jail. The doc says all of this, today. Closing that gap is the most important open problem in the codebase.
- **It's genuinely open source.** Apache-2.0. The core stays free.
- **Bring-your-own-billing is the model.** Users run on their own Claude/Grok/OpenAI subscriptions and their own VPS.

## What you'd own

**1. Isolation and the security posture.** Getting from "documented sharp edges" to a defensible model: per-agent sandboxing, dropping the Docker socket for non-admin session spawns, scoped spawn environments. The current worktree isolation lives in [`app/server/src/services/session-worktree.ts`](./app/server/src/services/session-worktree.ts). This is the highest-leverage work in the project.

**2. The session kernel.** Spawning, supervising, and reaping agent sessions — the poll loop, death classification (rate limit vs. spend cap vs. Anthropic 529 overload vs. turn-cap exhaustion, each needing a different recovery), auto-resume, leases, orphan cleanup.

**3. The governance layer.** The state machine, the AI review stage, deterministic gates that can override a model's verdict, acceptance-criteria evaluation. "A model's self-report is evidence, not truth."

**4. Self-host DX.** Fresh VPS to a running board in thirty minutes, not an afternoon.

**5. Whatever you argue for.** You'd be the second technical voice on a system that has only had one.

## The stack

TypeScript end to end. Node 22, Express 4, ESM, run via `tsx`. React 19 + Vite 6 + Tailwind. SQLite (better-sqlite3, WAL). tmux + the Claude Code / Codex CLIs. Docker Compose on Linux, Caddy for TLS. LiteLLM bundled as the model proxy. ~830 files, 214 test files, CI that runs typecheck + build + full Vitest on every PR.

## Who we're looking for

- Strong TypeScript and Node in a real codebase, not just greenfield
- You think in systems and failure modes — process lifecycle, concurrency, six different reasons a child process can die
- Comfortable in the self-host world: terminal, Linux, Docker, DNS, TLS
- Opinions you can defend without hype; "I'd tear this out and here's why" is the best thing you can say
- You want ownership more than structure
- Useful but not required: LLM agent work, or multi-tenant infra where blast radius mattered

## How to apply — three steps

**This is the whole process. There is no separate resume screen.**

**Step 1 — Read the repo (~30–45 minutes)**  
https://github.com/m1keluka/OperationKit

Start with these five files:
1. [`SECURITY.md`](./SECURITY.md) — the threat model, written honestly. Start here.
2. [`app/server/src/services/session-worktree.ts`](./app/server/src/services/session-worktree.ts) — the isolation model
3. [`app/server/src/services/session-death.ts`](./app/server/src/services/session-death.ts) — how a dead session is classified
4. [`app/shared/workflow.ts`](./app/shared/workflow.ts) + [`app/server/src/services/poller-loop.ts`](./app/server/src/services/poller-loop.ts) — state machine and the 3s loop
5. [`docs/architecture/`](./docs/architecture/) — including `GOD-FILES.md`, a public list of our worst files

Form an opinion. Including a negative one.

**Step 2 — Star the repo, if you actually found it interesting (optional)**  
If you read it and thought it was worth building on, a star genuinely helps. We're asking plainly. It is not required, not rewarded, not scored, and we do not check it. If you read the code and didn't like it, please don't.

**Step 3 — Fill out the application form (~15 minutes)**  
https://docs.google.com/forms/d/e/1FAIpQLSc0mJQpSv9MvOsUgxcrhGE953s90J-Nq_hoDPsbNy4GREP8nA/viewform

Short. No resume upload required. The form contains questions you can't answer without having actually opened the code — a specific thing you'd change, and what you make of the security posture. That is our proof that you did step 1. We reply to everyone who completes the form.

---

*OperationKit · Apache-2.0 · the core stays free · https://github.com/m1keluka/OperationKit*

