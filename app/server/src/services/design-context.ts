/**
 * design-context.ts — shared, DORMANT helpers for the CC "dialed-UI" enforcement
 * system (Wave A foundation).
 *
 * Everything here is exported but intentionally NOT yet wired into the live spawn
 * (`prompt-builder.ts`) or review (`session-manager.ts`) paths. Importing this module
 * has zero behavioral effect on any objective. Waves B (spawn-injection) and C
 * (review-gate) will call these helpers; this module just makes them exist and be
 * unit-testable ahead of that wiring.
 *
 * Source of truth for the registry: `<PROJECTS_DIR>/.design-registry.json`
 * (schema documented in research 03-agent-mechanism.md §1.1).
 */
import fs from 'fs'
import path from 'path'
import type { Objective } from '@command-center/shared'
import { PROJECTS_DIR, SECOND_BRAIN_DIR, AI_WORKSPACE_DIR, VAULT_ROOT, HOME_DIR } from '../config.js'

/** One registry entry — a frontend repo's design-system pointers. All fields are
 *  optional except in practice each entry carries at least `tokensFile`. The shape
 *  is intentionally permissive: the registry is hand-authored JSON and Waves B/C
 *  only read a known subset. */
export interface DesignRegistryEntry {
  tokensFile?: string
  tailwind?: string
  primitives?: string
  primitivePrefix?: string
  tokenPrefix?: string
  accent?: string
  surfaceBase?: string
  system?: string
  note?: string
  bannedSignals?: string[]
  rules?: string[]
}

export type DesignRegistry = Record<string, DesignRegistryEntry>

/** UI enforcement gate mode. Read from `UI_GATE_MODE`; defaults to 'off'. Waves B/C
 *  use this to phase rollout (off → advisory → soft → hard) without a redeploy. */
export type UiGateMode = 'off' | 'advisory' | 'soft' | 'hard'

/** Resolve the registry file path. Defaults to `<PROJECTS_DIR>/.design-registry.json`;
 *  `DESIGN_REGISTRY_FILE` overrides it (used by tests to point at a committed fixture
 *  so the suite is hermetic and never depends on a real `/home/operator/projects` checkout).
 *  Resolved per-call (not captured at import) so the override applies regardless of load
 *  order — mirrors `gateConfigPath()`. */
function designRegistryPath(): string {
  return process.env.DESIGN_REGISTRY_FILE || path.join(PROJECTS_DIR, '.design-registry.json')
}

let _registryCache: DesignRegistry | null = null

/**
 * Load and cache the design registry. Returns `{}` (never throws) if the file is
 * absent or malformed — a missing registry must degrade to "no repo is a UI repo",
 * preserving today's behavior exactly. Keys beginning with `$` (e.g. `$comment`) are
 * stripped so they can't be mistaken for a project.
 */
export function loadDesignRegistry(): DesignRegistry {
  if (_registryCache) return _registryCache
  try {
    const raw = fs.readFileSync(designRegistryPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const clean: DesignRegistry = {}
    for (const [key, val] of Object.entries(parsed)) {
      if (key.startsWith('$')) continue
      if (val && typeof val === 'object') clean[key] = val as DesignRegistryEntry
    }
    _registryCache = clean
  } catch {
    _registryCache = {}
  }
  return _registryCache
}

/** Test/Wave-B hook: drop the cached registry so the next `loadDesignRegistry()`
 *  re-reads from disk. */
export function clearDesignRegistryCache(): void {
  _registryCache = null
}

const FRONTEND_EXT_RE = /\.(tsx|jsx|vue|svelte|css|scss)$/i
const FRONTEND_DIR_RE = /(^|\/)(app\/client|src\/components|src\/app|src\/pages|src\/modules)(\/|$)/

/**
 * True if ANY of the given paths looks like frontend work — by extension
 * (.tsx/.jsx/.vue/.svelte/.css/.scss) or by living under a known UI directory.
 * Mirrors the frontend-touch heuristic in research 04 §1a.
 */
export function isFrontend(paths: string[] | null | undefined): boolean {
  if (!paths || paths.length === 0) return false
  return paths.some((p) => FRONTEND_EXT_RE.test(p) || FRONTEND_DIR_RE.test(p))
}

/**
 * True if an objective should be treated as a UI objective:
 *   - PRIMARY (deterministic): its `project` is a registered frontend repo, OR
 *   - SECONDARY (explicit opt-in): it carries an acceptance criterion with
 *     type === 'visual' or method === 'browser'.
 * See research 03 §1.3. No NLP. Repos with no registry entry and no visual/browser
 * criterion return false — i.e. behave exactly as today.
 */
export function isUiObjective(objective: Objective): boolean {
  const reg = loadDesignRegistry()
  const touchesFrontendRepo = !!objective.project && objective.project in reg
  // acceptance_criteria is typed AcceptanceCriterion[] | null, but raw DB rows
  // store it as a JSON string. HTTP routes normalize via mapObjective(); the
  // spawn path passes the raw row, so coerce defensively here — otherwise
  // `.some` throws and the entire session spawn fails (observed 2026-06-21
  // starting obj-1114, whose acceptance_criteria was a JSON string).
  const rawCriteria: unknown = objective.acceptance_criteria
  const criteria: Array<{ type?: string; method?: string }> = Array.isArray(rawCriteria)
    ? rawCriteria
    : typeof rawCriteria === 'string' && rawCriteria.length > 0
      ? (() => { try { const p = JSON.parse(rawCriteria); return Array.isArray(p) ? p : [] } catch { return [] } })()
      : []
  const hasVisualCriterion = criteria.some(
    (c) => c?.type === 'visual' || c?.method === 'browser',
  )
  return touchesFrontendRepo || hasVisualCriterion
}

/** Convenience: the registry entry for an objective's project, or undefined. */
export function getDesignEntry(objective: Objective): DesignRegistryEntry | undefined {
  if (!objective.project) return undefined
  return loadDesignRegistry()[objective.project]
}

/**
 * Current UI gate mode from `UI_GATE_MODE` (default 'off'). Any unrecognized value
 * also degrades to 'off' so a typo can never accidentally enable enforcement.
 */
export function getUiGateMode(): UiGateMode {
  const raw = (process.env.UI_GATE_MODE || '').trim().toLowerCase()
  if (raw === 'advisory' || raw === 'soft' || raw === 'hard') return raw
  return 'off'
}

/**
 * Master on/off switch for ALL dialed-UI behavior (spawn-time injection, the
 * delegator ds-criteria instruction, the API auto-append, and — in Wave C — the
 * review gate). When this returns false (the default, `UI_GATE_MODE` unset or
 * 'off'), every spawn prompt and every review is BYTE-IDENTICAL to pre-Wave-B
 * behavior. Flipping the flag to advisory/soft/hard activates the conditioning.
 * Centralized here so spawn (Wave B) and review (Wave C) share one definition.
 */
export function isUiGateActive(): boolean {
  return getUiGateMode() !== 'off'
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime control-plane: file-backed gate config + per-platform scoping (obj 582).
//
// The gate mode (and an optional per-platform allowlist) can be set from a runtime
// JSON file — `<PROJECTS_DIR>/.ui-gate.json` — re-read live behind a short TTL cache.
// This makes activation a FILE WRITE (no process restart; see entrypoint.sh, which
// re-execs tsx under the same container env so a new env var is NOT picked up) and
// lets the gate be scoped to specific platforms (registry project keys). The env var
// `UI_GATE_MODE` remains the fallback when the file is absent/unreadable/invalid, and
// the default is still 'off'. With the file ABSENT and `UI_GATE_MODE` unset, every
// resolver below returns 'off' ⇒ runtime is byte-identical to the env-only design.
// ─────────────────────────────────────────────────────────────────────────────

/** Parsed, validated shape of `.ui-gate.json`. `platforms`, when present and
 *  non-empty, is an allowlist of registry project keys (the same keys as
 *  `.design-registry.json`, e.g. 'example-project-platform'); the configured mode then
 *  applies ONLY to those projects and every other project resolves to 'off'. Absent
 *  or empty ⇒ the mode applies globally. */
export interface UiGateConfig {
  mode: UiGateMode
  platforms: string[]
  /** Optional design-arena control block (obj 594). Additive + dormant: absent or
   *  malformed ⇒ `undefined` ⇒ arena OFF, and the {mode,platforms} gate above is
   *  entirely unaffected. The arena is toggled via the SAME `.ui-gate.json`
   *  control-plane (no second mechanism), re-read live behind the same TTL cache. */
  arena?: ArenaGateBlock
}

/** Parsed `arena` block of `.ui-gate.json`. `enabled` is the master switch (default
 *  false ⇒ dormant); `platforms`, when non-empty, is an allowlist of registry project
 *  keys the arena applies to (empty ⇒ all projects, same semantics as `platforms`
 *  above). Validated strictly by `readGateConfigFile`; anything malformed degrades to
 *  `undefined` (arena off) rather than guessing. */
export interface ArenaGateBlock {
  enabled: boolean
  platforms: string[]
}

/** Resolve the runtime gate-config file path. Defaults to `<PROJECTS_DIR>/.ui-gate.json`;
 *  `UI_GATE_FILE` overrides it (used by tests and alternate deployments). */
function gateConfigPath(): string {
  return process.env.UI_GATE_FILE || path.join(PROJECTS_DIR, '.ui-gate.json')
}

const GATE_CONFIG_TTL_MS = 5000
let _gateConfigCache: { cfg: UiGateConfig; at: number } | null = null

/**
 * Read + validate the gate-config file. Returns null (⇒ caller falls back to env)
 * when the file is absent, unreadable, not valid JSON, not an object, carries an
 * unrecognized `mode`, or carries a `platforms` that is not an array of strings.
 * Strict on purpose: any malformed config degrades to the env fallback (and thus,
 * by default, to 'off') rather than guessing.
 */
function readGateConfigFile(): UiGateConfig | null {
  try {
    const raw = fs.readFileSync(gateConfigPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return null
    const m = typeof parsed.mode === 'string' ? parsed.mode.trim().toLowerCase() : ''
    if (m !== 'off' && m !== 'advisory' && m !== 'soft' && m !== 'hard') return null
    let platforms: string[] = []
    if (parsed.platforms != null) {
      if (!Array.isArray(parsed.platforms)) return null
      if (!parsed.platforms.every((p) => typeof p === 'string')) return null
      platforms = (parsed.platforms as string[]).map((p) => p.trim()).filter(Boolean)
    }
    // Arena block (obj 594) — parsed DEFENSIVELY and additively: a malformed `arena`
    // never invalidates the file (the gate's {mode,platforms} contract is preserved);
    // it just degrades the arena to `undefined` (off). Absent ⇒ undefined ⇒ dormant.
    const arena = parseArenaBlock(parsed.arena)
    return { mode: m as UiGateMode, platforms, arena }
  } catch {
    return null
  }
}

/** Validate the optional `.ui-gate.json` `arena` block. Returns `undefined` (arena
 *  OFF) for anything that is not `{ enabled: boolean, platforms?: string[] }`. Never
 *  throws — defensive on purpose so a typo in the arena block cannot break the gate. */
function parseArenaBlock(raw: unknown): ArenaGateBlock | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.enabled !== 'boolean') return undefined
  let platforms: string[] = []
  if (r.platforms != null) {
    if (!Array.isArray(r.platforms)) return undefined
    if (!r.platforms.every((p) => typeof p === 'string')) return undefined
    platforms = (r.platforms as string[]).map((p) => p.trim()).filter(Boolean)
  }
  return { enabled: r.enabled, platforms }
}

/**
 * Load the effective gate config, TTL-cached (~5s) so a live file edit is picked up
 * at runtime WITHOUT a process restart, but the filesystem is not hit on every gate
 * read. The file wins when valid; otherwise this falls back to env (`UI_GATE_MODE`)
 * with no allowlist. The fallback is itself cached so env-only deployments don't
 * re-stat the (absent) file on every call.
 */
export function loadGateConfig(): UiGateConfig {
  const now = Date.now()
  if (_gateConfigCache && now - _gateConfigCache.at < GATE_CONFIG_TTL_MS) {
    return _gateConfigCache.cfg
  }
  const cfg = readGateConfigFile() ?? { mode: getUiGateMode(), platforms: [] }
  _gateConfigCache = { cfg, at: now }
  return cfg
}

/** Drop the cached gate config so the next read re-reads the file. Used by tests to
 *  simulate TTL expiry / a live file edit; harmless in production. */
export function clearGateConfigCache(): void {
  _gateConfigCache = null
}

/**
 * The EFFECTIVE gate mode for a given objective's project, applying the file-backed
 * config + per-platform allowlist:
 *   - configured mode 'off'            ⇒ 'off'
 *   - no/empty allowlist (global)      ⇒ the configured mode (every project)
 *   - project ∈ allowlist              ⇒ the configured mode
 *   - project ∉ a non-empty allowlist  ⇒ 'off'
 * This is what the reviewer gate consumes in place of the raw global `getUiGateMode()`.
 * It ONLY decides WHICH mode a project sees; the downstream off/advisory/soft/hard
 * verdict semantics in `buildVisionRubricBlock` are unchanged (advisory never bounces).
 */
export function getEffectiveGateMode(project: string | null | undefined): UiGateMode {
  const { mode, platforms } = loadGateConfig()
  if (mode === 'off') return 'off'
  if (platforms.length === 0) return mode
  return project && platforms.includes(project) ? mode : 'off'
}

/**
 * Per-objective master switch for spawn-time conditioning (design-context injection,
 * the delegator ds-criteria instruction line, and the API ds-conformance auto-append).
 * This is the FILE-BACKED, per-platform-scoped counterpart to the legacy env-only
 * `isUiGateActive()`. It resolves the effective mode for THIS objective's project via
 * `getEffectiveGateMode` (file `.ui-gate.json` → per-platform allowlist → env
 * `UI_GATE_MODE` fallback → default 'off') and is active when that mode is not 'off'.
 *
 * Dormancy is preserved EXACTLY: with the file absent and `UI_GATE_MODE` unset, or
 * `mode:'off'`, or a project outside a non-empty `platforms` allowlist, this returns
 * false ⇒ the spawn prompt is byte-identical to pre-activation behavior. It mirrors the
 * reviewer half (`session-manager.ts`), which already consumes `getEffectiveGateMode`,
 * so injection and review now share ONE control-plane (the `.ui-gate.json` file write,
 * no restart) instead of injection being stranded on the un-flippable env gate.
 */
export function isUiInjectionActive(objective: Objective): boolean {
  return getEffectiveGateMode(objective.project) !== 'off'
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave B (spawn-time conditioning) — APPEND-ONLY additions below this line.
// A parallel Wave C worker also imports this module; keep new exports additive so
// the merge surface stays minimal. Nothing here changes the behavior of the
// Wave A helpers above, and none of it runs unless `buildDesignContextBlock` /
// `buildDsConformanceCriteria` are called from the (gated) spawn path.
// ─────────────────────────────────────────────────────────────────────────────

import type { AcceptanceCriterion } from '@command-center/shared'

/**
 * Layer B — shared anti-slop guardrails. Cross-platform, identical for every UI
 * objective (tokens are per-platform; doctrine is universal). Verbatim distillation
 * of ~/ai-workspace/skills/design/visual-identity.md + design-review.md so the
 * worker never has to read the full skill files to get the non-negotiables.
 */
export const ANTI_SLOP_GUARDRAILS = `## Anti-slop guardrails (non-negotiable)
- NO default/system fonts as the primary face (Inter, Roboto, system-ui, Space Grotesk) where the project ships a brand font — use the project's fonts.
- NO purple/indigo→blue gradients on light backgrounds (the #1 AI-slop tell). No rogue gradients at all unless the token system defines them.
- NO rogue hex and NO off-token grays — every color comes from a token. Grep your diff for \`#\`, \`bg-gray\`, \`bg-slate\`, \`bg-zinc\`, \`bg-neutral\`, \`bg-indigo\`, \`bg-purple\` before you finish; zero hits outside the token file.
- Hierarchy via size + weight + color, not just position. Interactive elements must NOT look like static text.
- Hover (scale/shadow/border, not only color), focus rings, disabled, and loading states on EVERY control.
- Empty states are designed; loading uses skeletons, not bare spinners. Transitions 150–300ms.
- WCAG AA contrast (4.5:1 normal text, 3:1 large) and touch targets ≥44×44px — NON-NEGOTIABLE.
Full checklist: /home/operator/ai-workspace/skills/design/design-review.md (run it before you finish).`

/**
 * Layer C — the worker self-critique mandate. Tier-1 of the two-tier visual loop
 * (research 03 §2.2): the worker screenshots its own work and grades it before
 * declaring done, iterating ≤2×. The independent `ai_review` reviewer (Wave C) is
 * the adversarial Tier-2 gate; this is the cheap in-context first pass.
 */
export const SELF_CRITIQUE_MANDATE = `## Visual self-critique (REQUIRED before you declare this objective done)
You have Playwright MCP (browser_navigate, browser_take_screenshot). Before finishing:
1. Run the app / preview and navigate to the screen(s) you changed.
2. browser_take_screenshot at 1440px AND 390px (desktop + mobile). Record the saved paths.
3. Critique each screenshot against the anti-slop guardrails above and your ds-conformance
   acceptance criteria. For EACH item write PASS/FAIL + one line of evidence.
4. If ANY visual/interaction item FAILs (accessibility items are hard-fail), fix it and re-shoot.
   Iterate at most TWICE. If it still fails after 2 tries, say so explicitly in your summary and
   do NOT silently declare done.
5. Attach the final screenshot paths in your summary so the independent reviewer can grade them.`

/**
 * Resolve the absolute on-disk path of a registry entry's token file, or null if
 * the entry has no tokensFile. Paths in the registry are repo-relative; they
 * resolve under `<PROJECTS_DIR>/<project>/<tokensFile>`.
 */
function resolveTokensPath(project: string, entry: DesignRegistryEntry): string | null {
  if (!entry.tokensFile) return null
  return path.join(PROJECTS_DIR, project, entry.tokensFile)
}

/**
 * Build the spawn-time Design Context block (Layers A+B+C) for a UI objective.
 * Returns an array of prompt lines (caller spreads them into `parts`). Layer A is
 * resolved from the real registry entry for `objective.project`; if the objective
 * is a UI objective only by virtue of a visual/browser criterion on an UNREGISTERED
 * repo (no entry), Layer A degrades to a generic "conform to the existing system"
 * note (no fabricated token path).
 *
 * The CALLER is responsible for gating on `isUiObjective(objective)` — this function
 * does not re-check, so it can also be reused by the reviewer path (Wave C). When
 * called for a non-UI objective it still produces a (harmless) generic block, but
 * the spawn path must not call it in that case to preserve byte-identical prompts.
 */
export function buildDesignContextBlock(objective: Objective): string[] {
  const project = objective.project || 'this frontend repo'
  const entry = getDesignEntry(objective)

  const lines: string[] = []
  lines.push(
    '## Design Context (this objective edits a frontend repo — DIALED UI IS A REQUIREMENT)',
    '',
    `You are editing ${project}. Its design system already exists. Do NOT invent tokens, fonts, or`,
    'colors — conform to what is already shipped:',
  )

  if (entry) {
    const tokensPath = resolveTokensPath(project, entry)
    if (tokensPath) {
      const prefixNote = entry.tokenPrefix ? ` (${entry.tokenPrefix})` : ''
      lines.push(`- Tokens: read ${tokensPath}${prefixNote} BEFORE writing any styling. Use those tokens only.`)
    }
    if (entry.system) {
      lines.push(`- System: ${entry.system}. Use its semantic classes/variables, never raw hex or raw palette grays.`)
    }
    if (entry.primitives || entry.primitivePrefix) {
      const primNote = entry.primitivePrefix
        ? `reuse existing ${entry.primitivePrefix}* primitive components`
        : `reuse the existing primitive components${entry.primitives ? ` (${entry.primitives})` : ''}`
      lines.push(`- Primitives: ${primNote}; do not hand-roll buttons/inputs/cards/badges.`)
    }
    if (entry.accent || entry.surfaceBase) {
      const bits = [
        entry.accent ? `accent ${entry.accent}` : null,
        entry.surfaceBase ? `base surface ${entry.surfaceBase}` : null,
      ].filter(Boolean)
      lines.push(`- Identity: ${bits.join(', ')} — match the existing chrome.`)
    }
    for (const rule of entry.rules ?? []) {
      lines.push(`- Hard rule: ${rule}`)
    }
    if ((entry.bannedSignals ?? []).length > 0) {
      lines.push(`- Banned in this repo: ${entry.bannedSignals!.join('; ')}.`)
    }
    lines.push('- Run `scripts/ui-conformance.sh <changed files>` on your diff before finishing; it must exit 0.')
  } else {
    lines.push(
      '- This repo has no registry entry, but a visual/browser criterion marks this as UI work.',
      '- Read the existing components you are near and match their tokens, spacing, and type scale.',
      '- Do NOT introduce raw hex, off-token grays, or hand-rolled primitives where the codebase already has them.',
    )
  }

  lines.push('', ANTI_SLOP_GUARDRAILS, '', SELF_CRITIQUE_MANDATE)
  return lines
}

/**
 * True if `project` is a registered frontend repo (has a `.design-registry.json`
 * entry). Mirrors the deterministic primary signal of `isUiObjective`, but takes a
 * bare project string so the objectives API handler (which works on loosely-typed
 * request items, not a full Objective) can reuse it.
 */
export function isRegisteredFrontendRepo(project: string | null | undefined): boolean {
  return !!project && project in loadDesignRegistry()
}

/** A loose acceptance-criterion shape as it arrives over the wire (all fields
 *  optional except none guaranteed) — the API handler validates later. */
type LooseCriterion = { id?: string; criterion?: string; type?: string; method?: string }

/**
 * True if the given criteria already carry a UI/taste bar — i.e. a criterion whose
 * `type` is 'visual', whose `method` is 'browser' or 'static', or whose `id` is
 * already a `ds-*` conformance criterion. Used to avoid double-appending the
 * ds-conformance block when a delegator already attached one.
 */
export function criteriaHaveUiBar(
  criteria: ReadonlyArray<LooseCriterion> | null | undefined,
): boolean {
  if (!criteria || criteria.length === 0) return false
  return criteria.some(
    (c) =>
      c?.type === 'visual' ||
      c?.method === 'browser' ||
      c?.method === 'static' ||
      (typeof c?.id === 'string' && c.id.startsWith('ds-')),
  )
}

/**
 * Build the drop-in 5-criterion ds-conformance block, resolved for `project`'s
 * registered design system. These are the locked review bars that make taste
 * gradable (research 03 §3). `ds-tokens-only` uses method:'static' so the reviewer
 * runs the deterministic `scripts/ui-conformance.sh` lint rather than eyeballing.
 * Repos with no registry entry still get a sensible generic block.
 */
export function buildDsConformanceCriteria(project: string): AcceptanceCriterion[] {
  const entry = loadDesignRegistry()[project]
  const tokenDesc = entry?.tokenPrefix ? `${entry.tokenPrefix} tokens` : 'the platform design tokens'
  const tokensFile = entry?.tokensFile ? `outside ${entry.tokensFile}` : 'outside the token file'
  const primDesc = entry?.primitivePrefix
    ? `${entry.primitivePrefix}* primitive components`
    : 'the existing primitive components'

  return [
    {
      id: 'ds-tokens-only',
      criterion: `All colors/spacing/radii in ${project} come from ${tokenDesc} — zero rogue hex, zero inline style with a hardcoded color, zero raw bg-gray-*/bg-indigo-* ${tokensFile}. Verify by running scripts/ui-conformance.sh on the diff (must exit 0).`,
      type: 'visual',
      method: 'static',
    },
    {
      id: 'ds-primitives',
      criterion: `Reuses ${primDesc} for buttons/inputs/cards/badges; no hand-rolled equivalents.`,
      type: 'visual',
      method: 'doc',
    },
    {
      id: 'ds-renders-conformant',
      criterion: `Rendered screen at 1440px and 390px visually matches the platform's existing chrome (same surfaces, type scale, accent usage). Screenshot attached.`,
      type: 'visual',
      method: 'browser',
    },
    {
      id: 'ds-interaction-states',
      criterion: `Every interactive element has visible hover, focus-ring, disabled, and loading states; transitions 150–300ms.`,
      type: 'visual',
      method: 'browser',
    },
    {
      id: 'ds-a11y-contrast',
      criterion: `All text meets WCAG AA contrast (4.5:1 normal, 3:1 large); touch targets ≥44×44px. (NON-NEGOTIABLE.)`,
      type: 'functional',
      method: 'browser',
    },
  ]
}

// ── Production-worthy QA gate (obj 2390) ─────────────────────────────────────
//
// Sibling to the ds-conformance block above, for the OTHER class of false-confidence
// pass: a Playwright/E2E run that only asserts "pages return 200 / render something".
// The contract (qa-enforcement skill → "Production-Worthy Gate Contract") says a QA
// pass is shippable ONLY if it asserts, at minimum: (1) a critical-path smoke,
// (2) ≥1 role-matrix assertion, and (3) ≥1 error/empty/invalid-state assertion.
// We encode that as three gradable acceptance criteria the adversarial reviewer
// checks — mirroring how ds-* makes taste gradable. Drop-in doc + per-repo
// substitution live in `~/ai-workspace/skills/devops/qa-conformance-criteria.md`.

/** Repos that ship a Playwright / E2E suite the QA gate applies to. Keyed on the
 *  project string (same identifier the board/API uses). command-center-infra is
 *  intentionally excluded: it has Vitest only, no Playwright e2e (see its CLAUDE.md). */
const E2E_SUITE_REPOS: ReadonlySet<string> = new Set(['example-platform', 'example3-platform'])

/** True if `project` has an E2E suite the production-worthy QA gate should grade. */
export function repoHasE2eSuite(project: string | null | undefined): boolean {
  return !!project && E2E_SUITE_REPOS.has(project)
}

/**
 * True if the given criteria already carry a QA bar — any `qa-*` criterion id.
 * Used to avoid double-appending the qa-conformance block when a delegator already
 * attached one (mirrors `criteriaHaveUiBar`).
 */
export function criteriaHaveQaBar(
  criteria: ReadonlyArray<LooseCriterion> | null | undefined,
): boolean {
  if (!criteria || criteria.length === 0) return false
  return criteria.some((c) => typeof c?.id === 'string' && c.id.startsWith('qa-'))
}

/**
 * Build the drop-in 3-criterion production-worthy QA block. These are the locked
 * review bars that stop a page-loads-only Playwright pass from being mistaken for a
 * shippable one. Repo-agnostic — the same three classes apply to any e2e suite.
 */
export function buildQaConformanceCriteria(): AcceptanceCriterion[] {
  return [
    {
      id: 'qa-smoke',
      criterion:
        'Critical-path smoke: the primary screen(s) load and render real content (not 500/blank); asserted via web-first retrying assertions (no waitForTimeout sleeps).',
      type: 'functional',
      method: 'browser',
    },
    {
      id: 'qa-role-matrix',
      criterion:
        'At least one role-matrix assertion: an authenticated role sees what it should AND does not see what it shouldn’t (page-loads-only does not satisfy this).',
      type: 'functional',
      method: 'browser',
    },
    {
      id: 'qa-error-state',
      criterion:
        'At least one error/empty/invalid-state assertion: the UI handles a failure or empty path gracefully (visible error/empty/retry, not a blank screen or unhandled crash).',
      type: 'functional',
      method: 'browser',
    },
  ]
}

// ── Per-changed-files UI detection (obj 1453) ────────────────────────────────
//
// The auto-append above (and `isUiObjective`) keys the ds-* visual rubric on the
// objective's PROJECT — `command-center-infra` is a registered frontend repo, so
// EVERY objective on it (a scheduler change, a state-poller fix) inherits the
// 5-criterion ds-conformance block. The render/browser criteria
// (ds-renders-conformant, ds-interaction-states, ds-a11y-contrast) need a screen,
// so a backend-only PR can NEVER turn them green — the adversarial reviewer caps
// out at 3/3 with an unsatisfiable FAIL (obj 1284 could only land via owner-bypass).
//
// At REVIEW time the changed-file list IS known (session_intel → files_touched), so
// we can downgrade the project-level signal to a per-PR one using the SAME `isFrontend`
// heuristic the registry detection uses. A PR that touches no client/UI file is graded
// against correctness/test/tsc, not screenshots.

/**
 * True only when we can DETERMINE the change touches no frontend/UI files. Requires a
 * NON-EMPTY `filesTouched` list — an empty/unknown list returns false so we never strip
 * the visual bar on missing intel (preserving the full ds-* rubric is the safe default,
 * and the no-UI route must be a deliberate, evidenced decision). Uses `isFrontend`, the
 * same per-file heuristic registry detection relies on, at the per-changed-files level.
 */
export function isBackendOnlyChange(filesTouched: string[] | null | undefined): boolean {
  if (!filesTouched || filesTouched.length === 0) return false
  return !isFrontend(filesTouched)
}

/**
 * True if a criterion is a UI/visual bar that needs a rendered screen or visual
 * judgment — `type:'visual'`, `method:'browser'|'static'`, or a `ds-*` id. These are
 * exactly the criteria a backend-only PR cannot satisfy. (Same predicate
 * `criteriaHaveUiBar` uses, per-criterion.)
 */
export function isVisualCriterion(c: LooseCriterion | null | undefined): boolean {
  if (!c) return false
  return (
    c.type === 'visual' ||
    c.method === 'browser' ||
    c.method === 'static' ||
    (typeof c.id === 'string' && c.id.startsWith('ds-'))
  )
}

/**
 * The fallback bar a backend-only PR is graded against once the visual/ds-* criteria
 * are removed. Keeps a non-empty, REACHABLE-green rubric: correctness + tsc + the
 * harness/test-agent status, verified by reading the diff/output — never a screen. This
 * is what makes a backend PR's green path reachable instead of auto-passing on an empty
 * rubric.
 */
export const BACKEND_CORRECTNESS_CRITERION: AcceptanceCriterion = {
  id: 'backend-correctness',
  criterion:
    'The change is correct and complete: it typechecks (tsc), the test suite passes ' +
    '(the harness/test-agent commit status is green), and the implementation satisfies ' +
    'the objective description/plan. Verify by reading the diff, the harness status, and ' +
    'command output — this PR touches no UI, so do NOT grade it on a rendered screen.',
  type: 'functional',
  method: 'doc',
}

/**
 * Resolve the rubric the reviewer should actually grade, given the files the PR touched.
 *
 *   - Frontend PR, OR empty/unknown filesTouched ⇒ criteria returned UNCHANGED (the full
 *     ds-* visual rubric still applies — no regression in design-conformance enforcement).
 *   - Backend-only PR (filesTouched non-empty & no frontend file) ⇒ drop every visual/ds-*
 *     criterion; if that empties the rubric, substitute `BACKEND_CORRECTNESS_CRITERION` so
 *     the bar stays non-empty and reachable.
 *
 * `stripped` reports whether any visual criterion was removed (callers use it to annotate
 * the reviewer prompt / log). Generic over the loose wire shape and the strict
 * `AcceptanceCriterion`, so both the GET /criteria handler and tests can use it.
 */
export function rubricForChangedFiles<T extends LooseCriterion>(
  criteria: T[] | null | undefined,
  filesTouched: string[] | null | undefined,
): { criteria: T[]; stripped: boolean } {
  const list = Array.isArray(criteria) ? criteria : []
  if (list.length === 0 || !isBackendOnlyChange(filesTouched)) {
    return { criteria: list, stripped: false }
  }
  const kept = list.filter((c) => !isVisualCriterion(c))
  if (kept.length === list.length) return { criteria: list, stripped: false }
  const final = kept.length > 0 ? kept : [BACKEND_CORRECTNESS_CRITERION as unknown as T]
  return { criteria: final, stripped: true }
}

// ── Wave C: the vision review gate (rubric + design-context injection) ───────
//
// Everything below produces PROMPT TEXT that buildReviewerPrompt injects into the
// reviewer session. It is wired ONLY through `buildVisionRubricBlock`, which
// returns '' (empty — no injection) whenever the gate is `off` or the objective is
// not a UI objective. That empty-string short-circuit is the dormancy guarantee:
// with UI_GATE_MODE unset/off the reviewer prompt is byte-identical to Wave A.

/**
 * Per-project design context the reviewer reads BEFORE grading R4/R9 — the allowed
 * palette + the documented slop tells for this specific repo. Token/primitive paths
 * are emitted as ABSOLUTE paths (resolved under PROJECTS_DIR) so the reviewer can
 * open them regardless of its own `$HOME` (see the `~`-home fix in session-manager).
 */
export function buildReviewerDesignContextBlock(objective: Objective): string {
  const entry = getDesignEntry(objective)
  const project = objective.project || ''
  if (!entry) {
    // UI objective by virtue of a visual/browser criterion but no registry entry
    // (e.g. an ad-hoc repo). Grade against the generic anti-slop tells only.
    return [
      '=== DESIGN CONTEXT ===',
      `Project \`${project || '(unregistered)'}\` has no design-registry entry. Grade R4/R9 against the`,
      'generic anti-slop tells: no rogue hex, no raw Tailwind gray/indigo/purple palette, no pure',
      'black/white, no emoji-as-icons. Prefer whatever token system the repo already uses.',
    ].join('\n')
  }
  const tokenPath = entry.tokensFile
    ? path.join(PROJECTS_DIR, project, entry.tokensFile)
    : '(none declared)'
  const primitivesPath = entry.primitives
    ? path.join(PROJECTS_DIR, project, entry.primitives)
    : (entry.primitivePrefix ? `${entry.primitivePrefix}* primitive components` : '(none declared)')
  const lines: string[] = [
    '=== DESIGN CONTEXT (read before grading R4 color / R9 conformance) ===',
    `Project: ${project}${entry.system ? ` (${entry.system})` : ''}`,
    `Token source (READ THIS FILE — absolute path): ${tokenPath}`,
    `Primitives: ${primitivesPath}`,
  ]
  if (entry.tokenPrefix) lines.push(`Allowed token namespace: ${entry.tokenPrefix}`)
  if (entry.accent) lines.push(`Accent: ${entry.accent} (one accent does the work; do not introduce competing accents)`)
  if (entry.surfaceBase) lines.push(`Surface base: ${entry.surfaceBase}`)
  if (entry.note) lines.push(`Note: ${entry.note}`)
  if (entry.bannedSignals?.length) {
    lines.push('Banned signals (any present ⇒ R4/R9 fail):')
    for (const s of entry.bannedSignals) lines.push(`  - ${s}`)
  }
  if (entry.rules?.length) {
    lines.push('Conformance rules:')
    for (const r of entry.rules) lines.push(`  - ${r}`)
  }
  return lines.join('\n')
}

/** The 9-point vision rubric (research 04 §1b). Graded pass/warn/fail per dimension
 *  against screenshots at 360/768/1440px. Stable text — same wording every spawn.
 *  Exported (additive) so the design-arena judge can grade variants against the
 *  EXACT same bar production enforces — same rubric, no drift. */
export const VISION_RUBRIC = [
  'R1 Visual hierarchy — one clear focal point; size/weight/color encode importance. FAIL: everything same weight, no focal point, flat predictable card grid.',
  'R2 Spacing system — gaps are multiples of the 4/8px scale; consistent rhythm; aligned edges. FAIL: arbitrary margins, mismatched gutters, cramped/floaty whitespace.',
  'R3 Type scale — ≤3 deliberate sizes per view. FAIL: single undifferentiated 14-16px size everywhere; default Inter/Roboto with no scale intent.',
  'R4 Color discipline — consumes tokens; one accent; red reserved for error/blocked. FAIL: rogue hex, indigo #6366f1, generic gray-on-gray, >1 competing accent.',
  'R5 No-slop-tells — distinctive, intentional surface. FAIL: purple→blue gradient on white (#1 AI slop tell), flat pure-white/gray bg, emoji-as-icons, timid evenly-distributed palette.',
  'R6 State coverage — empty / loading (skeleton, not bare spinner) / error / hover / focus / disabled all designed. FAIL: missing empty state, bare spinner, no hover/focus, dead disabled.',
  'R7 Responsive — no horizontal scroll at 360px; nav adapts; tap targets ≥44px. FAIL: overflow at 360, crushed desktop layout, sub-12px text on mobile.',
  'R8 Accessibility floor (HARD — any fail ⇒ verdict fail) — WCAG AA contrast (4.5:1); visible focus rings; labels on inputs; aria on icon-only buttons. FAIL: low-contrast gray text, no focus ring, icon buttons w/o aria.',
  'R9 Token/primitive conformance (BINARY — any hit ⇒ verdict fail) — renders via the project design-system primitives & tokens. Fed by scripts/ui-conformance.sh; any static hit ⇒ automatic R9 fail, no screenshot needed.',
]

/**
 * The full UI/UX rubric block injected into the reviewer prompt.
 *
 * Returns '' (no injection) when:
 *   - the gate is `off` (dormant — reviewer prompt unchanged vs Wave A), OR
 *   - the objective is not a UI objective (no UI overhead on backend/research work).
 *
 * Otherwise injects: the per-project design context, the mandatory iteration-1
 * criteria (a `static` ui-conformance + a `browser` ui-rubric), the 9-point rubric,
 * the screenshot/static-lint task, and the MODE-SPECIFIC verdict instructions:
 *   - advisory: grade + write findings, but the verdict IGNORES the rubric (no bounce).
 *   - soft:     rubric affects the verdict ONLY for delegator→worker tasks; else advisory.
 *   - hard:     rubric affects the verdict for all UI objectives.
 */
export function buildVisionRubricBlock(
  objective: Objective,
  mode: UiGateMode,
  isDelegatorWorker: boolean,
  // The files this PR/worker actually touched (session_intel). When non-empty and
  // frontend-free, the injected ds-* vision rubric is SKIPPED — a backend-only PR has
  // no screen to render against (obj 1453). Omitted/empty ⇒ unchanged behavior (the
  // project-level isUiObjective signal governs), so the full rubric still injects on
  // genuine UI work and whenever the file list is unknown.
  filesTouched?: string[] | null,
): string {
  if (mode === 'off') return ''
  if (!isUiObjective(objective)) return ''
  if (isBackendOnlyChange(filesTouched)) return ''

  // Whether rubric results are allowed to change the pass/fail verdict.
  const enforced = mode === 'hard' || (mode === 'soft' && isDelegatorWorker)

  const verdictRule = enforced
    ? [
        'VERDICT IMPACT — ENFORCED (this objective is in scope for the UI gate):',
        'Fold the rubric into your <verdict> using this math:',
        '  - any R8 (a11y) fail            → verdict = fail (hard floor)',
        '  - any R9 (conformance) hit      → verdict = fail (binary)',
        '  - any FAIL among R1–R7          → verdict = fail',
        '  - ≥3 WARN among R1–R7           → verdict = fail (slop accumulates)',
        '  - otherwise the rubric passes; decide pass/fail on the other criteria as usual.',
        'A rubric-driven fail rides the EXISTING bounce loop (cap 3) — list the failing',
        'dimensions with screenshot-cited evidence in <findings> so the worker can fix them.',
      ].join('\n')
    : [
        `VERDICT IMPACT — ADVISORY${mode === 'soft' ? ' (soft mode, but this objective is not a delegator→worker task)' : ''}:`,
        'Grade the rubric and WRITE the findings, but DO NOT let any rubric dimension change',
        'your <verdict>. Compute pass/fail EXACTLY as you would without this rubric — i.e. from',
        'the functional/non-UI criteria only. The UI findings are FYI for tuning; they never bounce',
        'the worker in this mode. Record them in <findings> under a "## UI Rubric (advisory)" heading.',
      ].join('\n')

  return [
    `=== MANDATORY UI/UX RUBRIC (UI_GATE_MODE=${mode}; this deliverable touches frontend) ===`,
    '',
    buildReviewerDesignContextBlock(objective),
    '',
    'Your iteration-1 acceptance criteria MUST include these two, verbatim type/method:',
    '  { id:"ui-conformance", type:"visual", method:"static",',
    '    criterion:"Zero static conformance hits (run scripts/ui-conformance.sh on the diff)" }',
    '  { id:"ui-rubric", type:"visual", method:"browser",',
    '    criterion:"Passes the 9-point UI rubric at 360/768/1440px; R8 a11y and R9 conformance are pass/fail; ≥3 warns = fail" }',
    '',
    'For method:"static" — run, from the repo root:',
    '    bash scripts/ui-conformance.sh <changed-files>',
    '  Paste the FULL output into <findings>. Any hit ⇒ ui-conformance FAILS (and R9 fails).',
    '',
    'For method:"browser" — use the Playwright MCP tools (browser_navigate, browser_resize,',
    '  browser_take_screenshot). For EACH primary view the worker touched, capture a screenshot',
    '  at 360px, 768px, and 1440px width. Grade R1–R9 below pass/warn/fail with a one-line evidence',
    '  note per dimension citing the screenshot. Save screenshots to ABSOLUTE paths only (e.g.',
    '  under /tmp/ui-review-<objective>/) — never a "~/"-relative path (your $HOME is a per-account',
    '  scratch home, NOT /home/mike). Return those absolute paths in screenshot_paths.',
    '',
    'THE 9-POINT RUBRIC:',
    ...VISION_RUBRIC.map((r) => `  ${r}`),
    '',
    verdictRule,
  ].join('\n')
}

/** Canonical filesystem roots injected into every spawned session's env so that
 *  `~`-relative paths can be replaced with absolute ones, and so prompts/scripts can
 *  reference the real /home/mike vault & projects regardless of the session's own
 *  per-account `$HOME`. See the `~`-home false-negative fix (obj 532 / 553). */
export function canonicalRootEnv(): Record<string, string> {
  return {
    PROJECTS_DIR,
    SECOND_BRAIN_DIR,
    AI_WORKSPACE_DIR,
    VAULT_ROOT,
    MIKE_HOME: HOME_DIR,
  }
}
