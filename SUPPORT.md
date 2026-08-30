# Support

OperationKit is a self-hosted, community-supported project. There is no commercial
support contract and no SLA — but issues and questions are read.

## Where to go

| I want to… | Go here |
| --- | --- |
| Report a bug or a broken setup step | [GitHub Issues](https://github.com/m1keluka/OperationKit/issues) |
| Ask a question, share a setup, or propose an idea | [GitHub Discussions](https://github.com/m1keluka/OperationKit/discussions) |
| Report a security vulnerability | **Do not open an issue.** Follow [SECURITY.md](SECURITY.md) |
| Contribute a fix or a feature | [CONTRIBUTING.md](CONTRIBUTING.md) |

If Discussions is not enabled on the repository yet, open an issue and label it
`question` — it will be triaged the same way.

## Before you open an issue

Most reports are resolved faster with a little context up front:

1. **Read the setup docs first.** [docs/SETUP.md](docs/SETUP.md) for local/any-VPS,
   [docs/DIGITALOCEAN.md](docs/DIGITALOCEAN.md) for the one-command droplet path, and
   [docs/CREDENTIALS.md](docs/CREDENTIALS.md) for every environment variable.
2. **Search existing issues** — including closed ones.
3. **Include the basics:** OS and version, Docker version, the exact command you ran, and
   the relevant output of `docker compose logs --tail=100`.
4. **Redact secrets.** Logs routinely contain API keys, tokens, and hostnames. Scrub them
   before pasting.

## Response expectations

This is a small project maintained in the open. Bug reports with reproduction steps get
priority. "It doesn't work" without logs may sit unanswered — not out of indifference, but
because there is nothing actionable in it.
