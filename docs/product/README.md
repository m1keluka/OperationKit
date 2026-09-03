# Command Center

**In a sentence:** Command Center is the board where we run AI coding agents as real work — Claude, Grok, and Codex — on our actual repos, as ourselves.

**In a paragraph:** You open a card, pick a model, and an agent session starts on the VPS. The card is the source of truth: queue → working → review → done. Assistant is how you talk to the system. Jobs are cards that fire on a schedule. Content, Docs, and Dashboard are the other daily tools. GitHub and Google connect per person, so Ava’s mail and PRs are Ava’s. Subscription seats (Claude / SuperGrok / ChatGPT) are shared operator accounts, not user logins.

Read [what it is](./01-what-it-is.md) (one page), then the rest as needed.

| Doc | Read this when |
| --- | --- |
| [What it is](./01-what-it-is.md) | You need the whole product in one sitting |
| [How it works](./02-how-it-works.md) | Loop, engines, seats — **flowchart** |
| [Using it](./03-using-it.md) | Board, Assistant, Jobs, Content, Docs, Dashboard |
| [You](./04-you.md) | GitHub, Google, secrets, acting-as |
| [Organizations & repos](./05-orgs-and-repos.md) | Linking a GitHub project and its living docs |
| [Operating](./06-operating.md) | Deploy, self-deploy, what not to do |
| [Data](./07-data.md) | Tables, SQLite, files — **ER chart + inventory** |
| [Living docs](./LIVING.md) | How these files stay true, and how every linked repo does the same |
| [Agent API](../api/README.md) | HTTP for people and third-party agents · [portable prompt](../api/AGENT-PROMPT.md) |

Architecture internals (modules, contracts, god files) stay in [`../architecture/`](../architecture/README.md). This folder is **product**.
