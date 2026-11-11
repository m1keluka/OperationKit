# Settings reorg — sprint 4b (obj 900496)

Sprint 4b of 8. Sister cards: 4a (top-nav / System page), 3 (theme tokens / logos), 5 (mailer /
onboarding), 6 (secrets-storage internals). This card does not touch any of those — it only wires
a Branding and an Email slot in for 3 and 5, and reuses whatever auth/secrets-storage already
exists without changing it.

## New tab/sidebar order

| # | Tab | Was | Gate | Why here |
|---|---|---|---|---|
| 1 | **Models** | Seats | global admin | The highest-traffic admin decision ("which engine/model runs this") belongs first, not buried as "Seats". Now also home for BYOK provider keys, engine failover, and the model registry. |
| 2 | **API & MCP** | You | everyone | The two ways to reach the board from outside the browser (REST key, MCP agent keys) plus webhooks — grouped and explained, not just "You". |
| 3 | **Integrations** | Connectors | everyone | "Connectors" was an internal name; "Integrations" says what it is (GitHub, Google Workspace, …) in the language the rest of the industry uses. |
| 4 | **Secrets** | Secrets | workspace/global admin | Unchanged position — it's the shared-secret and test-credential store, distinct from the personal secrets on API & MCP. |
| 5 | **Org** | Org | global admin | Unchanged; now with a one-line subtitle and clearer empty state. |
| 6 | **Agents & Skills** | Agents | global admin | Renamed to match the explanatory copy added inside it (Agents / Skills / Tools / Assignments). |
| 7 | **Branding** | — | global admin | New reserved slot for sister sprint 3 (theme tokens / logos). Disabled "coming soon" card — contents are NOT built here. |
| 8 | **Email** | — | global admin | New reserved slot for sister sprint 5 (mailer / onboarding). Disabled "coming soon" card — contents are NOT built here. |
| 9 | **Platform** | Platform | global admin | Unchanged; host cron. |

Old bookmarks still work: `/settings/you` → `/settings/api-mcp`, `/settings/connectors` →
`/settings/integrations`, `/settings/seats` → `/settings/models` (plus the pre-existing
`/settings/account` and `/settings/test-credentials` redirects). The redirect lives in
`SettingsPage.tsx` itself (segment check before the tab set), mirrored by a matching — but inert —
`<Route>` in `App.tsx` so the router has something to match before `SettingsPage` takes over, same
pattern the `account` redirect already used.

## What shipped per item

1. **Tab/sidebar proposal** — this doc, plus the PR description.
2. **Models** (`SettingsSeats.tsx`, unchanged seat-pool/failover behavior) — added
   `ProviderKeysSection.tsx` (BYOK: Anthropic / OpenAI / xAI / OpenAI-compatible custom base URL,
   stored through the existing `/api/secrets` global-scope mechanism, never redisplayed) and
   mounted the existing `ModelsModule` (model registry) here instead of on the Dashboard, which no
   longer renders it.
3. **API & MCP** (`AccountSettings.tsx`) — renamed from "You"; one short paragraph each above
   `ApiKeySection` ("the API") and `AgentKeysSection` ("MCP"); added `ApiMcpDocs.tsx` linking
   `GET /api/openapi.json` and `docs/api/README.md` / `AGENT-PROMPT.md` plus copy-paste MCP config
   JSON and a REST curl example, each with a `CopyButton` (new shared `ui` primitive — none existed).
   No key scope/default/permission changed.
4. **Agent webhooks** — already had Add/Edit, URL/events/server-generated-secret-shown-once, a
   "Send test event" action and a delivery log (`AgentWebhooksSection.tsx` /
   `agent-key-webhooks.ts`). Nothing to add; verified only.
5. **Integrations** (renamed from Connectors) — tab label, route (`/settings/integrations`),
   `ConnectorsPointer` → `IntegrationsPointer` card copy, the ⌘K palette entry, and the
   "Connectors"/"Settings → Connectors" strings in `AgentKeysSection.tsx` and the docs under
   `docs/`. Connector auth logic untouched.
6. **Organizations** (`SettingsOrg.tsx`, `WorkspacesTab.tsx`) — added a page subtitle, and expanded
   the empty-state copy to say what an org is and when to make one.
7. **Agents / Skills / Tools / Assignments** (`SettingsAgents.tsx`, route
   `/settings/agents-skills`) — added the four-sentence explanation (Agents = who, Skills =
   how-to, Tools = Integrations/MCP with a link there, Assignments = scoping) plus a copy-paste
   "set this up via your assistant" prompt. **Route note (post-rebase onto main, after 4a merged):**
   4a's merged nav consolidation claims `/settings/agents` as a `LEGACY_REDIRECTS` entry straight
   into the unified Agents hub (`/agents?tab=registry`) — that page is 4a's, not this card's. This
   tab therefore lives at the distinct segment `/settings/agents-skills` instead of
   `/settings/agents`, so the two don't collide. The sidebar label is unchanged ("Agents & Skills").
   **Assignments redundancy — proposed, not acted on:** `AssignmentsTab.tsx` is a separate
   global/workspace/project/user scope-picker for an agent or skill. It largely duplicates what a
   per-agent or per-skill "where does this apply" field on the roster itself could do, and today
   it is a second place to look for the same answer. Proposal: fold scope selection into the
   agent/skill edit form on the roster tab and retire the standalone Assignments tab — **not done
   in this PR**, flagging for a decision.
8. **Branding / Email slots** — searched for an existing branding-settings or email-settings
   component; found none (`useBranding.ts` is a read-only hook for logo/colors, not an editor; no
   mailer-settings component exists). Left both as disabled "coming soon" `Card`s
   (`SettingsBranding.tsx`, `SettingsEmail.tsx`) wired into the tab order — sister sprints mount
   their real content into these routes later.

## Out of scope (left alone on purpose)

- `/granola` and anything from PR #645 — untouched.
- Theme tokens, logos, brand colors — sister sprint 3's.
- Mailer/onboarding email delivery — sister sprint 5's.
- Secrets-storage internals (crypto, versioning, the store itself) — sister sprint 6's; this PR
  only calls the existing `/api/secrets` routes (the same ones `MySecretsSection` and the webhook
  sender-key flow already use).
- Top-nav / System page — sister card 4a's.
- Connector OAuth/credential logic — reused as-is, not touched.

## Verification gap

This was a plain worker session (no reviewer/design-arena Playwright MCP tools available), so no
before/after screenshots at 1440px/390px, light/dark were captured. The design/reviewer pass is
expected to do that visual verification; see the PR description for the explicit callout.
