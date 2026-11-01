# Accounts, Subscriptions & Seats

OperationKit runs coding sessions through subscriptions you already pay for — a Claude plan, a SuperGrok plan, a ChatGPT/Codex plan — not a metered API key billed per token. This page covers how those subscriptions are pooled as **seats**, how a session gets one, what happens when a seat fails, and how that is different from a person's own identity on the system.

## Two different things named "account"

- **Seats** — the Claude / Codex / Grok subscription logins OperationKit spawns sessions under. Managed in **Settings → Seats** (admin only). A seat is infrastructure, not a person.
- **People** — OperationKit users. Each person connects their own GitHub (fine-grained PAT) and Google Workspace account on Settings → You, so a card assigned to them opens PRs and sends mail as themselves, not as a shared bot identity.

A card's assignee is who the session acts as for GitHub/Google purposes; which seat it runs the model on is a separate, independent choice.

## The seat model

Each seat has:

| Field | Meaning |
|---|---|
| kind | `claude`, `codex` or `grok`. Any number of seats per kind. |
| label | A display name you choose ("Seat 1"). |
| priority | Lower is used first. |
| enabled | A disabled seat is never picked. |
| credential | Either a **setup token** (Claude — from **Sign in with Claude** or pasted), stored in the secrets store, or the CLI's own **login** files in the seat's private home directory (Codex, Grok). |
| expiry | When the credential expires, if known. |
| health | `healthy`, `cooling_down`, `needs_reconnect`, `needs_admin`, `credits_exhausted` or `disabled`. |
| cooldown until | When a cooling seat can be used again. |
| consecutive failures | Drives the back-off for rate limits with no stated reset. |

There are no built-in seats. A fresh install starts with an empty pool. An operator who wants seats declared up front can point `CC_SEAT_POOL_DEFAULTS` at a JSON file (`[{ "id": "s1", "label": "Seat 1", "kind": "claude", "priority": 0 }]`); seats saved from Settings always win over that file. Upgrading keeps every existing seat, its name, priority and usage history.

### Credentials are never shown back

A pasted setup token goes straight into the secrets store (AES-256-GCM, every write and read audited). The seat record keeps only the name of that secret. The screen and the API show a masked summary only: the credential kind, at most its last 4 characters, the date it was added and its expiry. Seat credentials are never injected into other sessions' environments and never go through the secrets broker. Each one is handed only to the session assigned to that seat.

Codex and Grok seats are connected with the official CLI's own device login: press **Add**, open the link shown, enter the code, and the login lands in that seat's own home directory.

### Adding a Claude seat (no terminal)

**Settings → Seats → Add Claude seat** signs in from the browser. It runs the same sign-in `claude setup-token` runs, so the result is the same one-year subscription token:

1. Give the seat a label (optional). The screen shows a **Sign in with Claude** button. The server has just started a Claude OAuth sign-in with PKCE, using Claude Code's own client and the inference-only scope that `setup-token` asks for.
2. Press it and sign in to claude.ai with the subscription account (Pro, Max or Team). Claude then shows an **Authentication code** page ("Paste this into Claude Code"). The code looks like `abc123…#xyz789…`.
3. Copy that code, paste it into the field in the app and press **Connect seat**. The server checks that the part after `#` matches the link it made, then trades the code and its PKCE verifier for the token. It saves the token exactly like a pasted one, in the secrets store.
4. The server runs the seat's test turn straight away. That is one tiny subscription call that has to reply `CLAUDE-OK`, the same check the installer runs. The seat shows **Healthy** once it passes.

Details that matter:

- **The link works for 10 minutes and the code works once.** If the link expires, if you paste a code from a different link, or after 5 failed tries, the screen offers **Get a new link**. A mistyped code can simply be pasted again.
- **The PKCE verifier stays on the server.** It is held in memory only, never sent to the browser, never logged and never saved. It is dropped when the sign-in finishes, expires or is cancelled. A server restart in the middle of a sign-in means you need a new link.
- **Subscription only.** If Claude replies with anything other than a subscription token (`sk-ant-oat…`), nothing is saved. There is no API-key fallback.
- **Reconnect** on an existing Claude seat runs the same sign-in and replaces that seat's token in place. The seat keeps its id, priority and history, and any `needs reconnect` park is cleared.
- **Pasting a token still works.** Choose **Have a setup token already? Paste it instead** to paste the output of `claude setup-token` from any machine signed in to the subscription.

API: `POST /api/admin/seats/claude-oauth/start` (optional `seatId` to reconnect) returns `{ loginId, url, expiresAt }`. `POST /api/admin/seats/claude-oauth/finish` takes `{ loginId, code, label?, seatId? }` and returns `{ seat, outcome }`. On failure it returns `code`: `state_mismatch`, `expired`, `unknown_login`, `bad_code`, `too_many_attempts`, `not_subscription` or `exchange_failed`. Both routes are admin only.

**The installer works the same way.** `install/claude-login.sh` (with `CLAUDE_AUTH=login`) prints the **Sign in with Claude** link and waits for you to paste the code. Typing is hidden. It then checks the token with the same `CLAUDE-OK` call. Pasting a setup token at that prompt also works, and `--token` skips the link altogether.

## How a session gets a seat

Every session picks a seat first, then builds its sign-in from that seat:

1. Only seats of the card's engine that are enabled, healthy and have a usable credential are candidates.
2. Lowest priority number wins; ties go to the seat with the fewest live sessions, then the fewest sessions today, then the fewest tokens.
3. **Sandboxed sessions** (`SESSION_ISOLATION=docker`) prefer an idle seat before priority, so two concurrent sandboxed sessions land on two different seats while any is free. A Claude seat's token is passed into the sandbox as `CLAUDE_CODE_OAUTH_TOKEN`. A Codex or Grok seat's login directory is mounted into that one sandbox (at `~/.codex` or `~/.grok`) and nowhere else.
4. The seat a session used is recorded with the session, so the dashboard and the follow-up path know where it ran.
5. **Follow-ups** stay on their seat while it is healthy (so the CLI can resume its own transcript) and re-pick on the same engine when it is not.
6. If no seat is available, the card queues and starts automatically when one frees up.

**Install with no seats.** A sandboxed install that only sets the single server token (`SESSION_JAIL_CLAUDE_OAUTH_TOKEN`) keeps working unchanged: that token acts as one fallback seat. It stops being used as soon as you add a pasted Claude seat. A host (tmux) install keeps its existing CLI-login seats as they were.

### Several sessions on one login

- **Pasted setup tokens** do not refresh, so any number of sessions can share one safely.
- **CLI logins** (Codex, Grok, or a Claude login on the host) use a refresh token that rotates. Two sessions refreshing it at the same moment can log the seat out. Inside the sandbox each such seat is therefore **serialised**: it serves one live session at a time, and the next session takes another seat or queues. On the host (tmux) path sessions share the one login file as before — the CLI rewrites it in place.

## When a seat fails

| What happened | What the seat does |
|---|---|
| Rate limit / usage cap (429) | Cools down until the reset time the provider stated; with no stated time, backs off exponentially from 15 minutes up to a 5-hour ceiling. |
| 401 / expired or revoked login | Parked as **needs reconnect** until a passing test or a new credential (**Reconnect** → Sign in with Claude). |
| 403 organisation or plan disabled | Parked as **needs admin**: a re-login will not fix it, an admin of that subscription has to. |
| Credits or spend cap exhausted | Parked as **credits exhausted**, with no timer and no rotation churn (other seats on the same organisation would hit the same cap). The card is parked for a person to look at. |
| 5xx / overloaded / timeout | No penalty to the seat. The session is retried after a short wait. |

A completed turn with real usage proves a seat is live, so it clears a false cooldown or credits park immediately. Credential parks clear only on a passing **Test now** or a reconnect.

A timer probes Claude seats with one tiny subscription turn (never an API key) that must reply `CLAUDE-OK` every 30 minutes (`CC_SLOT_HEALTH_INTERVAL_MIN`). Codex and Grok seats are checked for their login files. Seats whose credential expires within **14 days** raise a dashboard alert so you can rotate them in time.

## Cross-engine failover (opt-in)

By default a card stays on its engine and queues when all of that engine's seats are down. You can turn on failover per workspace in **Settings → Seats** with an ordered list (default Claude → Codex → Grok):

- A card moves to the next engine **only when every seat of its own engine is unavailable**.
- The move is logged on the card (`seat_failover` in the activity log). The card's own engine setting does not change; the next session goes back to its own engine when a seat is free.
- A card can override the workspace: inherit, its own order, or **pinned**. A pinned card never moves (`PUT /api/admin/seats/card/:id/failover`).

## Reading seat state from an agent

`GET /api/agent/seats` (scope `board:read`) and the MCP tool **`get_seat_pool`** return which seats can take work now and when the next one resets. No credential, secret name or path is ever in that response.

## Terms of service

- **Connect only your own subscriptions.** Each client connects the subscriptions their own organisation holds. Never connect someone else's login.
- **Follow each provider's terms.** Anthropic, OpenAI and xAI each set the rules for their consumer and team plans. Pooling seats lets more separate, legitimately held subscriptions run work at the same time; it is not a way to stretch what any single plan allows.
- **The maker of OperationKit never holds client credentials.** Seats and their credentials live only in the client's own install, encrypted in its own secrets store.
- **Plan limits assume ordinary individual use.** Treat each seat's usage limits as what one person working normally would use, and add seats (or move to an API plan you pay for) when the work outgrows that.
- Sessions always run the official, unmodified `claude`, `codex` and `grok` CLIs. OperationKit never alters requests, never imitates another client, and never falls back to a metered API key when seats run out — it queues instead.

## What this is not

- Not a proxy and not a separate service. Seats are part of the session scheduler.
- Not the same mechanism as a person's GitHub/Google identity (Settings → You) or organization secrets (Settings → Secrets) — those inject into a session's environment the same way regardless of which seat ran the model; see [Model Portability](./Model-Portability) for how an engine choice and a seat relate.

## Credit

The failure classes and the cooldown-with-back-off approach on this page are adapted from **[OmniRoute](https://github.com/cheaper-inference/OmniRoute)** (MIT, Copyright (c) 2026 diegosouzapw). Only the ideas were adapted; no OmniRoute code is included. OmniRoute's proxy, browser-session providers and request-fingerprinting features were deliberately not used.

## Where to go next

- [Model Portability](./Model-Portability) — which engines are wired today and how routing to a provider is configured
- [External Agents](./External-Agents) — the API key a third-party agent uses is a per-person credential, unrelated to seat pooling
