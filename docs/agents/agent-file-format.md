# Agent files: one file per agent

An **agent** is an AI helper with its own instructions, the knowledge-base folders
it may use, and the tools it may use. Every agent is described by **one file**.
Because it is just a file, you can copy it, email it, keep it in a shared drive,
and import it into another install.

This page explains the file, how to add starter agents, and how to import and
export. No programming is needed.

---

## Where agent files live

Each agent has its own folder on the server:

```
agents/<slug>/agent.yaml
```

`<slug>` is the agent's short id, such as `personal-assistant`. The `agents`
folder sits inside the server's workspace folder (set `AGENT_FILES_DIR` to move
it). You normally never touch these folders by hand — the **Templates** page and
the `agent-template.sh` script write them for you.

An agent can also be written as a Markdown file, `agents/<slug>/agent.md`. The
settings go between two `---` lines at the top, and everything below them is the
agent's instructions.

## What is in the file

| Field | Needed? | What it means |
|---|---|---|
| `name` | yes | The display name, e.g. `Personal assistant`. |
| `slug` | yes | A short id: lowercase letters, numbers and hyphens. Must match the folder name. |
| `description` | recommended | One or two sentences that help people pick the right agent. |
| `avatar` | no | One emoji or up to two letters shown on the agent's badge. |
| `colour` | no | `blue`, `pink`, `green`, `amber` or `grey`. (`color` also works.) |
| `system_prompt` | yes | The agent's instructions, in plain language. |
| `knowledge_folders` | no | The knowledge-base folders the agent may read and write, e.g. `clients/example-co`. Always a folder *inside* the knowledge base. |
| `tools` | no | The tools and connectors the agent may use, by name (see below). |
| `model` | no | A specific AI model. Leave it out to use the workspace default. |
| `provider` | no | `claude`, `anthropic`, `openai`, `xai`, `openai-compatible` or `demo`. Leave it out to use the workspace default. |
| `schedules` | no | Jobs the agent runs on a timetable (see below). |
| `version` | yes for sharing | The file's version, like `1.0.0`. Raise it when you change the agent. |
| `author` | yes for sharing | Who made it — a person or a company. |

### Tool names

| Tool | What it allows |
|---|---|
| `search`, `list_folders`, `read_file`, `write_doc` | Search, browse, read and write the knowledge base — only inside `knowledge_folders`. |
| `create_objective`, `get_objective`, `list_objectives` | Create board cards for the coding tools, and check on them. |
| `email`, `calendar` | Read mail and calendar and prepare **drafts**. Nothing is sent until a person presses Send. |

Other names are allowed (for connectors a client adds), but the importer will
point out that they are not built in.

### Schedules

```yaml
schedules:
  - name: Morning briefing
    cron: "30 7 * * 1-5"      # 7:30 on weekdays
    prompt: |
      Write today's briefing and save it in personal/notes.
```

`cron` is the usual five-part timetable (minute, hour, day, month, weekday).
When an agent is added, each schedule is created **switched off**. Turn it on
when you are ready, so nothing runs by surprise.

### Secrets

Agent files are made to be shared, so they must **never** contain a password or
API key. If the file mentions a credential, mention it by **name only** (for
example "use the `CRM_API_KEY` secret") and store the value in
**Settings → Secrets**. The importer refuses a file that looks like it contains a
real key.

## A complete example

```yaml
name: Example helper
slug: example-helper
description: Answers questions about Example Co from its client folder.
avatar: "EH"
colour: pink
version: 1.0.0
author: Example Consulting
knowledge_folders:
  - clients/example-co
tools:
  - search
  - read_file
system_prompt: |
  You help the team with questions about Example Co.
  Only use what is in the client folder, and say which note each answer came from.
```

---

## Starter agents

Three general-purpose starters ship with every install:

| Starter | What it does |
|---|---|
| **Personal assistant** (`personal-assistant`) | Inbox, calendar and to-dos. Writes drafts only — never sends. |
| **Knowledge librarian** (`knowledge-librarian`) | Keeps the knowledge base organised and answers questions from it, citing the source note. |
| **Operator** (`operator`) | Turns requests into clear board cards for the coding tools, and reports progress. |

Add them from **Agents → Templates** (click **Add agent**), or from the server:

```bash
scripts/agent-template.sh install all              # all three starters
scripts/agent-template.sh install operator         # just one
```

**For installers:** set `STARTER_AGENT_TEMPLATES=all` (or a comma-separated list
such as `personal-assistant,operator`) in the app's environment and the starters
are added the next time the server starts. Running either again is safe: an agent
that already exists is left alone.

## Import an agent file

- **From the screen:** Agents → Templates → **Import agent file**, then pick the
  file. The file is checked first; any problem is listed by field with what to
  fix, and nothing changes until you click **Add agent**. If an agent with the
  same slug already exists you are asked before it is replaced.
- **From a folder on the server:** on the same page, type the path. For safety
  only a few folders are allowed (the page lists them) — copy the file into the
  `agent-imports` folder first.
- **From the command line:**

  ```bash
  scripts/agent-template.sh validate ./my-agent.yaml     # check only
  scripts/agent-template.sh import ./my-agent.yaml       # add it
  scripts/agent-template.sh import ./my-agent.yaml --overwrite   # replace an existing one
  ```

## Export an agent

- **From the screen:** Agents → Templates → **Export** next to any agent. You get
  a `<slug>.agent.yaml` file you can share.
- **From the command line:** `scripts/agent-template.sh export operator -o operator.agent.yaml`

Agents created before agent files existed can be exported too; their existing
instructions become the `system_prompt`, and the file is given version `1.0.0`.

## What happens when an agent is added

1. The file is checked. If anything is wrong, nothing changes.
2. The file is saved as `agents/<slug>/agent.yaml`.
3. The agent appears in every agent picker on the board.
4. Its schedules are created, switched off.
5. When a board card is assigned to the agent, the worker receives the agent's
   instructions plus its folder and tool limits. Workers that run in a sandbox
   (`SESSION_ISOLATION=docker`) never read the file themselves — the server reads
   it and passes the instructions in.

For developers: the format is implemented once, in
`app/server/src/services/agent-file.ts` (`parseAgentFile`, `serializeAgentYaml`),
and every entry point — the screen, the script, server start-up and the built-in
chat — goes through it.
