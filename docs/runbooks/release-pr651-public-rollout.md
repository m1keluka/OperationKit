# Release runbook — connector-picker + owner-inheritance fix (upstream #651) to public OperationKit

**Objective:** 900306 · **Date prepared:** 2026-11-08 · **Status:** public PR open, all checks
green, *awaiting owner merge*. Nothing in this runbook has been executed against any install.

---

## 1. Exact SHAs (the chain, end to end)

| Link | Ref | SHA |
|---|---|---|
| Private PR | `your-org/operationkit` **#651** — *Fix the always-empty connector picker; new keys follow their owner (obj 900303)* | merged `2026-11-08T14:58:20Z` (09:58:20 ET) |
| Private merge commit (**source SHA**) | `main` | `444de1a86e66ecde489d0ce2184c033f4991d84f` |
| Sync workflow run that published it | `oss-sync.yml`, event `pull_request`, created `2026-11-08T14:58:23Z` | [run 42492397469](https://github.com/your-org/operationkit/actions/runs/42492397469) — conclusion `success` |
| Public PR | `m1keluka/OperationKit` **#71** — *Sync from upstream* (rolling `sync/from-upstream` branch) | https://github.com/m1keluka/OperationKit/pull/71 |
| Public PR **head SHA** | `sync/from-upstream` | `58ddfabd42be6cf3766b9df955a8fdb258826e1d` |
| Public PR **base SHA** | `main` (= merge of public #70) | `926f0632c0da3ddcb8065d1ff5802eccdb55ca0c` |
| Public merge SHA | *(not yet — owner merges #71)* | *owner action — record here at merge time* |

> **Note on the stated baseline.** The brief recorded the public deployed baseline as
> `b2873f2` (public PR #68, merged 2026-11-07T20:31:17Z). Public `main` has since advanced
> twice — #69 → `b040ec2e6b13f69533713c245653c9ca9ad40118`, #70 →
> `926f0632c0da3ddcb8065d1ff5802eccdb55ca0c`. An install still running `b2873f2` will pick
> up #69 and #70 **as well as** #71 when it updates. See §5.

## 2. Scope — what ships, and what else comes along

Public #71 carries **exactly upstream #651 and nothing else**: the same 16 files, the same
`+927 / −113`, byte-identical content apart from one sanitizer rewrite
(`@operationkit/shared` → `@operationkit/shared` in
`app/client/src/lib/connectors.ts`). Removed-line sets are identical. Evidence:
`.evidence/900306/pr71-fidelity.md`.

No other merged upstream change is pending publication: the previous private merge (#650,
`33c5228`, 2026-11-08T01:37:38Z) was carried by public #70, merged 01:53:38Z. #651 is the
only private `main` commit since.

Behaviour shipped (from #651 / obj 900303):

1. **Connector picker contract** — the client reads the *bare array* the server actually
   sends, instead of expecting a wrapper object. This is the always-empty-picker bug.
2. **Distinct empty vs load-error states** — "you have no connected accounts" and "the
   catalogue failed to load" are now different states, with an explicit retry. An
   unreadable shape is a failure, not an empty list.
3. **New-key owner inheritance** — a newly minted agent key follows its owner's connector
   authorisations by default. Keys with an **explicit** restriction list are preserved and
   are *never* silently widened; moving an existing key to inherit requires an explicit
   owner choice. A stored `NULL` or `[]` on a pre-900303 key means **deny-all**, not inherit.
4. **Authorisation / revocation stay bound to the owner** — an inheriting key reaches only
   its own owner's connectors; removing the owner's connection removes the key's reach;
   revoking a key is 401 everywhere while other keys keep working.
5. **Connectors are not Secrets** — the UI says so explicitly; shared connector/service
   credentials are withheld from spawned session env and from the bulk resolver.

## 3. Pre-merge verification already performed (public PR #71)

All nine checks on head `58ddfab` are **green**, `mergeStateStatus: CLEAN`:

```
build                                   pass  1m14s
gate                                    pass  6s
gitleaks-config (OSS publish allowlist) pass  7s
jail-proof                              pass  19s
shellcheck (scripts/migrate)            pass  7s
test-integrity                          pass  6s
typecheck                               pass  43s
unit (client)                           pass  37s
unit (server)                           pass  1m53s
```

Auth/isolation regression suites — **run on the published tree**, which closes the gap left
by the obj-900303 review (that reviewer could not execute the server suites locally because
of the native-pty dependency; this is a real run on CI, not a local skip):

| Suite | Result |
|---|---|
| `app/server/src/services/connector-isolation.test.ts` | ✓ 29 tests |
| `app/server/src/routes/connector-isolation-api.test.ts` | ✓ 18 tests |
| `app/server/src/routes/agent-keys.test.ts` | ✓ 18 tests |
| `app/server/src/routes/connectors.test.ts` | ✓ 10 tests |
| `app/client/src/components/account-settings/AgentKeysSection.test.tsx` | ✓ 17 tests |
| `app/client/src/lib/connectors.test.ts` | ✓ 6 tests |

Totals: server **314 files / 4126 tests passed, 23 skipped, 0 failed**; client
**51 files / 315 tests passed, 0 failed**. Skips are pre-existing
environment-gated suites (e.g. `knowledge-search.recall`, workspace-gated
`internal-operationkit`), not failures introduced by this change — full per-suite
listing in `.evidence/900306/ci-evidence.md`.

Secret / identity scan: the fail-closed publish gate (`scripts/oss-sync-gate.sh` —
gitleaks + business-identity denylist + real-content absence) passed inside the sync run,
and an independent grep over the 927 added public lines for business identity, infra IPs,
and credential shapes returned **zero hits**. Public-only files are untouched: #71 changes
16 files, all of them #651's.

## 4. Rollout — OUR install only, AFTER the owner merges public #71

**Do not start this before `gh pr view 71 --repo m1keluka/OperationKit --json mergedAt`
returns a non-null value.** Record that merge SHA; it is the number every check below
compares against.

### 4.0 Before touching anything

- [ ] Take a database backup and confirm it exists and is non-zero (`scripts/backup-db.sh`).
      Record its path and size.
- [ ] Record the current runtime SHA and the current on-disk SHA, so rollback has a target.
- [ ] Record pre-update counts to compare after: objectives, workspaces, memberships,
      agent keys, connected accounts, secrets, knowledge-base doc count.

### 4.1 Health / version

- [ ] On-disk checkout SHA == the public **merge** SHA of #71.
- [ ] Running process started **after** the deploy (the process does not hot-reload; an
      up-to-date checkout served by an old process is the classic false green).
- [ ] The app's own health/version surface reports the same SHA as the checkout.
- [ ] App answers on its normal port; no crash-loop in the first 5 minutes of logs.

### 4.2 Connected-account picker (the headline fix)

- [ ] Settings → You → agent keys: the connector picker lists the owner's **actual**
      connected accounts (not empty).
- [ ] With zero connected accounts, the picker says *you have none* — and says it only
      when the catalogue really is empty.
- [ ] Force a catalogue load failure (block the request): the UI reports a **failure**
      with a retry affordance, and does **not** render it as "you have none".
- [ ] Retry re-issues the load and recovers.

### 4.3 Key inheritance vs existing explicit restrictions

- [ ] A **newly** minted key follows its owner with no ticking required, and is shown as
      *following the owner* rather than as a list of ids.
- [ ] Every **pre-existing** key that had an explicit connector list still has exactly that
      list — compare against the pre-update snapshot, id by id. Zero keys widened.
- [ ] Opening the editor on an explicitly restricted key and closing it does **not** widen it.
- [ ] Moving an existing key to inherit happens only on an explicit choice.
- [ ] A legacy key is labelled so its reach is visible and narrowable.
- [ ] Inherit cannot be combined with specific connector ids (rejected).

### 4.4 Owner removal / revocation

- [ ] Removing the owner's connection removes the inheriting key's reach to that connector.
- [ ] Revoking a key → 401 on every route; other keys continue to work unaffected.
- [ ] An unknown `cc_live_` key → 401.

### 4.5 Cross-user / cross-workspace isolation

- [ ] An inheriting key reaches only its **own** owner's connectors — never another person's.
- [ ] A key cannot list, read or create in a workspace it is not scoped to.
- [ ] A non-admin cannot assign work to somebody else; the admin **role** is not an
      identity override and grants no connector access by itself.
- [ ] A key cannot widen its own scopes.

### 4.6 Secrets distinction (no blanket secrets)

- [ ] The UI states plainly that connectors are **not** Secrets.
- [ ] Granting a connector does **not** hand a session the shared connector/service
      credential: spawned session env and the bulk resolver both withhold it.
- [ ] A secret an operator stored for agents is left exactly as it was.
- [ ] Refusals are audited (who, whose, which, why) and no credential material is stored
      in the audit row.

### 4.7 API authorisation

- [ ] Authorised agent key → `200` on its permitted surface.
- [ ] Missing key → `401`. Invalid/revoked key → `401`.
- [ ] A key lacking a scope → `403 missing_scope` (not a 200, not a 500).
- [ ] Off-surface admin routes stay denied even with every scope.

### 4.8 UI / operator access protection

- [ ] Operator/admin screens still require an authenticated session; no route became
      anonymous.
- [ ] A non-admin member sees only their own keys and cannot edit another person's key.

### 4.9 Data preserved

- [ ] Objective/card count and board state match the pre-update snapshot.
- [ ] Knowledge base document count and search unchanged.
- [ ] Workspaces, memberships and roles unchanged.
- [ ] Config/settings rows unchanged (spot-check the flags this install depends on).
- [ ] Connected accounts unchanged; agent-key count unchanged.

### 4.10 Rollback (safe, non-destructive by default)

Rollback is **code-only**: check the previous SHA back out and restart. Do **not**
auto-restore the database — #651 adds a column-level default on agent keys and does not
destroy data, so a code rollback alone is sufficient and reversible.

- [ ] Rollback target SHA recorded in §4.0.
- [ ] Rollback procedure rehearsed as "checkout previous SHA + restart", with the backup
      kept **untouched** on disk.
- [ ] A database restore is a **separate, deliberate, human decision** — never part of the
      automatic rollback path, because restoring would discard everything created since the
      backup.

## 5. Handoff to the Example Project install (copy/paste)

Send this **after** public #71 is merged, with `<PUBLIC_MERGE_SHA>` filled in. It is a
request to that install's **own** bot to act on its **own** system — nobody from this side
touches it, and we do not read or write anything over there.

```text
OperationKit update available — connector picker + agent-key owner inheritance.

Upstream fix: m1keluka/OperationKit PR #71 ("Sync from upstream"), merged to main.
Public merge SHA: <PUBLIC_MERGE_SHA>
Head SHA of the PR: 58ddfabd42be6cf3766b9df955a8fdb258826e1d
Origin: private upstream PR #651, merged 2026-11-08T14:58:20Z.

What it changes:
  1. The connected-account picker in Settings -> You is no longer always empty
     (the client now reads the bare array the API returns).
  2. "No connected accounts" and "catalogue failed to load" are distinct states,
     and the error state offers a retry.
  3. A newly created agent key follows its owner's connector authorisations by
     default. Keys that already carry an EXPLICIT connector list are preserved
     and are never silently widened. A stored null/empty list means deny-all.
  4. Revocation and owner-removal still bind a key to its own owner only.
  5. Connectors remain distinct from Secrets: granting a connector does not hand
     a session the shared credential.

Please run this yourself, on your own install:
  a. Check your current version/runtime SHA and whether you are already past
     <PUBLIC_MERGE_SHA>.
  b. Review your own config and any local modifications before updating.
  c. Take your own database backup and verify it is non-zero.
  d. Update using your normal update path, then confirm the runtime SHA matches
     and the process restarted (the server does not hot-reload).
  e. Verify: picker lists your real connected accounts; a forced load failure
     shows an error + retry, not "you have none"; every pre-existing key that
     had an explicit connector list STILL has exactly that list (compare to a
     pre-update snapshot); revoked keys 401 while others keep working; keys
     cannot reach another user's or another workspace's connectors; cards,
     knowledge base, config and memberships are intact.
  f. If anything is wrong: roll back CODE ONLY (previous SHA + restart). Do NOT
     auto-restore the database — keep the backup and decide a restore
     deliberately, as a separate step.

Note: if your install is older than public main you will also pick up public PRs
#69 and #70 in the same update. Both are routine upstream syncs; review their
diffs as part of step (b).

We have not accessed your install, changed any key, scope or restriction, or
altered any permission. This is a notification only — all actions are yours.
```

## 6. Explicit non-actions (held for the owner)

- Public PR #71 is **not** merged by this objective — the owner merges.
- Nothing is deployed to our install or to any other install.
- No key, scope, connector restriction or permission was created, changed, widened or
  revoked anywhere.
- The Example Project install was not accessed and its bot was not messaged.
- `owner_bot` naming: the exposed schema has **no** metadata field for a bot display name,
  and a description is not metadata. So the exact string "Operation Kit" is carried in the
  **description** only; no schema change is proposed here.
- Webhook diagnostic (obj 900305) is a separate read-only workstream — deliberately not
  combined with this release and not a blocker for it.
