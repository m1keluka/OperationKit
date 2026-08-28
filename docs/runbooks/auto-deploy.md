# Auto-deploy on merge (obj-1955)

**Armed 2026-06-29.** When a PR merges to `your-org/command-center-infra`'s `main`,
the org-level GitHub webhook (`pull_request` → `/api/webhooks/github`) triggers a
health-gated `scripts/self-deploy.sh`, so every merge ships in a small, self-verifying
batch that **auto-rolls-back** to the last-good commit if the server fails to serve.

This replaces the manual "merge, then remember to deploy" step that caused recurring
deploy-lag (the live checkout drifting many commits behind `main`).

## Control
- **Flag:** `settings.auto_deploy_enabled` — `1` = armed, `0` = dark (dry-run logs only).
  Read fresh on every webhook call (`isAutoDeployEnabled`), so it arms/disarms instantly
  with **no restart**. Env override: `CC_AUTO_DEPLOY=1`.
- **Disarm:** set the flag to `0`.
- **Scope:** the command-center self-repo only, base `main` only. Debounced 180s so a
  burst of merges coalesces into one deploy (each deploy fast-forwards to latest `main`).

## Safety net
The triggered deploy is health-gated (`self-deploy.sh`, obj-1955): it polls the server
for up to 75s after restart and, if it does not serve, `git reset --hard` back to the
pre-deploy commit and bounces — so a bad merge reverts itself instead of taking prod down.

> The PR that introduced this file was itself the end-to-end verification that the
> merge → webhook → health-gated-deploy loop fires with the flag armed.
