# `app/shared/flow/` — okflow/1 schema, validator, Mermaid view

Card B1 of [docs/design/WORKFLOWS.md](../../../docs/design/WORKFLOWS.md) §8. Pure TypeScript, no
dependencies, no server or UI wiring, and nothing runs at boot. Nothing here needs
`settings.flows_enabled`: that switch arrives with the engine (B2) and stays off until B4.

| File | What |
|---|---|
| `types.ts` | `FlowDefinition`, the 10 node types, `FlowRegistry` (injected resolver), `FlowIssue` + `FLOW_ERROR_CODES` |
| `validate.ts` | `validateFlow(doc, { registry?, requireApprovals? })` → `{ ok, errors, warnings }` |
| `expr.ts` | the `{{ }}` / assert expression parser (paths, 6 pure functions, comparisons, `&& \|\| !`) |
| `analyze.ts` | the structural walk shared by the validator and the renderer |
| `mermaid.ts` | `definitionToMermaid(def, { status? })` → `flowchart TD` (viewer V1, §6.1) |
| `self-test.ts` | B5: `nodesRequiringApproval`, `nodesMissingMocks`, `effectiveFixtures`, `stubFromSchema` |

Tests: `__tests__/*.test.ts` (run by the server vitest config, which includes
`../shared/**/*.test.ts`); Mermaid snapshots in `__tests__/__snapshots__/*.mmd`; and
`app/client/src/lib/flow-mermaid.test.ts` checks that the client's real `mermaid` parser accepts
the output.

## Semantics the design doc leaves open (decided here)

- **Blocks.** `branch.cases[].then`, `branch.default` and `loop.body` are *ordered* lists of
  node ids run in sequence. Their members carry no `next` (`BLOCK_NODE_HAS_NEXT`). When a block
  finishes, control rejoins at the owner's continuation: its `next`, or the next member of the
  enclosing block. This maps 1:1 onto Open Workflow nested `do` lists (B10).
- **Cycles.** The only allowed cycle is a loop's implicit back-edge. Reaching a node that is
  already on the current path in any other way is `CYCLE`. A node placed in two positions is
  `MULTIPLE_INCOMING`, and a node not reachable from the trigger is `UNREACHABLE_NODE`.
- **"Upstream".** `steps.X` is visible to node N when a control path runs from X to N. That
  includes the arms of an earlier branch, which may not have run, so use `default(a, b)`. A
  loop's body outputs are per-iteration: after the loop only `steps.<loop>.output` is visible.
  The goal may reference any node.
- **Loop variable.** `{{ item.<as>.field }}` names the enclosing loop's `as`, as in the §3.5
  example (§3.2's `{{ item.z }}` shorthand is not accepted).
- **Effects.** A declared `effect` wins unless the injected registry says the node is more
  dangerous (`EFFECT_UNDERSTATED`). With no declaration and no registry, `tool`/`mcp` are
  `send` (§3.2: unknown ⇒ send) and `llm`/`agent`/`trigger` are `read`. Structural kinds take
  no effect (`EFFECT_NOT_APPLICABLE`).
- **Approvals.** A `send`/`spend` node passes only if an approval `wait` *dominates* it (it is on
  every path, so one branch arm alone does not count) or it is listed in `approvals.nodes` for
  **this exact** `version`, by `user:<id>`. `requireApprovals: false` downgrades the error to a
  warning so a builder can validate a draft.
- **Unknown fields** are warnings (`UNKNOWN_FIELD`). Every rule in §3.4 is an error.
- **Fixtures (B5).** Optional top-level `fixtures: [{ name, payload }]` (1..10, unique names, object
  payloads) are the trigger payloads a self-test runs. A request to `POST /api/flows/:id/test` may
  pass its own list instead.
- **Approvals are recorded, not typed (B5).** `validateFlow` still checks an embedded `approvals`
  block, but the engine and the publish gate replace it with the owner's record in
  `flow_versions.approvals_json` before validating. `nodesRequiringApproval(def)` is the exact set
  the owner must approve to publish.
