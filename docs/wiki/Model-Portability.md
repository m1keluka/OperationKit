# Model Portability

What transfers when you swap models: skills (`skills/<slug>/SKILL.md`), agents (`agents/<slug>.md`), the knowledge base (your vault + per-workspace context files), and workspace/objective state (database-backed, model-independent). None of this is stored in or dependent on a specific model provider's infrastructure — it's plain markdown plus a database you control.

## Supported today (code-verified)

| Engine | How it's wired | Where |
| --- | --- | --- |
| **Claude** (Anthropic) | Native engine, the default | `app/server/src/services/model-registry.ts` — `engine: 'claude'` is the fallback mapping; a model row with no recognized engine resolves to Claude |
| **Codex / OpenAI** | Native engine | `model-registry.ts` maps `engine: 'codex'`; a heuristic (`/^(gpt-\|o\d)/i`) routes OpenAI-style model ids to the Codex engine when no explicit mapping exists |
| **Grok (xAI)** | Native engine | `model-registry.ts` maps `engine: 'grok'`; a heuristic (`/^grok/i`) routes Grok-style ids the same way |
| **Gemini** | Via the bundled LiteLLM proxy | `config/litellm/config.yaml`, model group `research` — routes to `gemini/gemini-2.0-flash` first, falls back to Claude Sonnet |
| **Local open-weight models** | Via LiteLLM + Ollama | `config/litellm/config.yaml`, model group `code` — routes to `ollama_chat/qwen3:32b` against your own `GPU_OLLAMA_URL`, falling back to Claude Sonnet then Opus if the local endpoint is unreachable |

The local-Ollama route is the concrete, shipped proof of "an open-weight model on your own GPUs" — it is not aspirational. It is one of two LiteLLM model groups wired with a non-Claude primary today (the other is `research` → Gemini).

**External chat agents driving the board via API key.** Claude Projects, Grok custom bots, ChatGPT custom GPTs, or any HTTP-capable assistant can act as a project-management layer on top of OperationKit through a portable prompt and a minted API key (`cc_live_` prefix). This is a specific, secondary feature built on top of the model-portability layer, not the category claim itself — see [External Agents](./External-Agents) for details.

## Roadmap — not yet shipped, don't read these as current

- **Every model group routed through LiteLLM.** The `orchestrator`, `writing`, `reasoning`, and `assistant` model groups in `config/litellm/config.yaml` are Claude-only today — no Ollama or Gemini fallback is wired for those groups yet. LiteLLM itself supports 100+ providers, so broadening coverage is a configuration change, not new engineering, but it has not shipped. The accurate statement today is: *model groups are independently configurable, and today's default config routes most reasoning/writing work to Claude* — not "every workload already runs on any model."
- **A self-hosted inference server beyond Ollama** (e.g. vLLM) is not referenced anywhere in the codebase. Treat as unplanned until it ships.
- **OpenRouter** is not integrated. Do not claim it.

## How to switch

1. Add or enable a model row (Settings → Agents, admin only) — this is what populates the model picker on a card.
2. For a provider beyond the three native engines (Claude, Codex, Grok), point the relevant LiteLLM model group in `config/litellm/config.yaml` at your provider/key, or at a local Ollama endpoint via `GPU_OLLAMA_URL`.
3. Pick the model on a card, or set a default/planner model for new objectives.

Nothing about your skills, agents, knowledge base, or objective history changes when you do this — that's the whole point. See [Why Own Your AI Infrastructure](./Why-Own-Your-AI-Infrastructure) for why that separation is the product's actual thesis.
