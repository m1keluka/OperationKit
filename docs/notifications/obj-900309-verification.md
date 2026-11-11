# obj 900309 — verification evidence

Everything below was run in the objective's sandbox against branch
`cc/obj-900309-fix-reliable-owner-routing-and-actionabl`, commit `c7734f8`, with the
dependency tree installed from `app/package-lock.json`.

Sandbox caveat, stated up front so the numbers can be read honestly: this sandbox has no
Python/`g++`, so the two native addons were installed from their published **prebuilt**
binaries (`better-sqlite3` via `prebuild-install -r node -t 22.23.4`, `bcrypt` via
`node-pre-gyp install`), and `node-pty` — which has no prebuild and is only reached by
`ws/index.ts` at runtime — was stubbed locally in `node_modules` so Vitest could load the
module graph. None of that is committed; CI (`.github/workflows/test.yml`) builds all
three for real, and the `gate` job is the actual merge lock.

## 1. The changed surface — 139/139 pass

```
$ npx vitest run --root server \
    src/services/pr-merge-state.test.ts \
    src/services/agent-webhooks-completion.test.ts \
    src/routes/agent-mcp.test.ts \
    src/services/agent-webhooks.test.ts \
    src/services/objective-prs.test.ts

 ✓ src/services/agent-webhooks-completion.test.ts (15 tests) 108ms
 ✓ src/services/pr-merge-state.test.ts (11 tests) 98ms
 ✓ src/routes/agent-mcp.test.ts (47 tests) 434ms
 ✓ src/services/agent-webhooks.test.ts (56 tests)
 ✓ src/services/objective-prs.test.ts (10 tests) 109ms

 Test Files  5 passed (5)
      Tests  139 passed (139)
   Duration  3.55s
```

26 of those are new on this branch: 11 merge-state (`pr-merge-state.test.ts`), 15
completion/owner (`agent-webhooks-completion.test.ts`), plus the MCP owner round-trip
cases added to `agent-mcp.test.ts` and the three `agent-webhooks.test.ts` assertions that
had encoded the old "speak the key label as the owner" behaviour and were updated in
place rather than deleted.

## 2. Full server suite — no regression from this branch

```
$ npm run test --workspace=server
 Test Files  4 failed | 313 passed | 1 skipped (318)
      Tests  17 failed | 4166 passed | 23 skipped (4206)
   Duration  72.60s
```

The 4 failing files are `agents-board-layer.test.ts`, `internal-operationkit.test.ts`,
`skill-graph.test.ts`, `worktree-guard.test.ts`. **They fail identically on `main`**, so
they are the sandbox, not this change — `agents-board-layer` and `internal-operationkit`
need `~/ai-workspace` on disk (they answer `503`), `skill-graph` needs the generator
binary, and `worktree-guard` shells out to a script that needs the live-checkout layout.
Baseline, same four files, on `main` (`444de1a`) in a second worktree sharing the same
`node_modules`:

```
$ git worktree add /home/jailuser/base FETCH_HEAD   # 444de1a = origin/main
$ npx vitest run --root server \
    src/routes/agents-board-layer.test.ts src/routes/internal-operationkit.test.ts \
    src/services/skill-graph.test.ts src/services/worktree-guard.test.ts

 Test Files  4 failed (4)
      Tests  17 failed | 57 passed | 17 skipped (91)
```

Same four files, same 17 tests, on code that predates this branch. Nothing this PR
touches is imported by any of them.

## 3. Typecheck — clean

```
$ npx tsc -p server/tsconfig.json --noEmit
TSC_EXIT=0
```

## 4. Client suite — unaffected and green

```
$ npm run test --workspace=client
 Test Files  51 passed (51)
      Tests  315 passed (315)
   Duration  5.24s
```

## 5. What is NOT verified here, and why

Per the objective's safety boundary, nothing in this session sent a real external
webhook, edited a grant or key, changed a config value, wrote to the production DB, or
merged/deployed anything. So the following are **designed and unit-tested, not
observed in production**:

- that a real GitHub `closed+merged` delivery now lands as `state='merged'` on the row;
- that a real child `done` produces exactly one `needs_agent` delivery to the owner;
- that a top-level card arriving at `done` via `review` stays silent.

Each of those is a control test in `docs/notifications/obj-900309-rollout.md` §3,
written to run on naturally-occurring events and reads only. They are the acceptance
evidence for the rollout, and they are deferred to that rollout by design — they cannot
be produced without the live sends this objective forbids.

## 6. CI confirms the 17 failures were the sandbox

On PR #654, GitHub Actions built all three native addons for real and ran both suites.
Every check passed, `unit (server)` included — the four files that fail in the sandbox pass
in CI, which is the independent confirmation that section 2's baseline was reading an
environment difference and not a defect:

```
$ gh pr checks 654
build: pass
gate: pass
gitleaks-config (OSS publish allowlist): pass
jail-proof: pass
oss-public-tree (assembled public mirror): pass
shellcheck (scripts/migrate): pass
test-integrity: pass
typecheck: pass
unit (client): pass
unit (server): pass
```

`gate` — typecheck + unit + build, the merge lock — is green. The PR is deliberately left
UNMERGED and undeployed: this objective forbids merging and deploying, and merge is not
deploy in this repo regardless.
