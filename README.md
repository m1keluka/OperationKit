# Operation Kit

**The infrastructure layer for AI implementation consultants.**

> Install it once per client, on the client's own server. They own it; you build on it.

Operation Kit is a ready-made base for putting AI to work inside a business. A consultant installs
one copy per client, on a server the client owns, in under an hour. The client gets a private web
app with a knowledge base of their own documents, AI workers that run jobs as cards on a board, an
optional chat with ready-made agents, and a secure connection for the AI apps their people already
use (Claude, ChatGPT, Grok). The consultant starts every engagement 80 to 90 percent of the way
there and spends their time on the client's actual workflows.

## Why the client owns the install

- **Their server, their data.** Every client has its own copy on its own server. There is no shared
  Operation Kit cloud and no central database holding several clients' data.
- **Their AI accounts.** Work runs on the client's own Claude subscription or API key (OpenAI and
  Gemini optional). No pooled or resold seats.
- **Fewer vendor-risk questions.** Because client data never sits on a vendor's systems, the usual
  "is your vendor SOC 2 audited?" question mostly becomes "is our own server set up well?". To be
  plain about it: **Operation Kit has no SOC 2 attestation**, and we do not claim one. See the
  [security overview](./docs/SECURITY-OVERVIEW.md) for what is protected and what is not done yet.
- **No lock-in to a model.** Agents, skills and the knowledge base are plain files on the server.
  Switch the AI provider and none of it moves.

## What is inside

| | What it does |
|---|---|
| **Knowledge base** | Drop in Excel, CSV, PDF and Word files; they become organized, linked notes you can ask questions of, with every answer citing its source. It works like a living wiki: originals are kept untouched, a page per person, organization and topic is compiled from them, good answers can be saved back as new pages, and a nightly cleanup flags contradictions and stale facts. Claude and ChatGPT chat exports and call transcripts (.txt, .docx, .vtt, .srt) can be imported too. Plain markdown, so it opens in Obsidian or any editor. |
| **AI workers on a board** | Anything that takes more than a few minutes becomes a card: *queue → working → review → done*. Each card runs a coding agent (Claude Code by default; Codex and Grok supported) in its own sandbox, and an independent AI reviewer checks the result before a person signs it off. |
| **Agent chat (optional)** | One ongoing chat per agent, like a personal assistant. Agents read and update their own notes, draft emails and calendar invites for a person to send (never on their own), and hand bigger jobs to the board. |
| **Connect any AI app (MCP)** | Claude, ChatGPT, Grok, Codex, Cursor and other MCP apps connect with a named, limited key and can use the same knowledge base, agents and board. [Connect your AI](./docs/CONNECT-YOUR-AGENT.md). |
| **Agent templates** | Each agent is one file (instructions, knowledge folders, tools, schedules). Starter templates ship in the box (Personal assistant, Knowledge librarian, Operator); consultants can write their own and drop them into a client's install. A shared marketplace for publishing agents is planned, and the install side is already built for it ([how it would plug in](./docs/agents/marketplace.md)). |
| **Connectors** | Link GitHub and Google Workspace once in Settings and choose which agents may use each. Credentials are stored encrypted and never shown to agents. |
| **Workspaces** | Separate teams or business units inside one install, each with its own board and knowledge folders. |

## Install

A fresh Ubuntu server, the client's domain on Cloudflare, and a Claude account. Claude Code on your
laptop follows [INSTALL.md](./INSTALL.md) and does the work; you answer a few questions and do two
short sign-ins. About 30 to 45 minutes, most of it waiting for the build.

```
 Person ──► Cloudflare Access ──► Cloudflare Tunnel ──► client's server (no open web ports)
            who are you?          private connection    ├─ Operation Kit app
                                                        └─ one sandbox per AI job
```

## Docs

| For | Read |
|---|---|
| Installing for a client | [INSTALL.md](./INSTALL.md) |
| Connecting Claude, ChatGPT, Grok or another AI app | [docs/CONNECT-YOUR-AGENT.md](./docs/CONNECT-YOUR-AGENT.md) |
| "Where does our data go?" (plain-language, one page) | [docs/SECURITY-OVERVIEW.md](./docs/SECURITY-OVERVIEW.md) |
| Running a live demo | [docs/DEMO-RUNBOOK.md](./docs/DEMO-RUNBOOK.md) |
| Using it day to day | [docs/product/README.md](./docs/product/README.md) |
| Agent chat | [docs/product/09-agent-chat.md](./docs/product/09-agent-chat.md) |
| Writing agent files | [docs/agents/agent-file-format.md](./docs/agents/agent-file-format.md) |
| Agent / HTTP / MCP API reference | [docs/api/README.md](./docs/api/README.md) |
| Model choice and portability | [docs/product/08-model-portability.md](./docs/product/08-model-portability.md) |
| Engineers: architecture and threat model | [docs/architecture/README.md](./docs/architecture/README.md) · [SECURITY.md](./SECURITY.md) |

## Status

Built to be a solid self-hosted install: Cloudflare in front, no open web ports, sandboxed AI jobs,
encrypted secrets, a forced password change for the first admin, automatic security updates. It is
not an audited SaaS. Known gaps (no SOC 2, no built-in two-factor or SSO beyond Cloudflare Access,
transcripts not encrypted at rest) are listed in the [security overview](./docs/SECURITY-OVERVIEW.md).

## License

Apache-2.0, see [LICENSE](./LICENSE).
