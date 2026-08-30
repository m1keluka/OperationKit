# What OperationKit is

OperationKit (`cc.example.com`) is Example’s control plane for AI work. It is not a chatbot with a file picker. It is a **kanban of jobs** that become **live agent sessions** on a single VPS, with the same GitHub, Google, and repos we already use.

If you think in pictures, start with the chart. If you think in words, skip to **The loop**. Tables and databases sit in [Data](./07-data.md).

```mermaid
flowchart TB
  subgraph people["People"]
    You["You / a teammate"]
    Settings["Settings → You\nGitHub + Google"]
    You --> Settings
  end

  subgraph capture["Capture"]
    Board["Board card"]
    Jarvis["Jarvis chat"]
    Jobs["Jobs / cron"]
    You --> Board
    You --> Jarvis
    Jarvis --> Board
    Jobs --> Board
  end

  subgraph dispatch["Dispatch"]
    Obj["objectives row\n= source of truth"]
    Model["Model registry"]
    Seat["Seat: Claude / Grok / Codex"]
    Board --> Obj
    Obj --> Model
    Obj --> Seat
  end

  subgraph execute["Execute on the VPS"]
    Tmux["tmux session"]
    Repo["Repo on disk / worktree"]
    PR["GitHub PR"]
    Mail["Gmail as assignee"]
    Seat --> Tmux
    Tmux --> Repo
    Tmux --> PR
    Tmux --> Mail
  end

  subgraph watch["Watch"]
    Poller["Poller every ~3s"]
    Intel["session_intel"]
    Dash["Dashboard spend + seats"]
    Poller --> Obj
    Tmux --> Intel
    Intel --> Dash
  end
```

## The loop

Someone captures work (you, Jarvis, a Job, a meeting). It becomes an **objective** on the Board. Dispatch picks a **subscription seat** (Claude OAuth, SuperGrok, or ChatGPT/Codex) and a **model**. Execute is a tmux session on the host: the agent edits `/home/operator/projects/…`, opens a PR when asked, talks in the card. The **board status** is truth — not the agent’s last sentence. When the session dies, intel lands, and a human (or a Job) decides what happens next.

## Who it is for

You and your teammates. Everyone has their own login. Work is organized by **organization** (workspace) — for example Acme Corp, Marketing, Engineering. A card is assigned to a person; that person is who the agent acts as for mail and git.
You and your teammates. Everyone has their own login. Work is organized by **organization** (workspace) — one per company, client, or internal area, e.g. Acme Corp, Marketing, Engineering. A card is assigned to a person; that person is who the agent acts as for mail and git.

## What you see every day

- **Board** — create and run work
- **Jarvis** — talk to the system
- **Jobs** — recurring work
- **More → Content, Docs, Dashboard** — publish, vault, seats/spend/host
- **Avatar → Settings** — You (GitHub, Google, assistant, personal secrets), Secrets, Org, Agents, Platform

Unfinished surfaces (Contacts, Strategies, Development, Notes, Status, Feed) still exist at their URLs and in ⌘K. They are not the product yet.

## What it is not

- Not a shared Google/GitHub identity. Assigned user wins.
- Not API-key billing for the coding agents. Claude, Grok, and Codex run on **subscriptions**.
- Not “rebuild the Docker image for a TypeScript change.” That kills every live session. Code deploys restart Node only.

## One screen of truth

If the Board disagrees with the transcript, trust the Board, then go read the session. If spend looks wrong, trust Dashboard, then the account cards. If mail went out as the wrong person, check Settings → You and the card’s assignee.
