# Wiring a catalog connector into the Tools layer

Sprint 7.6 (follow-up #6 of the [Sprint 7 integrations proposal](./INTEGRATIONS-PROPOSAL.md),
§4-§5). Once a connector exists (`app/server/src/connectors/defs/<id>.ts`, a
`ConnectorDefinition` per `app/server/src/connectors/types.ts`), a matching
**Tool definition** makes it usable by an agent via OperationKit's existing
Tools → Skills → Agents scaffolding (`okit new tool` / `okit validate` /
registry rebuild — see `app/server/src/routes/internal-operationkit.ts`). This
is **not new infrastructure**: it is a second consumer of the same credential
path and the same authoring tooling that already exist.

## The one credential path (do not invent a second one)

```
ConnectorDefinition.auth_path   (connectors/types.ts)
        │
        ▼
Tool frontmatter: auth.secrets[].env   (names the env var, never a value)
        │
        ▼
readCredential() → canUseConnectorCredential() → session env
   (connectors/registry.ts → services/connector-guard.ts)
```

A Tool's `auth.secrets[].env` entry is documentation of a session env var the
credential path **already** produces — it does not create a new way to fetch
a secret, and a Tool file must never carry a value, only a name
(`auth.secrets[].env`) and a plain-English `source`/`note` (see the worked
examples below). `source: session-spawn-env` is the honest answer for every
connector-backed key today: the real injection happens in
`app/server/src/services/session-spawn-env.ts` (`buildSpawnEnv`), which calls
`canUseConnectorCredential` before setting anything. For a connector that
implements `readCredential` directly (the generic path in
`connectors/registry.ts`), the same rule applies — the Tool just names
whichever env var that connector's `readCredential` returns.

## Worked examples (this PR)

Two representative connectors, one per UX flow that already ships in this
repo (see `docs/connectors/README.md`'s `auth_path` field):

| Connector | `auth_path` | Tool fixture | Rendered Tool |
|---|---|---|---|
| GitHub | `api_key` | [`tool-wiring/github.tool.json`](./tool-wiring/github.tool.json) | [`examples/workspace/tools/github/TOOL.md`](../../examples/workspace/tools/github/TOOL.md) |
| Google Workspace | `oauth_guided` | [`tool-wiring/google-workspace.tool.json`](./tool-wiring/google-workspace.tool.json) | [`examples/workspace/tools/google-workspace/TOOL.md`](../../examples/workspace/tools/google-workspace/TOOL.md) |

Each `.tool.json` fixture is exactly the `{frontmatter, body}` payload this
repo's own `POST /api/internal/operationkit/scaffold` (and the `okit new tool
<name> --from-json -` CLI it wraps) already accepts — so producing the
rendered `TOOL.md` from a fixture is a one-line call, not a new step:

```bash
curl -s -X POST http://localhost:3002/api/internal/operationkit/scaffold \
  -H 'Content-Type: application/json' -H "X-Internal-Secret: $INTERNAL_SECRET" \
  -d "$(node -e 'const f=require("./docs/connectors/tool-wiring/github.tool.json");process.stdout.write(JSON.stringify({kind:"tool",name:f.frontmatter.name,frontmatter:f.frontmatter,body:f.body,dry_run:true}))')"
```

(`dry_run:true` returns the would-be content without writing; drop it to
scaffold for real once a connector's `defs/<id>.ts` ships against an actual
OperationKit install.)

A `dcr_mcp` sample is deliberately **not** included here: it depends on the
shared DCR/CIMD client (Sprint 7.3, #900507), which is still in review as of
this writing. Once #900507 and the preload batch (Sprint 7.4, #900508) merge,
each new `ConnectorDefinition` they add gets the identical one-file Tool
wiring shown above — there is nothing connector-specific about the pattern
beyond which env var(s) its `auth_path` produces.

## Copy-paste agent prompt

Hand this to an agent, filling in the two blanks, to produce both the
`ConnectorDefinition` and its Tool wiring without a human writing TypeScript
or YAML by hand. This is the same "manifest in, validated file out" shape as
`okit new <kind> --from-json -` / `okit validate` already provide — the
prompt is a second consumer of that scaffolding, not a new mechanism.

```
You are adding <INTEGRATION NAME> to the OperationKit catalog.

1. Read app/server/src/connectors/types.ts (ConnectorDefinition, ConnectorAuthPath)
   and docs/connectors/README.md in full before writing anything.
2. Decide its auth_path: 'dcr_mcp' | 'oauth_guided' | 'api_key' | 'self_hosted_aggregator'
   — see §3 of docs/connectors/INTEGRATIONS-PROPOSAL.md for the four flows and
   which providers fit which. If the provider's OAuth/DCR story is unclear from
   its own docs (not a search summary), say so instead of guessing.
3. Write app/server/src/connectors/defs/<id>.ts: default-export a
   ConnectorDefinition with id, name, description, auth_path, connect, status(),
   disconnect(), and connectWithFields()/startOAuth() matching auth_path. Store
   credentials encrypted (services/crypto.ts); never log or return one. If the
   connector contributes anything to a session env, implement readCredential()
   — never read your own storage from a spawn path.
4. Write docs/connectors/guides/<id>.md: a short numbered setup walkthrough
   (see docs/connectors/guides/github.md for the shape), and point
   setup_guide at it.
5. Write the Tool wiring: a {frontmatter, body} JSON payload (see
   docs/connectors/tool-wiring/*.tool.json for the shape) with
   frontmatter.connector_id = <id>, frontmatter.auth_path matching step 2, and
   one auth.secrets[] entry per env var the connector's credential path
   produces (name only — no values). Validate it with
   POST /api/internal/operationkit/validate (kind: tool) before scaffolding.
6. State, in your summary, which env var(s) you declared and where they are
   actually set (services/session-spawn-env.ts, or your own readCredential) —
   a Tool definition naming a var nothing ever sets is a bug, not documentation.
```

## Rest of the preload list

The Sprint 7.4 preload card (#900508) adds the remaining 15-20 catalog
entries from the proposal's table; it was still open (PR #690, review
`fail`) at the time this PR was opened, so only the two connectors that
already ship in this repo (GitHub, Google Workspace) are wired here, per this
card's instructions. Once #900508 merges, apply steps 4-5 of the copy-paste
prompt above to each of its new `ConnectorDefinition` files — the pattern
does not change per connector, only which `auth_path` (and therefore which
env var names) each one declares.
