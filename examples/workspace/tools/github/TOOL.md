---
name: github
kind: http-api
description: Open pull requests and push code as the connected GitHub account.
connector_id: github
auth_path: api_key
setup_guide: docs/connectors/guides/github.md
auth:
  secrets:
    - env: GH_TOKEN
      source: session-spawn-env
      note: "Ambient — injected into every session by buildSpawnEnv() (app/server/src/services/session-spawn-env.ts) from the owner's GitHub connector (connectors/defs/github.ts, auth_path: api_key), gated by canUseConnectorCredential. Read $GH_TOKEN directly; never ask for a GH_TOKEN secret."
    - env: GITHUB_TOKEN
      source: session-spawn-env
      note: "Alias of GH_TOKEN, set from the same value, for git/CI tooling that reads GITHUB_TOKEN instead."
---

# GitHub

Lets an agent open pull requests and push code as the connected GitHub account
(Settings → Connectors → GitHub), with no separate `GH_TOKEN` secret to request.

## Using it

`$GH_TOKEN` (and its alias `$GITHUB_TOKEN`) are already in the session
environment when the card owner has a GitHub connection. `gh pr create` and
`git push` over https work as that account via a pre-configured credential
helper — do not ask for a GH_TOKEN secret, and do not read a token from disk.

## Gotchas

- If `gh` returns 401/Bad credentials, the token may be stale — do not unset it
  globally; see the per-session prompt guidance for the fallback path.
- The connector is per-person (Settings → Connectors), scoped by
  `canUseConnectorCredential` — an agent key without this connector on its
  allow-list gets no token and must say so rather than guessing.

See `app/server/src/connectors/defs/github.ts` and
`docs/connectors/guides/github.md`.

This is a generic example Tool definition shipped with Command Center. It
documents a real connector already in this repo; add your own the same way
once you have a connector to wire up (see
`docs/connectors/TOOLS-LAYER-WIRING.md`).
