# OperationKit

**Self-hosted, multi-tenant work infrastructure for teams of small to medium-sized businesses.**

> Your work infrastructure. Any model. Your server.

OperationKit is a board where work becomes agent sessions: you open a card, pick a model, and an
agent session starts in tmux on your own VPS. The card is the source of truth, queue → working →
review → done, and workspaces keep teams, clients, or business units isolated on one shared
instance.

## Why own it

AI labs are racing toward IPOs, and public markets price growth, not margin. Today's below-cost
token pricing is a land-grab subsidy, not a floor, once a lab answers to shareholders, usage at
scale gets repriced toward what it actually costs to serve. If your business runs on AI at volume,
the cheapest and most durable move is to own the infrastructure that work runs on, so the model
underneath is a swappable input, not a structural dependency.

OperationKit is built that way. Your skills, agents, and knowledge base live in plain files on your
own server, not inside a model provider's product. Point OperationKit at Claude today. Point it at
GPT or Grok next quarter. Point it at an open-weight model on your own GPUs the quarter after that.
The work you've built, your context, your playbooks, your history of decisions, comes with you
every time, because none of it was ever stored in a provider's walled garden.

Think of it like a car and a gas station: the car (OperationKit) is what you own and drive, it
holds your stuff, your routes, your history. The model is the gas station you fill up at. You don't
rebuild the car to use a different station; you just pull into whichever one has the best price or
is actually open.

## Model portability

What transfers when you swap models: skills (`skills/<slug>/SKILL.md`), agents
(`agents/<slug>.md`), the knowledge base, and workspace/objective state (Postgres/SQLite-backed,
model-independent). None of it is stored in or dependent on a specific model provider.

**Supported today (shipped):**
- **Claude** (Anthropic), native engine, the default
- **Codex / OpenAI**, native engine
- **Grok** (xAI), native engine
- **Gemini**, via the bundled LiteLLM proxy (used today for the `research` model group)
- **Local open-weight models**, via LiteLLM + Ollama (used today for the `code` model group,
  routing to a local `qwen3` model against your own GPU)

**Roadmap:** model groups are independently configurable, and LiteLLM supports 100+ providers;
today's default config routes most reasoning/writing workloads to Claude, with Gemini and Ollama
wired for the research and code groups specifically. Broader "any workload, any provider" coverage
is a configuration exercise, not a rewrite. See
[docs/product/08-model-portability.md](./docs/product/08-model-portability.md) for how to
configure engines and LiteLLM model groups.

## Features

**Primary:**
- **Self-hosted, multi-tenant workspaces**, run OperationKit on your own server, with isolated
  workspaces per team or business unit
- **Model-agnostic engine routing**, point objectives at Claude, Codex, Grok, or any
  OpenAI-compatible/local model via LiteLLM
- **Board / objectives lifecycle**, a queue → working → review → done board tracks every unit of
  work with acceptance criteria
- **Skills / tools / agents layer**, composable, versioned knowledge and procedure files addressed
  by the `okit` CLI
- **Knowledge base**, team knowledge loads automatically before every session

**Secondary:**
- RBAC, per-workspace roles gate who can see and act on what
- An adversarial review gate, a fresh-context AI reviewer grades generated work against locked
  acceptance criteria before a human sees it
- External agents driving the board via API key, Claude Projects, Grok bots, ChatGPT custom GPTs,
  or any HTTP client can create and manage cards through a minted API key

## Docs

| | |
| --- | --- |
| Product (what it is, how to use it) | [docs/product/README.md](./docs/product/README.md) |
| Model portability | [docs/product/08-model-portability.md](./docs/product/08-model-portability.md) |
| Agent / HTTP API | [docs/api/README.md](./docs/api/README.md) · [portable prompt](./docs/api/AGENT-PROMPT.md) |
| Architecture | [docs/architecture/README.md](./docs/architecture/README.md) |
| Security / threat model | [SECURITY.md](./SECURITY.md) |
| Deploy / self-deploy | [docs/product/06-operating.md](./docs/product/06-operating.md) |

## Quickstart / self-host

See [docs/product/06-operating.md](./docs/product/06-operating.md) for deploy instructions, and
[SECURITY.md](./SECURITY.md) for the threat model before exposing it to a network.

## Status

Built to be a respectable open-source self-host: TLS, fail-loud secrets, login throttle, CSP,
signed webhooks. It is **not** PE-diligence / SOC 2 SaaS. The Docker socket and auto-approved agent
sessions are the product, and they are documented as such.

## License

Apache-2.0, see [LICENSE](./LICENSE).
