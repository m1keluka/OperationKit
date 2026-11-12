# Operation Kit Dev bot

**Operation Kit Dev** is a bot that ships with every install. Open **Bots → Operation
Kit Dev** (`/chat/operation-kit-dev`) and tell it what you want to set up. It helps with:

- **Integrations** — connecting GitHub, Google Workspace, other connectors and MCP
  servers (Settings → Integrations), and storing keys safely (Settings → Secrets).
- **Email** — picking a provider (Resend, Postmark or SMTP), setting the sender,
  sending a test and adding the SPF / DKIM / DMARC records (Settings → Email).
- **Branding** — product name, colours, logos and favicon (Settings → Branding).
- **Creating bots, agents and skills** — it asks a few questions, writes the
  complete file, and tells you where it goes.
- **Your business** — it keeps a short profile of how your business works and
  suggests automations that would save you time.

Press the **i** button in the conversation header for the how-to text and example
prompts.

## What it can and cannot do

| It can | It cannot |
|---|---|
| Read the knowledge base folders `business/`, `organizations/`, `products/`, `projects/`, `topics/` | Read `people/` or any other folder |
| Write its own notes: `business/profile.md`, `business/automation-ideas.md` | Change settings, connect accounts or send email — you press those buttons |
| Read the board cards you can see, and what is waiting on you | See secret values (it only ever needs a key's **name**) |
| File a board card for bigger work (a new integration, a new skill) | Start work by itself without the card showing up on your board |

Its tools are `search`, `list_folders`, `read_file`, `write_doc`, `create_objective`,
`get_objective`, `list_objectives` and `board_briefing`. It has no email or calendar
tools. Its instructions also tell it to write only under `business/`, even though
`write_doc` could reach the other folders it reads.

Cards it files are ordinary task cards (the same path as any chat bot not in the
`owner_bot` registry), so a coding session can actually build what it describes.
It is deliberately **not** in the bot registry (`services/bots/bot-registry.ts`):
registered bots file *read-only* jobs, which would stop it from handing off build work.

## Creating a bot, agent or skill

The **Agents** page now opens with **Make a new bot, agent or skill**:

- **Bot** — someone you chat with on the Bots page. One file: `agents/<slug>/agent.md`.
- **Agent** — a worker that picks up board cards. One file: `agents/<slug>.md`.
- **Skill** — how-to steps an agent follows for one recurring task: `skills/<slug>/SKILL.md`.

It offers three ways in:

1. **Ask the Operation Kit Dev bot** — *Create a bot / an agent / a skill* opens the
   bot's conversation with the request already typed in (`/chat/operation-kit-dev?prompt=…`).
   Nothing is sent until you press Send. If the bot is not on your install
   (built-in bots switched off with `AGENT_CHAT_BUILTINS=0`), this tile shows the
   copy-paste setup prompt instead.
2. **Start from a template** — Agents → Templates.
3. **Paste or import a file** — Agents → Templates → **Paste agent file** (or
   *Import agent file*). The file is checked before anything is added.

For a **bot**, the Dev bot writes the full `agent.md` in chat. Copy it, choose
**Paste a bot file**, check it and press **Add agent**. For an **agent** or a
**skill**, it files a card with the full file text in the brief; the coding session
adds the file (for skills, `okit new skill <slug>`, then `okit validate`).

## Customising it

Like every built-in bot, an agent file with the same slug replaces it:
`agents/operation-kit-dev/agent.md` in the install's agents folder. Start from the
shipped file, `app/server/src/services/agent-chat/builtin/operation-kit-dev/agent.md`. `AGENT_CHAT_BUILTINS=0` hides all
built-in bots.

---

## Brief: proactive business learning and automation recommendations

This is the design brief for the "learns about your business and recommends
automations" behaviour, and what v1 ships.

### Goal

The bot should know the business well enough that the owner never repeats
themselves, and should *bring* ideas — "you file the same invoice-chasing card
every Monday; want me to automate it?" — instead of waiting to be asked.

### v1 (in this release) — conversation-driven, all inside the bot's instructions

- **Memory is a file the owner can read.** `business/profile.md` has fixed
  sections: *What we do, Customers, Team, Tools we use, Where time goes, Goals right
  now, Brand*. The bot reads it at the start of a conversation and updates it
  (read first, write the full file, under about a page) when it learns something.
  It says in one line what it saved. Business facts only — no secrets, no personal
  details beyond name and role.
- **It offers once, never nags.** If there is no profile, it offers a five-question
  intake once. If the owner says not now, it helps with the actual request and
  moves on.
- **It learns passively first.** Before asking, it searches the knowledge base
  (`organizations/`, `products/`, `projects/`, `topics/`) and reads the board
  (`list_objectives`, `board_briefing`). Recurring manual cards are the strongest
  automation signal.
- **One question at a time**, woven in after it has answered what was asked.
- **Ideas are a ledger, not a chat message.** `business/automation-ideas.md` holds
  each idea with *why* (the evidence), *what it needs* (integration, secret name,
  bot / agent / skill), *effort* and *status* (suggested / accepted / declined /
  built, plus the card number). It suggests at most three at a time, ranked by time
  saved, and never re-suggests a declined idea.
- **Accepted ideas become cards.** Settings-only work is walked through; anything
  else is filed with `create_objective` with a brief a stranger could execute.

### Staged for v2 (not built yet)

- **A scheduled review.** A weekly routine ("look at the last week of cards and the
  profile; add any new automation ideas; tell me the best one") so ideas arrive
  without a conversation. Agent-file `schedules:` become routines only when a bot
  is *installed* from a template (switched off), not for built-ins, so this needs
  either an install step for built-in schedules or a routine created from Settings.
- **Signals beyond the board**: connected inbox / calendar volume, connector usage,
  and knowledge-base setup results, each behind the person's own access.
- **A "Suggested automations" surface** on the board or the Setup page that reads
  `business/automation-ideas.md`, so accepting an idea is one click.
- **Measuring it**: how many ideas were suggested, accepted and built, and the time
  each accepted automation saves.

### Guardrails that stay in every version

- It never asks for or stores a secret value.
- It never sends email, changes settings or connects accounts on its own.
- Everything it learns is a plain file in the owner's knowledge base that they
  can read, edit or delete.
- It writes only under `business/`.
