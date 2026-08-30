# Architecture catalog

Living map of OperationKit as of `origin/main`. Refactor PRs update these files when they split a module. Changing anything in `CONTRACTS.md` is a **product PR**, not a refactor PR.

**Product manual** (what the app is for a human): [`../product/README.md`](../product/README.md). That folder is the breathing user-facing docs; this folder is the engineering map.

| Doc | What it is |
|---|---|
| [SYSTEM.md](./SYSTEM.md) | What the app is, the execute loop, in-process vs siblings |
| [CONTRACTS.md](./CONTRACTS.md) | Frozen HTTP / WS / status / spawn / DB surface |
| [MODULES.md](./MODULES.md) | Every route, service, scheduler, client page |
| [GOD-FILES.md](./GOD-FILES.md) | Split queue for oversized files (**Phase 1 + Phase 2 complete**; leftover facades stay as public API) |

Phase 1 deferred items (resolved):

- `routes/alerts.ts` — mounted at `/api/alerts`; `AlertBell` in Layout
- `routes/internal-vault.ts` — mounted at `/api/internal` (vault + rolodex history)
- `startRolodexSibling()` — called after `server.listen` (no-ops without Telegram env)
- `services/terminal.ts` — deleted; shell PTY lives in `ws/index.ts`
- interrupted-session snapshot — deleted; tmux survives Node restart
