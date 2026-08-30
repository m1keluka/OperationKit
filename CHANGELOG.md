# Changelog

All notable changes to OperationKit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Changes landed on `main` since `v0.1.0`. Entries are added as they merge.

### Added
- `config/litellm/config.yaml` — a generic, env-var-driven LiteLLM template so
  `docker compose up -d` succeeds on a fresh clone instead of failing on a missing
  bind-mount source.
- `SUPPORT.md`, `NOTICE`, `THIRD-PARTY-NOTICES.md`, and this `CHANGELOG.md`.
- Documented `PROJECTS_DIR`, `AI_WORKSPACE_DIR`, `CC_REPO_DIR`, `DOPPLER_TOKEN_PATH`, and
  `USE_SCOPED_DOPPLER_TOKENS` in `.env.example`.
- A "Secret management" section in `docs/CREDENTIALS.md` stating that `.env` is the
  primary path and Doppler is optional.
- An "Any Debian/Ubuntu VPS" section in `docs/SETUP.md`.

### Changed
- Setup docs now use the real clone URL, `https://github.com/m1keluka/OperationKit.git`.
- `SECURITY.md` names OperationKit (not the pre-release internal product name) and its
  self-host checklist names both seeded accounts, `admin` and `ava`.
- Documentation and script output use operator-generic wording rather than the original
  operator's name.

### Removed
- Seven internal runbooks that were published by accident
  (`docs/supabase-webhook-setup.md`, five `docs/*-ENABLEMENT.md`, and
  `docs/per-user-google-workspace.md`).

## [0.1.0]

First public release of OperationKit: the self-hosted agent operations board — objectives,
sessions, workspaces, live terminals, and the docs to run it on your own host.

[Unreleased]: https://github.com/m1keluka/OperationKit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/m1keluka/OperationKit/releases/tag/v0.1.0
