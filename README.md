# Command Center

Self-hosted board for running AI coding agents — Claude, Grok, and Codex — as real jobs on a VPS you control.

This is an **internal operator tool**, not a multi-tenant cloud product. Read [SECURITY.md](./SECURITY.md) before you expose it to a network.

**In a sentence:** you open a card, pick a model, and an agent session starts in tmux. The card is the source of truth: queue → working → review → done.

## Docs

| | |
| --- | --- |
| Product (what it is, how to use it) | [docs/product/README.md](./docs/product/README.md) |
| Agent / HTTP API | [docs/api/README.md](./docs/api/README.md) · [portable prompt](./docs/api/AGENT-PROMPT.md) |
| Architecture | [docs/architecture/README.md](./docs/architecture/README.md) |
| Security / threat model | [SECURITY.md](./SECURITY.md) |
| Deploy / self-deploy | [docs/product/06-operating.md](./docs/product/06-operating.md) |

## Status

Built to be a respectable open-source self-host: TLS, fail-loud secrets, login throttle, CSP, signed webhooks. It is **not** PE-diligence / SOC 2 SaaS. The Docker socket and auto-approved agent sessions are the product, and they are documented as such.

## License

MIT — see [LICENSE](./LICENSE).
