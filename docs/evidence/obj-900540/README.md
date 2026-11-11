# obj 900540 — Sprint 6b secrets (D1–D5) evidence

All names and values here are FAKE. Generated against throwaway SQLite databases
with the code on this branch.

- `d4-migration-log-sample.txt` — D4 migration mode: three fake sessions referenced
  non-allowlisted names; `status`, `report`, `apply` (dry run), the raw
  `secret_env_usage` rows (names + counts only), the switch to `enforce`, and the
  `env_policy` audit rows. The allowlisted `FAKE_STRIPE_KEY` and the never-referenced
  `FAKE_UNUSED_KEY` are correctly absent from the log.
- `d5-retention-sample.txt` — D5 retention: dry run, `--apply` export (JSONL +
  sha256 sidecar), the `audit_prune` row, and proof the delete guard is back.

No settings UI changed in this PR (no files under `app/client/` touched), so there
are no light/dark screenshots to take. The D4 review surface is the CLI and the
admin API (`/api/secrets/env-policy`).
