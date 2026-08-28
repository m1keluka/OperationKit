# Contributing to OperationKit

Thanks for being here. OperationKit is **V1 and early** — which means the highest-value
contributions right now are often not big features, but the unglamorous stuff: an
onboarding step that didn't work, a credential that wasn't documented, a default that
surprised you. If you got it running and something was harder than it should have been,
that's a contribution waiting to happen.

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report friction.** Onboarding/setup bugs are first-class. File a
  [bug report](.github/ISSUE_TEMPLATE/bug_report.md) with where you got stuck.
- **Improve docs.** README, [SETUP](docs/SETUP.md), [CREDENTIALS](docs/CREDENTIALS.md) —
  if something was wrong or missing, PR the fix.
- **Fix bugs / add features.** Grab an open issue or propose one first with a
  [feature request](.github/ISSUE_TEMPLATE/feature_request.md).
- **Harden the self-host path.** Making the stack less tied to one host layout is an
  explicit V1 goal (see the host-paths note in [SETUP](docs/SETUP.md)).

## Before you start

1. **Read [SECURITY.md](SECURITY.md).** OperationKit spawns agents that run commands and
   hold your keys. Never commit secrets, real `.env` files, tokens, or customer data in a
   PR, an issue, or a test fixture.
2. **Open an issue for anything non-trivial** before writing code, so we can agree on the
   approach and avoid duplicated work.
3. **Keep changes surgical.** Small, focused PRs get reviewed and merged faster than
   sweeping ones.

## Development setup

Get a local instance running first — follow **[docs/SETUP.md](docs/SETUP.md)** (manual
path). The app is an npm workspace monorepo under [`app/`](app/):

```bash
# from repo root, with the stack's dependencies installed for the app workspaces
cd app
npm run dev:server      # Express API (port 3002)
npm run dev:client      # React board (Vite dev server)
npm test                # server + client test suites
npm run build           # production build (client then server)
```

See [`app/package.json`](app/package.json) for the full script list. The three workspaces
are `shared`, `server`, and `client`.

## Making a change

1. **Fork** the repo and create a topic branch off `main`:
   `git checkout -b fix/setup-typo` or `feat/short-description`.
2. **Write / update tests** for behavior you change. Run `npm test` and make sure it's green.
3. **Match the surrounding code** — style, naming, and structure. Read the neighboring
   files before adding new patterns.
4. **Update docs** if you changed behavior, added a config var, or touched setup. A new
   env var means a row in [docs/CREDENTIALS.md](docs/CREDENTIALS.md).
5. **Keep commits clean** and messages descriptive.

## Opening a pull request

- Fill out the [pull request template](.github/pull_request_template.md), including the
  plain-English **"What's shipping"** summary and the changelog label.
- Reference the issue it closes (`Closes #123`).
- Confirm tests/verification passed and note how you verified.
- Small and focused beats large and sprawling. If a PR is getting big, split it.

A maintainer will review. Because agents in this project touch real infrastructure,
review leans toward correctness and safety — expect questions about failure modes and
blast radius, especially on anything touching secrets, spawning, or the Docker socket.

## Reporting security issues

**Do not open a public issue for a vulnerability.** Follow the private disclosure process
in [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the project's
[Apache-2.0](LICENSE) license.
