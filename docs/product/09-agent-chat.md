# Bots

**In a sentence:** Pick a bot and talk to it in one ongoing conversation, like a personal assistant. It can read and update its own notes, prepare email and calendar drafts for you to send, and hand bigger jobs to the board.

> ### Bot or conversation?
>
> They are different things, and the screen keeps them apart.
>
> | | What it is | How it is created | How it is removed |
> |---|---|---|---|
> | **A bot** | A durable identity — a name, a description, instructions, its own knowledge folders and tools. One file on the server. | By adding that file (see [Adding a bot](#adding-a-bot)). **Never from the Bots screen.** | By removing that file. |
> | **A conversation** | Your message history with one bot. There is exactly **one per bot**. | Implicitly, by your first message. | **Clear conversation** empties it — the bot stays. |
>
> That is why the Bots screen has no **New bot** button (it does not create bots) and no **New conversation** button (each bot already has one, and it is always open).

Bots are optional. The same bots and notes can also be reached from Claude, ChatGPT or Grok — see [Use your agents from Claude, ChatGPT or Grok](./10-agents-from-other-ai.md).

> ### Names that did not change
>
> This was a rename of what you *read*, not of how anything works. The page is
> still at `/chat`, the HTTP routes are still `/api/agent-chat/…`, the tables are
> still `agent_chat_*`, the server settings are still `AGENT_CHAT_*`, a bot is
> still defined by an **agent file** in the `agents/` folder, and the MCP tools
> are still `list_chat_agents` / `get_chat_agent`. Existing bookmarks, links and
> conversations keep working exactly as before.

---

## Using it

1. Open **Bots** (top bar on a computer, bottom bar on a phone). The address is still `/chat`, so old bookmarks still land here.
2. Pick a bot from the list. Each bot keeps **one ongoing conversation with you** — come back tomorrow and it is still there. Opening a bot reopens that conversation; it does not start a second one, and it does not create a bot.
3. Type what you need. Press **Enter** to send (**Shift + Enter** for a new line).
4. To show the agent something, **paste a screenshot straight into the box** (Ctrl/Cmd + V), drag an image onto the composer, or use the **paperclip**. Up to 4 images per message, 5 MB each, PNG / JPEG / GIF / WebP. An image on its own is a perfectly good message.

Under every reply you will see **"Answered by …"** — the AI service and model that wrote it (for example *Claude · claude-sonnet-5*, or *Demo (no AI account)*). The top of the conversation shows which one that bot uses.

Small grey lines between messages show what the bot did: "Checked inbox", "Read todo.md", "Created card #42".

**Clear conversation** (top right) deletes your messages with that bot from the server. **The bot itself is not deleted** — only the conversation is emptied. Board cards and saved notes stay.

## What a bot can do

What each bot may do is written in its agent file (below). The server enforces it — a bot never gets a tool its file does not list.

| It can… | How it works |
|---|---|
| **Read and update notes** | Only inside the knowledge-base folders its file lists. It cannot see anything else on the server. |
| **Read email and your calendar** | Through a connected account (or the demo's sample data). |
| **Prepare email replies and meeting invites** | As **drafts only**. A draft appears in the chat with **Send** / **Add to calendar**, **Edit** and **Discard** buttons. Nothing is sent until *you* press Send. A bot or API key can never press it for you. |
| **Look at a screenshot you paste in** | The image is stored in this install's own database next to your message, and handed to the AI as a real image. Only you can open it. If the agent's AI service cannot read images, the chat says so plainly rather than quietly ignoring the picture. |
| **Hand bigger jobs to the board** | Anything that takes more than a few minutes (building a page, a report, research) becomes a board card. The card shows up in the chat with its status — *Waiting to start → In progress → Ready for your review → Done* — and keeps updating while you watch. Tap it to open the card. |
| **Prepare email replies and meeting invites** | As **drafts only**. A draft appears in the conversation with **Send** / **Add to calendar**, **Edit** and **Discard** buttons. Nothing is sent until *you* press Send. A bot or API key can never press it for you. |
| **Hand bigger jobs to the board** | Anything that takes more than a few minutes (building a page, a report, research) becomes a board card. The card shows up in the conversation with its status — *Waiting to start → In progress → Ready for your review → Done* — and keeps updating while you watch. Tap it to open the card. |

## Where your conversation is stored

On **this server only** — the same database as the board. Nothing is copied to another service. The AI service that answers sees the messages of that conversation while it writes a reply, the same as any AI chat.

If someone pastes a password or key into a conversation by mistake, the server blanks out known secret values before saving.

Images you attach are stored the same way — as bytes in this install's database, next to the message. They are served back only to the person who attached them, and **Clear** deletes them with the conversation.

## The demo (no real accounts needed)

For a first look, an administrator can switch on a **demo personal assistant bot** with a made-up inbox, calendar, to-do list and contacts (a small design studio — all fake).

- **Turn it on:** Bots → *Turn on the demo bot* (shown to administrators), or set `AGENT_CHAT_DEMO=1` on the server.
- It copies three sample notes into the knowledge base at `demo/personal-assistant/` (never overwriting anything).
- Try: *"What's in my inbox?"*, *"Reply to Priya"*, *"Move the meeting with Priya to Friday"*, *"Add call the printer to my to-do list"*, *"Prepare a website quote for Elena"*, *"How are my cards doing?"*
- Sending a demo draft only marks it as sent. Nothing leaves the server.
- **Turn it off** the same way. The sample notes stay until you delete them.

With no AI account set up at all, the demo still works: replies come from a built-in script and say **"Answered by Demo (no AI account)"**. As soon as an AI account is connected, the same bot answers with real AI.

## Which AI answers

Chosen in this order:

1. The bot's agent file `provider:` (and `model:`), if set.
2. The install-wide default an administrator picked.
3. Otherwise the first one that is set up: Claude subscription → Anthropic API key → OpenAI → Grok → a custom endpoint → the demo script.

| Provider | What has to be set up (Settings → Secrets, by name — never paste values into a conversation) |
|---|---|
| Claude (subscription) | Nothing extra on a client install: the Claude sign-in done during installation is used. |
| Anthropic API | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Grok (xAI) | `XAI_API_KEY` |
| Custom endpoint (e.g. a LiteLLM proxy or a local model) | `AGENT_CHAT_OPENAI_COMPAT_BASE_URL`, optional `AGENT_CHAT_OPENAI_COMPAT_API_KEY`, and a `model:` |

Optional default models: `AGENT_CHAT_CLAUDE_MODEL`, `AGENT_CHAT_OPENAI_MODEL`, `AGENT_CHAT_XAI_MODEL`, … An administrator can pin the install default with `PUT /api/agent-chat/settings {"default_provider": "claude"}` (empty string = automatic).

## Adding a bot

Adding a bot is a **server-side** act, not something the Bots screen does. A bot is **one file**: `agents/<slug>/agent.yaml` (or `agent.md` with the settings at the top and the instructions below). The folder, the file and the format keep their existing `agent` names. The full format, starter templates and the import / export screen come with the agent templates feature (`docs/agents/agent-file-format.md`). The short version:

```yaml
name: Personal assistant
slug: personal-assistant
description: Keeps your inbox, calendar and to-do list in order.
avatar: PA
colour: green                      # blue | pink | green | amber | grey
version: 1.0.0
author: Your consultant
knowledge_folders:                 # folders INSIDE the knowledge base it may read and write
  - personal/notes
tools: [search, read_file, write_doc, email, calendar, create_objective]
# provider: claude                 # optional — otherwise the install default
# model: claude-sonnet-5           # optional
system_prompt: |
  You are a personal assistant for one busy person. ...
```

Tools a bot can be given:

| Name | Lets the bot… |
|---|---|
| `search`, `list_folders`, `read_file`, `write_doc` | find, open and save notes inside its `knowledge_folders` |
| `email` | read the inbox and prepare **draft** replies |
| `calendar` | read the calendar and prepare **draft** invites |
| `create_objective`, `get_objective`, `list_objectives` | put a job on the board and check on the cards it created |

New or changed agent files show up the next time someone opens **Bots** — no restart. If a file has a mistake, administrators see it listed with the reason.

The agents folder is `AGENT_FILES_DIR` if set, otherwise `agents/` in the AI workspace folder. The knowledge base is `KNOWLEDGE_BASE_DIR` if set, otherwise the install's knowledge base.

## Safety in one list

- Email and calendar are **draft-only**; only a person signed in to the app can press Send.
- A bot reads and writes **only** its own knowledge folders (paths are checked after following shortcuts/symlinks).
- A bot only gets the tools its file lists.
- Board cards a bot creates run like every other card — on a client install each one runs in its own locked-down sandbox (`SESSION_ISOLATION=docker`).
- Conversations are private: nobody else (and no API key) can read your conversation with a bot.
- AI keys are read from the server's secret store by name and only sent to that AI service. They are never shown, saved with a message, or logged.

## For developers

The code keeps its existing `agent` / `agent-chat` names — only the user-facing wording became "bot" (obj 900327).

- Server: `app/server/src/services/agent-chat/` (agent files, providers, tools, connectors, demo) and `app/server/src/routes/agent-chat.ts` (`/api/agent-chat`).
- Tables: `agent_chat_messages`, `agent_chat_drafts`, `agent_chat_cards` (`app/server/src/db/schema/agent-chat.ts`). No migration was needed or performed for the rename.
- Page: `app/client/src/components/agent-chat/`, routed at `/chat` and `/chat/:slug`.
- Plugging in a real mailbox or calendar: implement `MailConnector` / `CalendarConnector` in `connectors.ts` and return it from `resolveConnectors()`. Delivery happens only in `deliver()` / `add()`, which only the Send route calls.
