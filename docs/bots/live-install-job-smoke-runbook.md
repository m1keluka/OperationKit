# Running the bounded Bots job smoke on a LIVE install

**Audience:** an authorized operator with admin on the install and shell access to the
`command-center` container.
**Objective:** 900366. **Closes the operational acceptance gap recorded on** obj 900323 /
PR [#661](https://github.com/your-org/operationkit/pull/661).
**Companion:** [`obj-900323-acceptance-matrix.md`](./obj-900323-acceptance-matrix.md) —
the SYNTHETIC G1–G12 matrix. This document is the LIVE counterpart and does not repeat it.

obj 900323 proved the bounded chat → board → thread MVP against a throwaway database with
synthetic credentials. That is the right place to prove behaviour, and it is the wrong place
to prove *operability*: it says nothing about whether a real install has a ceiling
configured, whether the registered bot's thread lane is free, or whether a smoke can be run
and reversed without damaging data somebody depends on. This runbook is the missing half.

---

## 0. What this procedure will and will not do

| | |
|---|---|
| **Creates** | one temporary chat-agent folder on an already-recognised slug; one card; one thread; one job; a handful of rows keyed on that card |
| **Reads** | the shared bot registry, the configured ceiling, the agents dir, the preserved surfaces (names and shapes only) |
| **Never writes** | `settings.bot_registry`, any global default, any provider, connector, key, permission, seat or budget |
| **Never invents** | a dollar or wall-clock number. If no finite ceiling is configured, the procedure STOPS at step 2 and reports the product gap |
| **Reverses** | everything it created, keyed on one objective id and one lane slug, proven by a before/after fingerprint diff |

**The one rule that outranks the rest:** if any step refuses, the refusal is the result.
Do not reconfigure the install to get past a refusal. Record it and stop — that is what
obj 900323 did when no ceiling was configured, and it is why that gap is known rather than
papered over.

---

## 1. Why the temporary bot is a FOLDER and not a registry entry

The intuitive way to register a temporary test bot is to add an entry to
`settings.bot_registry`. **Do not.** That setting does not extend the built-in list — it
**replaces** it:

```ts
// app/server/src/services/bots/bot-registry.ts
export function listBots(db?: Database): BotDefinition[] {
  …
  const parsed = parseOverride(raw)   // settings.bot_registry
  if (!parsed) { /* warn, fall back */ }
  return parsed                       // ← REPLACES BUILT_IN_BOTS wholesale
}
```

So writing a one-entry array to that key deletes every bot this install knows about for as
long as the smoke runs: `General` stops resolving, every card filed from its thread
is refused `unknown_bot`, and a crash before cleanup leaves it that way. The constraint
"preserve the shared registry" is broken by step one of the obvious approach.

The correct move is to write **nothing**. Three facts make a temporary identity free:

1. `Operation Kit` already owns **two** recognised agent slugs — `operation-kit` and
   `operationkit` (`BUILT_IN_BOTS`), and `botForAgentSlug` maps either back to the same
   canonical `owner_bot`.
2. A chat thread is keyed on `(person, agent_slug)` (`agent_chat_messages`,
   `agent_chat_cards`, `bot_job_origins`), so a second recognised slug is a *separate
   conversation* with the *same bot identity*.
3. Chat agents are **files**: `<AGENT_FILES_DIR>/<slug>/agent.yaml`, where the folder name
   is the slug (`agent-defs.ts`).

Therefore the temporary test bot is a temporary **agent folder** named after a slug the
shared registry already recognises and no agent currently occupies. The registry is
untouched by construction, the canonical owner on the card is the real `Operation Kit`, the
completion still routes back to the originating thread — and "deregistration" is removing
one folder.

`chooseThreadLane` refuses rather than inventing a slug when every recognised one is taken
(see step 2). A slug the registry does not know would fail `bot_agent_mismatch` at the first
filing attempt anyway; inventing one does not work, it only looks like it might.

---

## 2. Preflight — may the smoke run here at all?

```bash
docker exec command-center \
  tsx /app/server/src/scripts/bots-smoke.ts preflight <workspace> > /tmp/smoke-before.json
echo "exit=$?"; cat /tmp/smoke-before.json
```

The workspace is explicit on purpose — there is no default, for the same reason
`authorizeBotJob` has none: a card filed into the wrong workspace is a cross-client leak the
moment a worker reads the KB. The bot defaults to `Operation Kit`; pass a second argument to
run as another registered bot.

Preflight is **read-only** and answers four questions in order. **Exit 0 = proceed. Exit 1 =
stop, and the JSON says why.**

| Stage | Pass | Refusal |
|---|---|---|
| `identity` | the name resolves in the SHARED registry | `unknown_bot` — the smoke will not add it. Run as a bot that exists |
| `thread_lane` | a recognised slug is free | `no_free_recognised_slug` — do not invent one, do not overwrite the registry |
| `ceiling` | a finite ceiling is already configured | `no_ceiling_configured` / `no_ceiling_guard_permissive` — see below |
| `fingerprint` | taken; **save this file** | — |

### The ceiling rule, stated once

The smoke uses the install's **existing** ceiling, resolved by the product's own chain
(`resolveConfiguredCeiling`): the card row → `settings.job_cost_ceiling_usd:<workspace>` /
`job_wallclock_ceiling_ms:<workspace>` → the global `settings.job_cost_ceiling_usd` /
`job_wallclock_ceiling_ms`. Whatever it finds, it uses **as found** and sets nothing. The
helper contains no numbers and neither does this document.

Two distinct refusals, because they are not equally dangerous:

- **`no_ceiling_configured`** — nothing is configured and the bounded guard is `enforce`
  (the default). The product would refuse the auto-start itself and park the card in
  `queue`. Honest and safe. **Report the gap and stop.**
- **`no_ceiling_guard_permissive`** — nothing is configured **and** this install has
  relaxed `settings.job_ceiling_policy:bounded` to `observe`, or set
  `settings.job_ceiling_guard_enabled = 0`. The product would **start the job unbudgeted**.
  A job with no ceiling is not a bounded job, so the smoke must not run. **Stop.**

In either case: do not set a ceiling in order to run the smoke. If this install needs a
ceiling it should get one as its own decision, recorded on its own card, not as a side
effect of a test. The honest outcome of a preflight refusal is a reported product gap — the
same answer obj 900323 gave.

Note the enforcement split, reported verbatim and never conflated: a **wall-clock** ceiling
is **ENFORCED** by the runner; a **cost** ceiling is **ADVISORY** — no measured provider
spend is collected, so it is not a billing cap.

---

## 3. Create the temporary test bot (one folder)

Only after preflight exits 0. Use the `thread_lane.slug` it printed — do not pick your own.

```bash
LANE=$(node -pe 'JSON.parse(require("fs").readFileSync("/tmp/smoke-before.json","utf8")).thread_lane.slug')
# AGENT_FILES_DIR wins; otherwise <AI_WORKSPACE_DIR>/agents (config.ts defaults
# AI_WORKSPACE_DIR to /home/operator/ai-workspace on this install).
AGENTS_DIR=${AGENT_FILES_DIR:-${AI_WORKSPACE_DIR:-/home/operator/ai-workspace}/agents}
test ! -e "$AGENTS_DIR/$LANE" || { echo "REFUSE: $AGENTS_DIR/$LANE already exists"; exit 1; }

mkdir -p "$AGENTS_DIR/$LANE"
cat > "$AGENTS_DIR/$LANE/agent.yaml" <<YAML
name: Operation Kit (smoke 900366)
slug: $LANE
description: TEMPORARY. Live bounded-job smoke for objective 900366. Delete after the run.
colour: grey
tools:
  - search
  - list_objectives
  - get_objective
  - create_objective
system_prompt: |
  You are the Operation Kit bot running a one-off operational smoke test.
  File exactly one read-only job when asked, then report what the board says.
  Do not send, post, purchase or delete anything.
YAML
```

Three things to hold to:

- **The slug is the recognised one.** `botForAgentSlug(LANE)` must return the canonical
  `Operation Kit`, which is what makes the card's `owner_bot` real and the delivery routable.
- **The tool list is the minimum: read-only KB + read-only board, plus the one filing tool.**
  Those four are the only names used, out of the ten an agent file may list
  (`tool-names.ts`). `search` is already workspace-filtered to the card's workspace by
  `lib/kb-workspace-scope.ts` (obj 900321); `list_objectives` / `get_objective` are board
  reads; `create_objective` is the filing tool that routes into `createBotJob`. Omitted
  deliberately: `write_doc` (a KB write), `read_file`, `file_answer`, `list_folders`, and
  the `email` / `calendar` connectors. The job itself is pinned to `job_mode = 'read_only'` by `MVP_JOB_MODE` regardless
  of what the agent file asks for — the file cannot widen it. Do not add a connector, a
  write tool or a browser.
- **No new seat, key, provider or permission.** The agent runs as the authorizing person
  under their existing access. If the lane needs a credential to work, stop: that is outside
  this procedure.

Confirm the install sees it, and that it resolves to the canonical bot:

```bash
docker exec command-center tsx /app/server/src/scripts/bots-smoke.ts preflight <workspace> | \
  node -pe 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); j.stage'
# -> "thread_lane", code no_free_recognised_slug: the lane is now OCCUPIED (by you).
# That refusal is the confirmation the folder registered. Keep /tmp/smoke-before.json
# from the FIRST run; that is the preservation baseline.
```

---

## 4. Start ONE owned bounded job

Do this **through the product**, in the UI, as the authorizing person:

1. Open chat and select the temporary agent (`Operation Kit (smoke 900366)`).
2. Ask for one small, genuinely read-only piece of work in the selected workspace, e.g.
   *"File a job to list the open cards in `<workspace>` and summarise them in three lines."*
3. The assistant calls `create_objective`. Because the lane is a registered bot slug,
   `createCard` takes the **guarded bot-job path** (`createBotJob`), not the legacy path.

What to record from the reply and the card:

| Check | Where | Expect |
|---|---|---|
| ONE card | the chat reply | a single card id. Ask the same thing twice: the derived idempotency key collapses it onto the SAME id with *"This is the card you already filed"* |
| owned by the real bot | `objectives.owner_bot` | the canonical `Operation Kit`, not the temp agent's display name |
| right workspace | `objectives.workspace` | the workspace you passed to preflight |
| read-only | `bot_job_origins.job_mode` | `read_only` |
| bounded start | the chat reply | *"Filed and cleared to start."* — `start_mode = 'auto'`. If it says *"Filed. It will NOT start by itself"*, the ceiling disappeared between preflight and now: stop and re-run preflight |

```bash
docker exec command-center sqlite3 /app/data/command-center.db \
  "SELECT o.id, o.status, o.owner_bot, o.workspace, g.job_mode, g.start_mode, g.thread_agent_slug
     FROM objectives o JOIN bot_job_origins g ON g.objective_id = o.id
    WHERE g.thread_agent_slug = '$LANE';"
```

Exactly one row. If there are two, stop and investigate before cleanup — the duplicate is
the finding.

---

## 5. Prove the artifact comes back to the SAME conversation

Let the job run to `done`. Delivery is driven by the state poller
(`runBotThreadDeliveryTick`, every tick), so this needs no intervention.

```bash
docker exec command-center sqlite3 /app/data/command-center.db \
  "SELECT delivery_id, kind, status, message_id, substr(body,1,160)
     FROM bot_thread_deliveries WHERE objective_id = <ID>;"
```

Four things must hold, and each is a separate claim:

1. **Exactly one row** per kind. `delivery_id` is the deterministic `bot_<kind>_<id>`, so a
   replayed event, a reopen→done cycle and two overlapping ticks collapse to one message.
2. `status = 'delivered'` with a non-null `message_id`.
3. That message is an **assistant turn in the originating thread** — verify in the chat UI,
   in the temporary agent's conversation, not merely in the table.
4. **The body is truthful.** If the card reached `done` with no output, the message must say
   so (*"reached done but reported NO output"*) rather than implying a result. A completion
   message that reads like a result over an empty summary is a FAIL, not a pass with a
   caveat.

Also confirm nothing leaked: the body is passed through `services/live-redaction.ts` before
it is stored, so a worker summary quoting a key-shaped string arrives redacted.

---

## 6. Prove the follow-up reaches the SAME job

In the **same** conversation, ask for an extension of the same work
(*"now do the same for the cards closed this week"*).

```bash
docker exec command-center sqlite3 /app/data/command-center.db \
  "SELECT COUNT(*) AS cards FROM bot_job_origins WHERE thread_agent_slug = '$LANE';
   SELECT id, session_id FROM objectives WHERE id = <ID>;
   SELECT objective_id, session_id, heartbeat_at, released_at FROM session_leases WHERE objective_id = <ID>;"
```

Expect: **`cards` still 1** — no second card — and the follow-up handled on the one card. If
a worker was live it was **attached** to (`action: 'attach'`, the existing `obj:<id>`
identity lease); if not, the job **resumed in place** (`action: 'resume'`). Neither branch
creates anything. **Two cards or two live sessions is a FAIL** and is worth more than this
whole run — record it before cleaning up.

A follow-up from a *different* conversation must be refused `not_your_thread`. Testing that
is optional here (obj 900323's G9 covers it synthetically) and costs a second thread.

---

## 7. Cleanup — scoped, and refusing by default

Ask for the plan. It re-reads `bot_job_origins` and **refuses** unless the card is a bot job,
on this exact lane, in this exact workspace — a card failing any of those is somebody's real
work:

```bash
docker exec command-center \
  tsx /app/server/src/scripts/bots-smoke.ts cleanup-plan <ID> "$LANE" <workspace>
```

Then execute the steps it prints, in order:

1. **Cancel the card through the board** (`PATCH /api/objectives/<ID>/status
   {"status":"cancelled"}`, or the Cancel button). This runs the owned teardown
   (`services/job-teardown.ts`): it kills only the tmux session *this card* demonstrably
   owns — resolved from `objectives.session_id` and this card's own lease rows, never a
   `cc-<id>-*` glob — releases only this card's leases, and records the teardown once.
2. **Verify it owns nothing** — `status = 'cancelled'`, `session_id IS NULL` — *before*
   deleting any row.
3. **Delete the card-scoped rows**: `bot_thread_deliveries`, `agent_chat_messages` for the
   lane, `agent_chat_cards`, `bot_job_origins`, then `objectives`. Every statement is keyed
   on the one id or the lane slug. There is no prefix glob and no `created_at >` window —
   both shapes have taken a neighbour's row before.
4. **Remove the temporary agent folder** (`rm -rf "$AGENTS_DIR/$LANE"`). This is the whole of
   deregistration; no registry row was ever written, so none needs restoring.

A cancelled card is reported to the thread as *stopped*, not as a completion — expect one
more `bot_blocked_<ID>` delivery before you delete the deliveries, and do not read it as a
failure of step 5.

### The proof that preexisting data survived

```bash
docker exec command-center tsx /app/server/src/scripts/bots-smoke.ts fingerprint > /tmp/smoke-after.json
docker exec command-center tsx /app/server/src/scripts/bots-smoke.ts diff /tmp/smoke-before.json /tmp/smoke-after.json
echo "exit=$?"   # 0 = PRESERVATION OK
```

The diff covers nine surfaces — shared bot registry, global job defaults/ceilings/policies,
providers, connectors, keys, secret **names**, workspace memberships, user roles, workspaces
— by name and shape only, never by value, so the output is safe to paste into a PR. **Any
difference on any surface is a FAIL**; investigate before reporting the smoke as clean. A
table this schema lacks is reported `absent`, which is deliberately not the same as
`unchanged`.

---

## 8. Reporting

Record, in the card or PR that commissioned the run:

- the preflight JSON (identity, lane, ceiling **source**, policy and its source), with the
  ceiling values as found;
- the card id, `owner_bot`, workspace, `job_mode`, `start_mode`;
- the delivery row(s) and the thread screenshot;
- the follow-up card count (`1`) and the attach/resume outcome;
- the cleanup plan, what you executed, and the `diff` exit code.

If the run stopped at a refusal, report the refusal **as the result** together with the stage
and code. A preflight that refuses on a missing ceiling has not failed; it has measured the
install, and that measurement is the deliverable.

---

## Files

| Path | What |
|---|---|
| `app/server/src/services/bots/bots-smoke.ts` | preflight / lane / ceiling / fingerprint / cleanup-plan logic. Pure reads over an injected `Database`; writes nothing |
| `app/server/src/services/bots/bots-smoke-cli.ts` | the subcommand routing and exit codes, as an injectable function so the CLI contract is itself tested |
| `app/server/src/scripts/bots-smoke.ts` | the CLI entry point the steps above invoke — wiring only |
| `app/server/src/services/bots/bots-smoke.test.ts` | invariants I1–I6 (30 tests) |
| `docs/bots/obj-900323-acceptance-matrix.md` | the synthetic G1–G12 matrix this runbook complements |
