# obj 900540 — Sprint 6b Secrets: Operator's D1–D5 — ARTIFACT

**Deliverable:** PR https://github.com/your-org/operationkit/pull/696
(branch `cc/obj-900540-sprint-6b-secrets-implement-operator-s-d1-d5`). **Open, NOT merged, NOT
deployed** (card rule: PR only). No live secrets, keys, access or permissions were touched.

(The objective-memory folder is not mounted in this session's sandbox, so the artifact lives
here, in the branch.)

## Per decision: what shipped and the evidence

| | Shipped | Evidence |
|---|---|---|
| **D1** never reveal | No reveal path, class or flag. `/reveal` is an audited 403 tripwire, permanently. | `routes/secrets-d1-write-only.test.ts` (source scan + schema), `routes/secrets-hardening.test.ts` "D1: no flag can turn reveal on" |
| **D2** host-file KEK, pluggable | `services/secrets-kek.ts` provider registry (host-file default, mode check, session-visible check, `kekStatus`). Installer `kek_file_ensure` writes `secrets/secrets-kek` (root 400) from the existing key. Compose mounts it read-only into the app only and drops the env var. tmux unsets it. `secrets-get` audits `source=cli`. `GET /api/secrets/kek-status`. | `services/secrets-kek.test.ts` (12), `install/test/secrets-kek-test.sh` (17 checks, in CI), install-smoke CI **real install + backup/restore + update.sh passed** with the KEK file |
| **D3** 1Password later | Not built. Extension point documented. | SECRETS-PROPOSAL.md §8 |
| **D4** allowlist + migration | `secret_env_allowlist` / `secret_env_usage`. Mode: a missing row means migration (existing installs); a fresh install is set to enforce. Spawn filter runs before decrypt/audit. Session-end reference log. Prompt lists only held names. CLI `secrets-env-allowlist.ts` + admin `/api/secrets/env-policy`. All changes audited as `env_policy`. | `services/secret-env-policy.test.ts` (16), hardening route tests, sample `d4-migration-log-sample.txt` (fake names) |
| **D5** 1 year then export | `secrets-audit-retention.ts`: dry-run default, ≥365 days, JSONL + sha256 export, verify, then one transaction that drops the delete guard, deletes the exported ids, re-creates the guard and appends `audit_prune`. Monthly cron from the installer. | `services/secrets-audit-retention.test.ts` (5), `install/test/secrets-kek-test.sh`, sample `d5-retention-sample.txt` |
| Docs | SECRETS-PROPOSAL.md records the decisions in Operator's words, plus §8. docs/security.md covers the encryption key, allowlist, retention and moving the key. INSTALL.md, SECURITY-OVERVIEW.md, CLAUDE.md updated. | diff in PR |
| UI | No settings UI changed (no `app/client` files), so there are no light/dark screenshots to take. | `git diff --stat origin/main -- app/client` is empty |

## Test / CI output (head 7e10cb7c)

```
gate: SUCCESS · typecheck: SUCCESS · unit (server): SUCCESS · unit (client): SUCCESS · build: SUCCESS
install: SUCCESS · jail-proof: SUCCESS · test-integrity: SUCCESS · gitleaks-config: SUCCESS · oss-public-tree: SUCCESS
local: 9 secrets-related files → Test Files 9 passed (9), Tests 110 passed (110); tsc --noEmit clean;
       install/test/secrets-kek-test.sh → ALL PASS; shellcheck --severity=warning clean
```

## Not done / follow-ups (owner-scheduled)
- The operator host's own compose and legacy key file (`/home/operator/projects/.secrets-master-key`) are unchanged. The app warns at boot until the key is moved per docs/security.md, "Moving the key on a custom setup". That needs a container recreate.
- Existing installs stay in **migration** until an admin runs `secrets-env-allowlist.ts mode enforce`. Turn on the `session_secret_access` broker first.
- Still open from the proposal: F2 (envelope encryption + AAD) and the F6 hash chain.
