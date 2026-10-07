# FAQ

**Is this a SaaS?**
No. OperationKit is self-hosted — you run it on your own server, with your own accounts and your own keys. There's no hosted version this wiki is describing.

**Does it only work with Claude?**
No. Claude, Codex (OpenAI), and Grok are native engines today. Gemini and local open-weight models (via Ollama) are reachable through the bundled LiteLLM proxy for specific model groups. See [Model Portability](./Model-Portability) for exactly what's shipped vs. roadmap — don't assume every workload already routes to every provider; it doesn't yet.

**Can more than one team/client use the same install?**
Yes — that's the multi-tenant half of the category claim. Workspaces isolate cards, repos, and knowledge context per team; roles gate admin actions. See [Workspaces & Multi-tenancy](./Workspaces-and-Multi-tenancy).

**What's the difference between the review gate and a human reviewing the work?**
The review gate is an automated, fresh-context AI pass that grades a card's output against its own locked acceptance criteria — it's a filter, not a replacement for a person on anything that needs real judgment. See [Review Gate](./Review-Gate).

**Can I drive the board from outside the UI?**
Yes, through the agent HTTP API and a minted API key — a Claude Project, a Grok bot, a ChatGPT custom GPT, or a script can create and manage cards that way. See [External Agents](./External-Agents).

**What happens to my knowledge base / skills / agents if I change which model I'm using?**
Nothing — that's the point. They're plain files on your server, not stored inside a model provider's product. See [Why Own Your AI Infrastructure](./Why-Own-Your-AI-Infrastructure).

**Where do I report a bug or ask something not covered here?**
Open an issue on [github.com/m1keluka/OperationKit](https://github.com/m1keluka/OperationKit).

**Is this production-grade / audited to a compliance standard?**
It's built to be a respectable open-source self-host (TLS, fail-loud secrets, login throttling, CSP, signed webhooks) — it is explicitly not SOC 2 / PE-diligence SaaS. Read the repo's `SECURITY.md` before exposing it to a network.
