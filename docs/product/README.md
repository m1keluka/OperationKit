# OperationKit

**In a sentence:** OperationKit is the infrastructure layer an AI implementation consultant installs for each client, on the client's own server: a knowledge base, AI workers that run jobs as cards, optional agent chat, and an MCP connection for the AI apps people already use.

**In a paragraph:** You open a card, pick an agent, and a sandboxed worker session starts on the server. The card is the source of truth: queue → working → review → done. The **Knowledge base** holds the client's files and notes; **Chat** is one ongoing conversation per agent; **Agents → Templates** adds ready-made agents from one-file templates; **Settings → Connectors** links GitHub and Google Workspace. Claude, ChatGPT and Grok reach the same notes, agents and board through one MCP address. Each client's AI work runs on that client's own AI account.

New install? Start with [INSTALL.md](../../INSTALL.md). Connecting an outside AI app: [Connect your AI](../CONNECT-YOUR-AGENT.md). The plain-language security page: [Security overview](../SECURITY-OVERVIEW.md).

Read [what it is](./01-what-it-is.md) (one page), then the rest as needed.

| Doc | Read this when |
| --- | --- |
| [What it is](./01-what-it-is.md) | You need the whole product in one sitting |
| [How it works](./02-how-it-works.md) | Loop, engines, seats — **flowchart** |
| [Using it](./03-using-it.md) | Board, Chat, Jobs, Knowledge base, Dashboard |
| [You](./04-you.md) | GitHub, Google, secrets, acting-as |
| [Organizations & repos](./05-orgs-and-repos.md) | Linking a GitHub project and its living docs |
| [Operating](./06-operating.md) | Running a client install (update, back up, reset), and deploying this repo |
| [Data](./07-data.md) | Tables, SQLite, files — **ER chart + inventory** |
| [Model portability](./08-model-portability.md) | Configuring engines and LiteLLM model groups: Claude, Codex, Grok, Gemini, local models |
| [Agent chat](./09-agent-chat.md) | Talking to an agent in one ongoing chat; drafts-only email/calendar; the demo assistant |
| [Agents from Claude, ChatGPT or Grok](./10-agents-from-other-ai.md) | Reaching the same agents and knowledge through the MCP connection |
| [Living docs](./LIVING.md) | How these files stay true, and how every linked repo does the same |
| [Agent API](../api/README.md) | HTTP for people and third-party agents · [portable prompt](../api/AGENT-PROMPT.md) |

Architecture internals (modules, contracts, god files) stay in [`../architecture/`](../architecture/README.md). This folder is **product**.
