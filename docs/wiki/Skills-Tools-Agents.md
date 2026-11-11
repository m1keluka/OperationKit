# Skills, Tools & Agents

OperationKit's work isn't just "send a prompt to a model." Procedures and context are first-class, versioned files:

- **Skills** — `skills/<slug>/SKILL.md` — a packaged procedure for a recurring kind of task (a checklist, a repo-specific workflow, a step-by-step runbook).
- **Agents** — `agents/<slug>.md` — a persona/role definition that loads a set of skills.
- **Tools** — the underlying capabilities a skill can call (an API integration, a CLI, an MCP server).

These are plain markdown with a defined frontmatter schema — not a database row inside one vendor's product, which is what makes them portable across models (see [Model Portability](./Model-Portability)) and across installs.

## How it's surfaced in the product

The Agents admin tab (Settings → Agents, global-admin only) shows the agent roster, their assignments, and a **skill graph** — a visual map of which agents load which skills. In code: `app/client/src/components/SkillGraph.tsx` (the graph UI) and `app/server/src/services/skill-graph.ts` (the server-side graph builder).

An example skill pair ships in the repo at `examples/workspace/skills/` (`draft-update/SKILL.md`, `summarize-notes/SKILL.md`) so a fresh install has something concrete to look at before writing your own.

## Why it's a graph, not a flat list

A skill can call tools; an agent loads one or more skills. That graph is what the skill-graph service renders — it's the same structure that lets a skill be reused across multiple agents without copy-pasting it, and lets you see, at a glance, what an agent is actually capable of before you hand it a card.

## Writing your own

Add a markdown file under `skills/<slug>/SKILL.md` or `agents/<slug>.md` following the frontmatter schema the examples use, then assign the agent to a workspace from Settings → Agents. There's no compiled build step — the graph picks up a new file on the next load.
