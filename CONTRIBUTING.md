# Contributing to OperationKit

Thanks for helping. OperationKit is open source under the [Apache License 2.0](./LICENSE).
Copyright 2026 Axia Growth LLC and contributors
(see [NOTICE](./NOTICE)).

## Ways to contribute

- **Report a bug or ask for a feature:** open a GitHub issue. Include what you did, what you
  expected, what happened, and your version / install method.
- **Security problems:** do not open a public issue. Follow [SECURITY.md](./SECURITY.md).
- **Code and docs:** open a pull request (see below). For anything larger than a small fix,
  open an issue first so we can agree on the approach before you spend time on it.

## Pull request workflow

1. Fork the repository and create a branch from `main`.
2. Make your change. Keep each PR focused on one thing.
3. Run the checks locally (from `app/`):
   ```bash
   npm ci
   npx tsc --noEmit -p server/tsconfig.json
   npm run test --workspace=server
   npm run test --workspace=client
   npm run build
   ```
4. Open the pull request against `main` and fill in the PR template.
5. Sign the CLA (below) if you have not already.
6. A maintainer reviews the PR. CI must be green before merge.

## Contributor License Agreement (required)

**A signed Contributor License Agreement (CLA) is required before a pull request can be merged.**
You sign once; it covers all your future contributions.

- **Individuals:** [CLA/INDIVIDUAL_CLA.md](./CLA/INDIVIDUAL_CLA.md)
- **Companies and other legal entities** (if you contribute as part of your job, or your
  employer may own what you write): [CLA/ENTITY_CLA.md](./CLA/ENTITY_CLA.md), plus the
  individual CLA for each person contributing.

What the CLA does, in plain words (the CLA text is what counts):

- **You keep the copyright** in your contribution. The CLA is a license, not a transfer.
- You give the project owner a broad, permanent license to use, change and distribute your
  contribution, **including the right to relicense it under other terms** (for example a
  commercial license), plus a patent license for your contribution.
- You confirm the work is yours to contribute (and that your employer is OK with it, if
  that applies).
- Your contribution is provided as-is, with no warranty.

**How to sign:** once the CLA check is enabled, a bot comments on your first pull request.
Reply with the exact sentence it asks for and the check turns green. Your signature is recorded
in this repository. Entities sign by sending the completed Entity CLA to
[LEGAL CONTACT EMAIL - confirm].

**DCO is not used.** This project uses a CLA instead of the Developer Certificate of Origin.
You do not need `Signed-off-by:` lines in your commits.

## Code of conduct

The project does not have a separate code of conduct file yet. Be respectful and constructive.
Maintainers may remove comments, issues or pull requests that are abusive, and may block
repeat offenders.

## For maintainers: the CLA check

The CLA check is `.github/workflows/cla.yml`, built on the open-source
[CLA Assistant Lite](https://github.com/contributor-assistant/github-action) action. It uses
only the default `GITHUB_TOKEN` (no personal tokens, apps or secrets) and records signatures in
`signatures/cla.json` on a dedicated `cla-signatures` branch.

It ships **disabled**. The job only runs when the repository variable `CLA_ENABLED` is `true`.
To turn it on:

1. Fill the remaining `[...]` placeholders in `CLA/*.md` and this file (state, legal contact email).
2. Create the `cla-signatures` branch (from `main`) and leave it unprotected, so the
   action can commit signatures to it.
3. Settings -> Secrets and variables -> Actions -> Variables -> New repository variable:
   `CLA_ENABLED` = `true`.
4. Check that the allowlist in `cla.yml` covers every bot and maintainer account that opens
   PRs, so automated PRs are not blocked.
5. Optionally make the `CLAAssistant` check required in branch protection.

To turn it off again, delete the variable or set it to anything other than `true`.
