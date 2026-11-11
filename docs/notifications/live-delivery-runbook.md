# Notification delivery — live verification runbook

**Objective 900368.** How an authorized operator proves, on the live install, that the
notification path merged in `#654` (obj 900309) is actually *generating and delivering*
wakes — and distinguishes "not delivered because it is broken" from "not delivered because
it was never supposed to be".

Scope note up front: `docs/notifications/obj-900309-rollout.md` is the *proposal* written
before #654 merged. This file supersedes its §2–3 with the state of the install **as of
2026-11-09**, the routing facts as they actually are in the code on `main`, and pass/fail
criteria that are reproducible by reads alone.

> **This runbook never sends a synthetic webhook to a production endpoint.** Every control
> test below rides a *naturally occurring* event and is observed with SELECTs and log reads.
> The one command that would send real traffic (`sendTestEvent`, Settings → Agent keys →
> "Send test") is called out in §6 and is deliberately NOT part of any pass criterion.

---

## 0. Who this is for and what you need

An operator with host shell on the VPS (`docker`, `sqlite3`) and read access to the board
DB at `/app/data/command-center.db`. Nothing here needs an agent API key, and nothing here
writes to the database.

```bash
DB=/app/data/command-center.db
q() { docker exec command-center sqlite3 "$DB" "$1"; }
```

---

## 1. Deploy prerequisite checklist — do this FIRST, and do not deploy yourself

Merged is not deployed. This repo's production runtime is the **gated public cut**
(`m1keluka/OperationKit`), not this repo's `main`, so the merged code has to travel three
hops before it is running. **Verifying is the operator's job; performing the deploy is not
part of this runbook** — if a gate below fails, stop and hand it to whoever owns deploys.

Two shas, and keeping them apart is the whole point of this section:

```bash
# What the install SAYS it is running:
CUT=$(curl -s localhost:3002/api/health | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).commit')
# What the public cut's main actually is right now:
PUBHEAD=$(gh api repos/m1keluka/OperationKit/commits/main --jq '.sha[0:12]')
```

| # | Gate | Command | Pass |
| --- | --- | --- | --- |
| 1 | The fix is merged upstream | `gh pr view 654 --repo your-org/operationkit --json mergedAt` | `mergedAt` non-null |
| 2 | The cut the install reports CONTAINS the fix | `gh api "repos/m1keluka/OperationKit/contents/app/server/src/services/agent-webhooks.ts?ref=$CUT" --jq .content \| base64 -d \| grep -c classifyCompletion` | `≥ 1` |
| 3 | No newer cut is sitting un-deployed | `echo "$CUT vs $PUBHEAD"` | equal, **or** a deliberate earlier cut that still passes gate 2 |
| 4 | The boot migration ran | `q "SELECT name FROM sqlite_master WHERE name='pr_terminal_states'"` | one row |
| 5 | The process is newer than the cut | `ps -eo pid,lstart,args \| grep '[t]sx server/src/index.ts'` | start time **after** `$CUT`'s commit date |

**Do not collapse gates 2–5 into "health says the right sha".** `$CUT` comes *from* health,
so asking health to confirm `$CUT` is a tautology — it agrees with itself. Each gate below
is phrased so it can **disagree** with the deploy:

- **Gate 2** asks GitHub, not the box, whether that sha contains the code.
- **Gate 3** catches the common half-deploy: the merge happened, a newer cut exists, and
  nothing rolled it out.
- **Gate 4** is a *runtime* fact: `pr_terminal_states` is created by `initTokensSchema()` on
  boot (`app/server/src/db/schema/tokens.ts`), so the table cannot exist unless a process
  carrying #654's schema module actually booted. A frontend-only deploy fails this gate,
  correctly — it ships nothing here.
- **Gate 5** is an *OS* fact neither the checkout nor the server can forge, and it catches
  the last case: checkout moved, table already present from an earlier boot, process never
  restarted.

One caveat on reading `$CUT` at all:

- **`$CUT` means "the code this PROCESS loaded" only on installs running obj 900368 or
  later.** `buildCommit()` is now pinned by `initBuildInfo()` at boot
  (`app/server/src/lib/build-info.ts`), before anything can serve. Before that change it
  resolved `git rev-parse HEAD` lazily on the *first health request*, so a process that
  booted on commit A and had the checkout fast-forwarded to B underneath it reported **B
  while still executing A** — `tsx` does not hot-reload. On an install that predates the
  pin, read `$CUT` as "what is on disk" and let gates 4 and 5 carry the runtime proof.
On an install carrying the pin, the startup log states it outright — the cheapest way to
read what the process loaded, and the one that survives the checkout moving afterwards:

```bash
docker logs command-center 2>&1 | grep '\[startup\] Running commit:' | tail -1
```

### Worked example — the install on 2026-11-09, gates 1–3 actually run

`#654` merged `2026-11-08T18:05:27Z` (merge commit `f9f9e795`) → **gate 1 PASS**.

```
CUT=eb69ebeb1424   PUBHEAD=eb69ebeb1424
m1keluka/OperationKit@eb69ebeb1424 = "chore: sync from upstream (gated) (#74)", 2026-11-09T14:31:41Z
  app/server/src/services/agent-webhooks.ts  -> 2 hits (classifyCompletion)
  app/server/src/services/objective-prs.ts   -> 10 hits (recordPRTerminalState / pr_terminal_states)
```

**Gate 2 PASS** — the reported cut contains #654's code. **Gate 3 PASS** — `$CUT` equals
`$PUBHEAD`, so no newer cut is sitting un-deployed.

Worth noting *how* that reading moved, because it is this section's own lesson: at
`15:01Z` the same endpoint answered `a268a606` (sync #72, 2026-11-08T22:08:44Z) and by
`15:4xZ` it answered `eb69ebeb` (sync #74). On a pre-pin install those two readings are
**indistinguishable** between "the install was redeployed" and "the same process finally
got around to shelling `git rev-parse HEAD` against a checkout that had moved underneath
it". That ambiguity is exactly what gates 4 and 5 exist to resolve — and exactly what the
boot pin removes going forward.

**Gates 4 and 5 were NOT verifiable from the objective's sandbox** — they need host shell
(`docker exec … sqlite3`, `ps`) and that sandbox has neither. Run them before you treat any
FAIL in §2–§5 as a defect rather than as "the code is not running yet".

---

## 2. The routing model — read this before interpreting any result below

Getting this wrong is the main way a healthy system gets reported as broken.

**For a card an agent key filed, the recipient of a wake is that creating agent key.** The
keyed half of the enqueue query is, verbatim (`app/server/src/services/agent-webhooks.ts`):

```sql
JOIN agent_key_webhooks w ON w.key_id = o.agent_key_id AND w.enabled = 1
JOIN agent_api_keys     k ON k.id = w.key_id AND k.revoked_at IS NULL
```

Three consequences, each pinned by a test in
`app/server/src/services/agent-webhooks-routing.test.ts`:

1. **`owner_bot` is payload-only.** It is carried raw on the body and named in `summary`;
   it does **not** select a receiver. Two cards owned by two different bots but filed
   through one shared key produce two deliveries to that **one** key. Fan-out by owner is
   the *receiver's* job.
2. **"Unowned → General" is a sentence, not a second delivery.** `needRecipientLabel()`
   writes `an agent (unowned — routed to the General)` into `summary` when `owner_bot` is NULL.
   The server has no CoS endpoint and sends nothing extra. The CoS routine is expected to
   read that body off the shared webhook and act. A "missing CoS delivery" is therefore only
   a defect if the *shared key's* delivery is missing — see §5.
3. **A card with `agent_key_id IS NULL` IS delivered to (obj 900553).** Before obj 900553 the
   JOIN above yielded zero rows for it, so every browser-created card (`POST /api/objectives`
   with a cookie has no `req.agentKey`, so `objectives-crud.ts` writes NULL) and every
   chat-created card was dark. Such a card now gets the **`needs_agent` family only** — open
   needs, `completed` (child-done) and `pr_merged` — never the raw status events. The
   recipient is chosen by `selectKeylessRecipient()` from webhooks that already exist, are
   `enabled`, on a live key, subscribed to `needs_agent`, and already cover the card's
   workspace (`cardInKeyScope`, the same gate as a key's own cards — nothing is widened):

   | Tier | Recipient | `owner_bot` |
   | --- | --- | --- |
   | 1 `owner_bot` | the webhook whose key label resolves (bot registry: id / name / alias) to the card's owner bot | set |
   | 2 CoS fallback | the General's key, then General's | empty, unknown, or the owner has no in-scope webhook |
   | 3 shared fallback | a key whose label names **no** registry bot — the shared connection, i.e. where an unowned API card goes | as tier 2 |

   Lowest key id wins inside a tier, so a need is exactly **one** delivery. A key labelled for
   a *different* bot is never a fallback. No candidate → no row (see §3 NOT A FAIL). Event ids
   and dedupe are unchanged: `cc_need_<event>_k<key>`, `cc_completed_<card>_k<key>`,
   `cc_pr_merged_<card>_k<key>`, with `INSERT OR IGNORE` on the UNIQUE `event_id`.

| Card origin | `agent_key_id` | Webhook path | Thread path (`bot_job_origins`) | Net |
| --- | --- | --- | --- | --- |
| Agent API (`origin='agent_api'`) | the filing key | ✅ delivers to the filing key | — | covered |
| Child of an agent-filed card | inherited (`lib/objective-ownership.ts`) | ✅ delivers to the filing key | — | covered |
| Bot chat (obj 900323) | NULL | ✅ obj 900553 — owner_bot / CoS | ✅ `services/bots/bot-thread-delivery.ts` | covered, both paths |
| Browser / UI (`origin='manual'`) | NULL | ✅ obj 900553 — owner_bot / CoS | ❌ no origin row | covered (webhook) |

`objectives-status.ts` still back-fills `agent_key_id` on the first agent touch
(`UPDATE … SET agent_key_id = ? WHERE id = ? AND agent_key_id IS NULL`); from that moment the
card is an ordinary keyed card and routes to that key, as in (1).

---

## 3. Control test — child review→done completion wake

**What it proves:** a child card that finishes via reviewer PASS (never entering `review`)
now wakes its owner. This is the exact path card #900303 took silently on 2026-11-08.

**Trigger:** wait for a naturally occurring child completion. Do not force one.

```bash
# 1. Pick a child card that reached done without passing through review.
q "SELECT e.objective_id, e.from_value, e.created_at
     FROM objective_events e JOIN objectives o ON o.id = e.objective_id
    WHERE e.kind='status' AND e.to_value='done' AND e.from_value <> 'review'
      AND o.parent_id IS NOT NULL AND o.agent_key_id IS NOT NULL
    ORDER BY e.id DESC LIMIT 5;"

# 2. Its wake, if the path works:
q "SELECT event_id, event, status, attempts, last_status_code, created_at
     FROM agent_webhook_deliveries WHERE objective_id = <card>;"
```

| | Criterion |
| --- | --- |
| **PASS** | Exactly **one** row with `event_id = 'cc_completed_<card>_k<key>'`, `event = 'needs_agent'`, `status = 'delivered'`, `last_status_code` 2xx. |
| **PASS (degraded)** | The row exists with `status = 'pending'`/`'failed'`. Generation works; **delivery** is the problem — go to §6, this is a transport/endpoint fault, not a routing fault. |
| **FAIL** | No row, *and* the card has `agent_key_id` non-NULL, *and* that key's webhook has `needs_agent` in `events` and `enabled = 1`. For a card with `agent_key_id IS NULL`, use §3c instead. |
| **NOT A FAIL** | No row because the key is revoked, or the card's workspace is outside the key's `workspaces` scope, or the webhook is not subscribed to `needs_agent`. Check all three before calling anything broken: |

```bash
q "SELECT o.id, o.agent_key_id, o.workspace, k.revoked_at, k.workspaces, w.enabled, w.events
     FROM objectives o
     LEFT JOIN agent_key_webhooks w ON w.key_id = o.agent_key_id
     LEFT JOIN agent_api_keys k ON k.id = o.agent_key_id
    WHERE o.id = <card>;"
```

**Expected payload shape** (`payload` column, `agent_webhook_deliveries`):

```json
{
  "event_id": "cc_completed_900303_k7",
  "event": "needs_agent",
  "objective": { "id": 900303, "workspace": "operationkit", "status": "done", "url": "https://cc.example.com/?objective=900303" },
  "owner_bot": "Operation Kit",
  "need": {
    "kind": "completed",
    "category": "completed",
    "why": "Finished and signed off without passing through Needs You — read the result and close out your side"
  },
  "status_summary": "done",
  "summary": "Card #900303 (operationkit) completed — Operation Kit: Finished and signed off …",
  "agent_key": { "id": 7, "label": "Grok: Shared Connection" }
}
```

`need.kind` must be `completed`, not `review`. `owner_bot` must be **present** — explicitly
`null` when unowned, never absent (an absent field means an old build is running; re-check §1).

### 3b. The silence case — a top-level card signed off in `review` must stay silent

```bash
q "SELECT COUNT(*) FROM agent_webhook_deliveries
    WHERE objective_id = <top-level card> AND event_id LIKE 'cc_completed_%';"
```

**PASS = `0`.** A non-zero here is a regression of human-done semantics: Operator closed the
card in front of the owner and the owner is being woken anyway. This half matters as much
as §3 — "more notifications" is not the goal.

### 3c. A browser/UI-created card (`agent_key_id IS NULL`) — now EXPECTS a delivery (obj 900553)

Before obj 900553 this was "0 rows is expected". It is now a pass/fail check: a keyless
card that completes (or needs an agent, or has its PR merge) must produce exactly one
`needs_agent` row, routed by `owner_bot` with the CoS fallback (§2.3).

```bash
# 1. A recent UI/chat-created card that reached done without passing through review.
q "SELECT e.objective_id, o.owner_bot, o.workspace, e.created_at
     FROM objective_events e JOIN objectives o ON o.id = e.objective_id
    WHERE e.kind='status' AND e.to_value='done' AND e.from_value <> 'review'
      AND o.agent_key_id IS NULL
    ORDER BY e.id DESC LIMIT 5;"

# 2. Its wake, and which key received it:
q "SELECT d.event_id, d.key_id, k.label, d.status, d.last_status_code,
          json_extract(d.payload,'$.owner_bot') AS owner
     FROM agent_webhook_deliveries d JOIN agent_api_keys k ON k.id = d.key_id
    WHERE d.objective_id = <card> AND d.event = 'needs_agent';"

# 3. The candidate webhooks (enabled, live, subscribed to needs_agent):
q "SELECT k.id, k.label, k.workspaces, w.enabled, w.events, k.revoked_at
     FROM agent_key_webhooks w JOIN agent_api_keys k ON k.id = w.key_id
    WHERE w.enabled = 1 AND k.revoked_at IS NULL AND w.events LIKE '%needs_agent%';"
```

| | Criterion |
| --- | --- |
| **PASS** | Exactly **one** row, `event_id = 'cc_completed_<card>_k<key>'`. If `owner_bot` is set and a candidate's label names that bot, `<key>` is that bot's key; otherwise it is the General's key (then General's), otherwise the shared connection's key. `owner` in the payload equals the card's `owner_bot` (`null` when unowned). |
| **PASS (degraded)** | The row exists but is `pending`/`failed` — a delivery fault, go to §6. |
| **FAIL** | **No row** while query 3 lists at least one candidate whose `workspaces` is NULL or includes the card's workspace (and whose owning user is an admin or a member of it), and that candidate is the owner's bot, the CoS/General, or a key whose label names no registry bot. |
| **FAIL** | **Two or more** `cc_completed_<card>_k*` rows for one card — the keyless path must pick ONE recipient. |
| **NOT A FAIL** | No row because no candidate covers the card's workspace, or the only in-scope candidates are keys labelled for a *different* bot (they are never a fallback), or the card's last move to `done` came from `review` (§3b). |

---

## 4. Control test — `pr_merged` wake and durable merge recording

**What it proves:** a merged PR is recorded on the card (`objective_prs.state='merged'`) and
that transition wakes the owner. `objective_prs.state` had been stuck at `'open'` for every
PR since #593, which is why `pr_merged` could not fire at all.

`pr` events are produced by SQL triggers on `objective_prs`
(`db/schema/agent-control.ts`): an INSERT writes `kind='pr', to_value=NEW.state`, and an
UPDATE of `state` writes `from_value=OLD.state, to_value=NEW.state`. So the wake is only as
good as the merge recording — check the recording first.

```bash
# 4a. Merge recording. PRs merged AFTER the deploy are the valid sample.
#     As of 2026-11-09 those are #663 (05:49Z), #664 (02:25Z), #667 (14:25Z).
q "SELECT objective_id, repo, pr_number, state, updated_at FROM objective_prs
    WHERE pr_number IN (663,664,667);"

# 4b. The durable record, written BEFORE the card row is touched:
q "SELECT repo, pr_number, state, merged_at, delivery_id FROM pr_terminal_states
    ORDER BY rowid DESC LIMIT 10;"

# 4c. The loud log line — this is the half that did not exist before #654:
docker logs --tail=2000 command-center 2>&1 | grep 'objective_prs'
# expect: [github-webhook] objective_prs <repo>#<n> → merged (rows 1/1)
```

| | Criterion |
| --- | --- |
| **PASS (4a)** | Every PR merged after the deploy has `state='merged'` on its card row. |
| **PASS (4b)** | A `pr_terminal_states` row exists for that `(repo, pr_number)` with `state='merged'` and a non-null `merged_at`. |
| **PASS (4c)** | A log line per merge. The counts are `rows <updated>/<matched>`: `rows 1/1` = recorded; `rows 0/1` = already applied (idempotent re-delivery); `rows 0/0` = **the card never linked its PR**, which also emits `… with no objective_prs row yet — recorded for replay`. That is a card-linkage problem, not a webhook problem. `NO RECORD written` or a thrown error is now printed with its message instead of being swallowed. |
| **FAIL** | A post-deploy merge with `pr_terminal_states` present but `objective_prs.state` still `'open'` — that is the replay path failing. |
| **NOT A FAIL** | A PR merged **before** the deploy still showing `'open'`. Those rows are the pre-existing backlog (#642–#653 and others). Backfilling them is a production data write and is deliberately out of scope here; `recordPRTerminalState` is idempotent and monotonic, so a backfill is safe to do later as its own reviewed change. |

```bash
# 4d. The wake itself:
q "SELECT event_id, status, last_status_code FROM agent_webhook_deliveries
    WHERE event_id = 'cc_pr_merged_<card>_k<key>';"
```

**PASS** = exactly one row. **FAIL** = zero rows while 4a passed *and* either the card has a
non-NULL `agent_key_id` subscribed to `needs_agent`, or the card has `agent_key_id IS NULL`
and §3c query 3 lists an in-scope candidate (obj 900553 — keyless cards are no longer exempt). If 4a failed, `pr_merged` being silent
is the **symptom**, not a second bug — fix the recording first.

---

## 5. Control test — dedupe on replay, and owner vs CoS fallback

### 5a. Dedupe

Dedupe is structural, not timing-dependent: `event_id` is deterministic
(`cc_<kind>_<objective>_k<key>`) and `agent_webhook_deliveries(event_id)` is UNIQUE, with
`INSERT OR IGNORE` on the write. So a reopen→done cycle, a replayed GitHub delivery and two
overlapping ticks all collapse to one row.

```bash
# Any card that has been reopened and finished again:
q "SELECT objective_id, COUNT(*) c FROM agent_webhook_deliveries
    WHERE event_id LIKE 'cc_completed_%' GROUP BY objective_id HAVING c > 1;"
```

**PASS = zero rows returned, board-wide.** This is a whole-population check, so it is
stronger than inspecting one card — any duplicate anywhere shows up.

For a GitHub replay specifically, re-deliver an already-processed merge from the repo's
webhook delivery UI (this sends to *our* receiver, not out to anyone — it is not spam) and
confirm the counts above are unchanged and `pr_terminal_states.delivery_id` still names the
first delivery.

### 5b. Owner named vs unowned → CoS

```bash
q "SELECT json_extract(payload,'\$.owner_bot') AS owner,
          substr(json_extract(payload,'\$.summary'),1,120) AS summary
     FROM agent_webhook_deliveries
    WHERE event = 'needs_agent' ORDER BY id DESC LIMIT 20;"
```

| | Criterion |
| --- | --- |
| **PASS** | Where `owner` is non-null, `summary` names **that bot**. Where `owner` is null, `summary` contains `an agent (unowned — routed to the General)`. |
| **FAIL** | A `summary` that names the **agent key's label** (e.g. `needs Grok: Shared Connection`) while `owner` is null. That is the pre-#654 bug: an authentication artefact spoken as ownership. |
| **FAIL** | `owner_bot` absent from the JSON entirely (not `null` — absent). Means a pre-#654 build is serving; return to §1. |

Note what is **not** checkable here: whether the General routine actually picked the
body up and acted. That hop is in the receiver, off this box. Confirm it in the CoS routine's
own run log; a delivered 2xx on our side plus silence on theirs is a *receiver* finding.

---

## 6. If generation passes but delivery fails

```bash
q "SELECT event_id, status, attempts, last_status_code, last_error, next_attempt_at
     FROM agent_webhook_deliveries WHERE status <> 'delivered' ORDER BY id DESC LIMIT 20;"
```

Delivery is per-row with bounded retries (`MAX_ATTEMPTS = 5`, backoff 1/4/10/15 min), so one
bad row cannot block another. `last_error` never contains the signing secret.

The "Send test" button (Settings → Agent keys → Webhook, `sendTestEvent`) **does POST to the
configured production URL** with `test: true`. It is a legitimate operator tool for proving
transport to an endpoint you own, but it is not evidence about generation or routing and it
is not part of any pass criterion above. Do not use it to "check whether notifications
work" — it will succeed on an install where §3 and §4 both fail.

**Fixture path — exercising the full path with no outbound traffic at all.** The enqueue
side is driven end-to-end against a real DB with no transport installed in
`agent-webhooks-completion.test.ts` and `agent-webhooks-routing.test.ts`; every assertion
is on the outbox rows. To rehearse a scenario you cannot wait for, add a case there rather
than poking the live install:

```bash
cd app && npx vitest run --root server \
  src/services/agent-webhooks-routing.test.ts \
  src/services/agent-webhooks-completion.test.ts \
  src/services/pr-merge-state.test.ts
```

---

## 7. Known gaps to record, not to debug

| Gap | Status |
| --- | --- |
| ~~Browser/UI-created cards (`origin='manual'`, `agent_key_id IS NULL`) are reachable by **neither** notifier, even when `owner_bot` is set.~~ | **Closed by obj 900553**: keyless cards get the `needs_agent` family routed by `owner_bot` → CoS → shared connection. Pinned by `agent-webhooks-routing.test.ts`; verify with §3c. |
| For **keyed** cards `owner_bot` does not select a recipient; fan-out is the receiver's job. (Keyless cards DO route on it — §2.3.) | By design today. Document it anywhere a payload consumer might assume otherwise. |
| `objective_prs` rows for PRs merged **before** the deploy remain `'open'`. | Backlog; a production data write, out of scope. Replay via `recordPRTerminalState` (idempotent + monotonic) in its own reviewed change. |
| No kill switch for completion wakes — they ride the shared `needs_agent` subscription. | Open decision carried over from `obj-900309-rollout.md` §5.1. |

---

## 8. One-screen summary

| Check | Where | PASS |
| --- | --- | --- |
| Deploy prerequisite | §1 gates 1–5 | all five |
| Child review→done wake | §3 | 1 row, `need.kind='completed'`, delivered |
| Top-level review sign-off stays silent | §3b | 0 rows |
| Merge recorded durably | §4a–c | `state='merged'` + `pr_terminal_states` row + log line |
| `pr_merged` wake | §4d | 1 row |
| Dedupe on replay | §5a | 0 duplicate groups board-wide |
| Owner named / unowned→CoS | §5b | owner named, or the CoS sentence; never the key label |
| NULL `agent_key_id` cards (obj 900553) | §3c | exactly 1 `needs_agent` row, to the owner bot's key, else CoS, else shared |
