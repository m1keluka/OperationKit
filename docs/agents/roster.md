# The agent & skill roster (one place)

**Agents & Skills** (`/agents`, nav label "Agents & Skills") is the one place to see and
manage agents and skills. It has three tabs: **Registry** (roster, assignments, skill
graph), **Board layer** and **Templates**. Settings no longer carries its own copy:
`/settings/agents-skills` and `/settings/agents` redirect to `/agents?tab=registry`
(obj 900684, finishing obj 900495).

## Where the roster's agents come from

`GET /api/admin/agents` is built by `app/server/src/services/agent-roster.ts`. Every row
carries a `source`, and a `note` when the agent is not usable yet:

| `source` | Where it lives | Example | Shown as |
|---|---|---|---|
| `persona` | `<ai-workspace>/agents/<slug>.md` | `cto`, `general` | executive / routing-only |
| `chat` | `<ai-workspace>/agents/<slug>/agent.md` or `agent.yaml` | any Bots agent | chat agent |
| `builtin` | `app/server/src/services/agent-chat/builtin/<slug>/agent.md` | **`kb-setup` (Knowledge Base Setup)** | built-in |
| `registry` | an `agents` table row with no persona file | a seeded slug whose file was never written | no file |
| `starter-pack` | `starter-packs/<id>/pack.json`, pack switched off | **`kb-librarian` (Librarian)** | starter pack |

Skills: every `skills/<name>/` folder, plus sub-skills `skills/<parent>/<child>/SKILL.md`,
listed as `parent/child` under their parent.

## Why the knowledge base agents were missing

Before obj 900684 the roster was `readdirSync(agents).filter(f => f.endsWith('.md'))` —
flat persona files only. So:

- **Knowledge Base Setup (`kb-setup`)** ships with the app as a *built-in chat agent*
  (obj 900556). It is a folder (`builtin/kb-setup/agent.md`), and it does not live in the
  ai-workspace agents folder at all. Bots listed it; the roster never could. It is now
  listed as `built-in` with an "Open in Bots" link. Switch built-ins off with
  `AGENT_CHAT_BUILTINS=0`.
- **Librarian (`kb-librarian`)** belongs to the *Knowledge base file import* starter pack.
  Its persona file is only copied into the agents folder when the pack is switched on, and
  switching a pack on has no UI (only `POST /api/starter-packs/:id/enable` or
  `scripts/starter-pack.sh`). On an install where nobody did that, it existed nowhere a
  person could see. It is now listed as `starter pack` with how to switch it on. It is not
  installed automatically: enabling a pack also changes the workspace's agent pool and
  runs the pack's setup, which is an operator decision.
- **Any registry agent with no file** was hidden too, although it can still be picked
  for a card (that session would start without its instructions). It now shows as
  `no file`.
- **Sub-skills** were counted as files of their parent and never listed.
