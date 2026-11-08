# obj 900309 — rollout and control test plan

**Status: proposal. Nothing in here has been executed.** This PR changes code and tests
only. No webhook was sent, no setting was flipped, no grant or key was edited, no PR was
merged and no deploy was run from this objective. The steps below are what to do *after*
the PR is approved and merged, in order, with the check that tells you each one worked.

---

## 1. What shipped in the PR

| # | Change | Where |
| --- | --- | --- |
| 1 | `needRecipientLabel()` — a `needs_agent` summary never speaks the agent key's label as the card's owner | `services/agent-webhooks.ts` |
| 2 | `classifyCompletion()` + `enqueueCompletion()` — two terminal need kinds, `completed` and `pr_merged`, delivered in the existing `needs_agent` shape | `services/agent-webhooks.ts`, `shared/types-surfaces.ts` |
| 3 | `recordPRTerminalState()` + `pr_terminal_states` — durable, idempotent, monotonic, logged merge recording | `services/objective-prs.ts`, `db/schema/tokens.ts`, `routes/github-webhook.ts` |
| 4 | `owner_bot` always echoed by the MCP tools, explicit `null` = unowned | `routes/agent-mcp.ts` |

New tables: `pr_terminal_states` only (additive, created by `CREATE TABLE IF NOT EXISTS` on
boot). No existing table's shape changes. No setting is added, so there is no flag to flip
on — which is a deliberate trade, see §5.

## 2. Deploy

This repo's production runtime is the **gated public cut**, not this repo's `main`:
`/api/health` on 2026-11-08T15:29Z answered `{"commit":"71e850752d63"}`, which is
`m1keluka/OperationKit` commit *"chore: sync from upstream (gated) (#71)"*. So the sequence
is longer than "merge and it is live":

1. Merge this PR into `your-org/operationkit@main`.
2. Let `oss-sync.yml` roll the public "Sync from upstream" PR forward, and merge that.
3. Deploy the public cut.
4. **Verify both halves** — a merged commit that is on disk is still not running, because
   `tsx` does not hot-reload:
   ```bash
   curl -s http://localhost:3002/api/health         # commit must be the new public cut
   ps -eo pid,lstart,args | grep '[t]sx server/src/index.ts'   # started AFTER that cut
   ```
   `pr_terminal_states` is created by the boot migration, so a backend restart is REQUIRED —
   a frontend-only deploy ships nothing here.

## 3. Control tests — after deploy, in this order

Each is a read or a naturally-occurring event. **None of them sends a synthetic webhook to a
real receiver**, and none of them edits a grant, a key or a config value.

### 3.1 Merge recording (the one to check first)

The next PR that merges is the test. It needs no setup.

```bash
# before: the row is open
curl -s localhost:3002/api/internal/objectives/<card> | node -e '...prs[].state'   # open
# ... Mike merges the PR ...
# after: the row is merged, and the server said so out loud
docker logs --tail=200 command-center | grep 'objective_prs'
# expect: [github-webhook] objective_prs <repo>#<n> → merged (rows 1/1)
```

PASS = state `merged` **and** a log line. The log line is the half that was missing before:
if the state does not move, the line now tells you whether it was 0 rows matched (the card
never linked its PR), 0 rows updated (already applied), or a thrown error with its message.

Backfill of the PRs already stuck at `open` (#642, #643, #644, #646–#653 …) is deliberately
NOT in this PR — it is a production data write. Do it as its own reviewed change once the
forward path is proven, by replaying each PR's real state from `gh pr view --json mergedAt`
into `recordPRTerminalState`, which is idempotent and monotonic and therefore safe to re-run.

### 3.2 Completion wake — the child case

Wait for the next child card to finish (reviewer PASS → `done`, no `review` stop). Then:

```bash
sqlite3 /app/data/command-center.db \
  "SELECT event_id, event, status, attempts FROM agent_webhook_deliveries
    WHERE event_id = 'cc_completed_<card>_k<key>'"
```

PASS = exactly one row, `event = 'needs_agent'`, `status = 'delivered'`. Then confirm with the
CoS routine's own log that it parsed and forwarded it — that is the hop this PR cannot test,
because testing it for real means sending a real webhook.

### 3.3 Completion wake — the top-level case must stay SILENT

The next top-level card Mike accepts from `review`:

```bash
sqlite3 … "SELECT COUNT(*) FROM agent_webhook_deliveries WHERE event_id = 'cc_completed_<card>_k<key>'"
```

PASS = `0`. A non-zero here means human-done semantics regressed and the owner is being
woken for a card Mike already closed in front of them.

### 3.4 Dedupe under a reopen

If a completed card is reopened and finishes again, §3.2's query must still return **one**
row. The event_id is per (kind, card, key) for the card's life, so this is a property of the
unique index rather than of timing — but it is worth confirming once on real data.

### 3.5 Owner round trip

From any bot on the shared connection:

```
create_objective(title: …, workspace: …, owner_bot: "Operation Kit")   → result.owner_bot == "Operation Kit"
get_objective(id)                                                      → owner_bot == "Operation Kit"
update_objective(id, title: "…")                                       → owner_bot still echoed
create_objective(title: …, workspace: …)                               → owner_bot == null (explicitly present)
```

PASS = the field is present in all four, including as an explicit `null`. If a client still
cannot see `owner_bot`, that is a **cached tools/list**, not a server capability — refresh per
`docs/api/MCP-REFRESH.md` before filing anything.

## 4. Rollback

| Symptom | Action |
| --- | --- |
| Completion wakes are too noisy | Unsubscribe `needs_agent` on the shared webhook (Settings → Agent keys → Webhook). The other needs stop too — see §5. |
| A bad wake is stuck retrying | `UPDATE agent_webhook_deliveries SET status='failed' WHERE event_id=…`. Delivery is per-row; one row cannot block another. |
| Merge recording is wrong | `recordPRTerminalState` is additive and monotonic; reverting the commit restores the old behaviour with no data migration. `pr_terminal_states` can be left in place — nothing else reads it. |

Each change is independently revertible: they share no state.

## 5. Decisions worth challenging in review

1. **No kill switch for completion wakes.** They ride the existing `needs_agent`
   subscription, so turning them off means turning off every need for that key. A
   `settings.completion_wakes_enabled` flag would be one line — the argument against adding it
   is that a dark-by-default flag is how the last two notification features ended up shipped
   but not actually on. Say the word in review and it goes in.
2. **`pr_merged` fires off the objective_prs transition**, so it is only as reliable as the
   merge recording — which is why change #3 lands in the same PR. If merge recording is still
   broken after §3.1, `pr_merged` will be silent and that is the symptom, not a second bug.
3. **No backfill of the stuck-open rows** (§3.1). Deliberate: it is a production data write
   and belongs in its own reviewed change.
4. **The root cause of the original merge-recording failure is not proven** and this PR does
   not claim it. See the Evidence section of the PR body: the delivery was received, the
   handler ran past the write, the code on the deployed cut was byte-identical to `main`, and
   the row never moved. What the available logs could not answer is which runtime failure
   swallowed it — so the fix makes the path durable and loud rather than patching a guess.
   §3.1's log line is what will answer it the next time, in one line, from `docker logs`.
