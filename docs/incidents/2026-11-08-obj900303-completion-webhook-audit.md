# Why Operation Kit was never pinged when card #900303 finished

**Objective 900305 — read-only incident audit. 2026-11-08. No mutation, no test sends, no
deploy, no permission or owner-field changes were made.** Every claim below is backed by a
read performed during this session; unverifiable items are listed as unknowns, not guesses.
All times are **ET (UTC−5)**; the raw records are UTC.

## Short answer

**No, a ping was not going to happen for #900303 — and under the documented configuration
that is expected behaviour, not a delivery failure.** Three independent reasons, each
sufficient on its own:

1. **#900303 never entered a state that wakes an agent.** The only completion-ish signal the
   general wake carries is `needs_agent`, and `classifyNeed()` only fires for cards in
   `working` / `ai_review` / `review`. #900303 is a **child task** (parent #900302), so the
   reviewer PASS routed it **straight to `done`**, skipping the `review` state entirely —
   the one state that would have produced a wake. Its sibling-in-spirit #900302 is top-level,
   went to `review`, and *did* produce the CoS forward you saw.
2. **`owner_bot` on #900303 is `null`** (directly observed on the full row). Even if a wake
   had fired, the CoS routine routes by `owner_bot`; `null` means "unowned → CoS handles it
   itself" and it would **not** have been forwarded to Operation Kit.
3. **The PR-merge path cannot ping either.** Command Center never recorded the merge of
   PR #651 (nor #649, nor #643) — all three are still `state=open` in its own PR log — so no
   `pr → merged` event is generated at all, and `merged` is not in the default subscription.

## Timeline (ET)

| Time (ET) | Fact | Source |
|---|---|---|
| 09:10:28 | Session `cc-900303-…` starts (`last_start_at` 09:10:31, reason `unattributed`) | `GET /api/internal/objectives/900303` |
| 09:32:57 | PR #651 opened on GitHub | GitHub API `pulls/651.created_at` |
| 09:33:00 | GitHub `pull_request.opened` delivered to CC, 200 | hook 654232949 deliveries |
| 09:33:02 | CC PR log row created for #651, `state=open` | `objective_prs` via internal row |
| 09:42:28 | Reviewer session `cc-review-900303-1794148948586` starts | session id epoch |
| 09:44:47 | Last worker activity | `last_activity_at` |
| **09:45:02** | **`ai_review_verdict=pass`, `status=done`** (one update, no `review` stop) | `updated_at` |
| 09:58:20 | **Mike merges PR #651** (`merged_by: m1keluka`) | GitHub API |
| 09:58:22 | GitHub `pull_request.closed` (merged) delivered to CC → **200**, body `{"ok":true,"entryId":4756,"status":"draft"}` | hook delivery record |
| 10:06 | CC PR log for #651 still `state=open`; same for #649 and #643 | internal rows |

## Expected vs observed, per hop

### Hop 1 — Command Center event generation

| | Expected | Observed |
|---|---|---|
| `needs_agent` wake | Fires only for `working`/`ai_review`/`review` (`classifyNeed`, `agent-webhooks.ts`) | **None possible.** #900303 went `ai_review → done`. `poller-ai-review.ts:810-811` sets `done` for a non-project card, and `mustRouteToHumanReview()` (`lib/human-tracked.ts:22`) returns **false** for any card with a `parent_id`, so the human-`review` park never applied. Parent #900302 has `delegate_mode=0`, so `delegatorParentOf()` is `null` too — nothing forced `review`. |
| `done` status event | A `status → done` row IS written to `objective_events` by trigger `trg_objective_events_status`, and `mapChange()` maps it to the `done` webhook event | Generated (trigger is unconditional). Whether it was *delivered* depends on the key's subscription — see Hop 2. |
| `merged` PR event | `pull_request.closed+merged` → `markPRStateByRepoAndNumber(repo, n, 'merged')` → trigger `trg_objective_events_pr_state` → `mapChange('pr', 'open', 'merged')` → `merged` | **Broken.** The webhook was delivered and the handler ran to completion (its success body `{ok, entryId, status}` is only returned after the merged branch), yet `objective_prs.state` for **#651, #649 and #643** is still `open` with `updated_at` unchanged. No `pr` state-change event exists, so `merged` can never fire. Cause not provable from here (the update is wrapped in a `try/catch` that only `console.warn`s; the repo string and PR number match exactly). |

### Hop 2 — Command Center delivery to the shared webhook

Deliveries are gated on: the subscribed key must equal `objectives.agent_key_id` (**5, "OpKit"** for #900303 ✅), the key live, the webhook enabled, the card inside the key's workspace scope (`operationkit` ✅), and the event subscribed.

**The one thing I could not read is the subscription itself.** `agent_key_webhooks` and
`agent_webhook_deliveries` are only exposed through `GET /api/agent-keys/:id/webhook[/deliveries]`,
which requires a cookie/JWT session; this jail has only a session token (every such call
returns 401). So:

- If the shared webhook is configured **as documented** (`docs/api/bots/cos-card-wake.md`
  step 2: *"Send these events: `needs_agent` only (untick the defaults)"*) → **nothing was
  sent for #900303, by design.**
- If it kept `DEFAULT_AGENT_WEBHOOK_EVENTS` (which **do** include `done`) → a `done` POST was
  queued and sent. That would still not reach Operation Kit — see Hop 3.

Either way the result at Operation Kit is the same; the two cases differ only in whether a
delivery row exists.

### Hop 3 — Grok "Command Center card wake" routine → General

The routine's instructions (`docs/api/bots/general.md:143-145`) are written for the
`needs_agent` body: route on `owner_bot`, fall back to handling it when `owner_bot` is `null`
or unknown. A `done` event body has no `need` block, and the routine has no rule for it.
With `owner_bot = null` on #900303, even a correct `needs_agent` wake stops at CoS.

**Observed:** a CoS forward exists for **#900302** (top-level, currently `review`,
`owner_bot` also `null`) and none for #900303. That is exactly what the rules above predict.
I cannot see the Grok side from here, so "CoS received nothing for #900303" remains an
inference from the CC-side rules, not a Grok-side observation.

### Hop 4 — user-facing follow-up

No follow-up was observed for #900303 in this conversation. Given hops 1–3, none was due.

## Deployed capability (runtime vs PR649)

- `GET /api/health` reports commit **`926f0632c0da`**. That commit is **not** in
  `your-org/operationkit`; it is `m1keluka/OperationKit` **main @ 2026-11-08
  01:53:38Z**, *"chore: sync from upstream (gated) (#70)"* — i.e. the running checkout is the
  public sync, not the private repo. (Method validated: the same 12-char lookup resolves
  `444de1a86e66` in the private repo.)
- That sync is **after** PR #649 (merged 2026-11-07 22:52Z) and #650 (2026-11-08 01:37Z), so
  **owner_bot + the one shared `needs_agent` webhook ARE deployed**. Confirmed two ways:
  `/api/openapi.json` served live carries `owner_bot` and `needs_agent`, and the deployed
  copies of `agent-webhooks.ts` / `github-webhook.ts` at that sha are byte-identical to the
  private `main` versions apart from sanitized hostnames.
- It is **before** PR #651 (merged 2026-11-08 14:58:20Z), so the #900303 connector fix is
  **merged but not deployed** — a public sync + deploy is still pending.

## Owner metadata, verified

- `objectives.owner_bot` for **#900303 is `null`** — read directly from the full internal row,
  not inferred from #900302.
- The MCP `get_objective` output omitting the field entirely is **consistent with `null`, not
  with a missing capability**: `compact()` in `routes/agent-mcp.ts` drops every `null`/empty
  value before returning the card. The field exists in the schema, the OpenAPI spec and the
  MCP `create_objective`/`update_objective` inputs.
- #900302 (`null`), #900270 (`null`) and #900245 (`null`) are the same — **Operation Kit is
  not setting `owner_bot` on the cards it files.**

## Earliest proven gap

**Hop 1.** There is no completion-shaped wake in the system at all: `needs_agent` is defined
as "a card needs a human/agent decision *while it is still open*", and a card that completes
cleanly leaves that set rather than entering it. A second, independent Hop-1 defect is that
**merges are never recorded** (`objective_prs` stuck at `open` for every recent merged PR),
which kills the `merged` event before any subscription question arises.

Everything after Hop 1 is secondary: `owner_bot=null` would have mis-routed a wake even if
one had existed.

## What I could NOT observe (exact missing reads, not assumptions)

1. The `agent_key_webhooks` row for key 5 — URL, `enabled`, and **which events it subscribes
   to**. Requires a cookie/JWT admin session; this jail has only `CC_SESSION_TOKEN` (401).
2. `agent_webhook_deliveries` rows around 2026-11-08 09:45 ET — whether a `done` delivery
   exists, and its status/attempts/last_error.
3. Container logs (`[github-webhook] objective_prs state update failed`, `[agent-webhook] …`)
   and direct SQLite access — not reachable from this sandbox.
4. The Grok side: whether the CoS wake routine received anything for #900303.
5. `settings.agent_webhook_cursor` and the live `settings` table.

## Precise next action (one screen, read-only)

Open **Settings → You → Agent keys → key #5 "OpKit" → Webhook** and read (a) the ticked
events and (b) the delivery log around 09:45 ET on 2026-11-08. That single screen closes
unknowns 1 and 2 and decides between "sent nothing, by design" and "sent a `done` that CoS
ignored". Nothing else in this audit depends on it — the answer to *"should we have been
pinged?"* is **no** either way.

Two follow-ups this audit supports but deliberately does not implement (each needs its own
objective):

- **Set `owner_bot` on cards Operation Kit files/claims** (`create_objective(…, owner_bot:
  "Operation Kit")` / `update_objective`). Without it, no wake can ever reach OpKit — CoS
  keeps every one of them.
- **Merge recording is broken** — `objective_prs.state` never leaves `open` even though the
  GitHub `closed+merged` delivery is received and processed (200). Worth its own card; the
  diagnosis needs container logs.
- If a *completion* ping is actually wanted, that is a **new capability**, not a repair:
  either subscribe the shared webhook to `done`/`merged` **and** teach the CoS routine to
  route non-`need` bodies, or add a completion need kind. Today's design intentionally wakes
  an agent only while a card is still open.
