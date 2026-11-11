# Model portability

OperationKit's job queue, skills, agents, and knowledge base are plain files and
database-backed state: none of it is stored in or dependent on a specific model
provider. The model is a swappable input, not a structural dependency: point an
objective at Claude today, Grok or Codex tomorrow, a local open-weight model on your
own GPUs after that.

## What transfers when you swap models

- Skills (`skills/<slug>/SKILL.md`)
- Agents (`agents/<slug>.md`)
- The knowledge base (vault + per-workspace context)
- Workspace and objective state (Postgres/SQLite-backed, model-independent)

## Engines (native, per-objective model picker)

Each objective picks a model from the registry (`app/server/src/services/model-registry.ts`),
which maps a model row to one of three native engines:

- **Claude** (Anthropic), the default engine
- **Codex** (OpenAI), model ids matching the legacy `codex` alias or an OpenAI-style id
  (`/^(gpt-|o\d)/i`) route here
- **Grok** (xAI), model ids matching `/^grok/i` route here

This is the mechanism a Claude/Grok/Codex subscription seat spawns a session through.

## LiteLLM model groups (proxy routing, with fallback chains)

A bundled LiteLLM proxy (`config/litellm/config.yaml`, public template at
`oss/templates/litellm.config.yaml`) defines priority-ordered fallback chains per
model group:

| Model group | Order today |
| --- | --- |
| `orchestrator` | Claude Opus → Claude Sonnet |
| `research` | **Gemini Flash** → Claude Sonnet |
| `code` | **Local Ollama (`qwen3:32b`)** → Claude Sonnet → Claude Opus |
| `writing` | Claude Sonnet → Claude Opus |
| `reasoning` | Claude Opus |
| `assistant` | Claude Opus → Claude Sonnet |

**Shipped today:** the `research` and `code` groups already have a non-Claude model as
their first-choice route (Gemini for research/enrichment work, a local Ollama model
for code generation). This is the concrete proof that "run it on an open-weight
model on your own GPUs" is a real, working path, not a roadmap claim.

**Roadmap:** the `orchestrator`, `writing`, `reasoning`, and `assistant` groups route
to Claude only today; no Gemini/Ollama fallback is configured for them yet. LiteLLM
itself supports 100+ providers, so extending any group to a different provider (or
adding an OpenAI-compatible endpoint, or a self-hosted inference server beyond Ollama)
is a config change to `config/litellm/config.yaml`, not a code change. Say "today's
default config routes most reasoning/writing work to Claude" rather than "every
workload already runs on any model": that's not true yet.

## Configuring a model group

1. Edit `config/litellm/config.yaml` (copy `oss/templates/litellm.config.yaml` as a
   starting point if you don't have one yet).
2. Add or reorder `model_list` entries under the group you want to change. `order: 1`
   is tried first; later entries are fallbacks.
3. Set the matching API key env var (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
   `GPU_OLLAMA_URL` for a local Ollama host, or any other LiteLLM-supported provider
   key).
4. Restart the LiteLLM proxy container. No application code needs to change; the
   proxy is what routes a model-group name to a provider.

## External agents driving the board

Any HTTP-capable assistant (a Claude Project, a Grok custom bot, a ChatGPT custom
GPT) can act as a project-management layer on top of OperationKit via a minted API
key and the portable prompt in [docs/api/AGENT-PROMPT.md](../api/AGENT-PROMPT.md).
This is a secondary integration pattern on top of model portability, not a
replacement for it: the agent driving the board and the model executing the work on
a card are independent choices.
