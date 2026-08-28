import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  buildVisionRubricBlock,
  buildReviewerDesignContextBlock,
  getUiGateMode,
  isUiObjective,
  isUiInjectionActive,
  buildDesignContextBlock,
  getEffectiveGateMode,
  clearGateConfigCache,
  canonicalRootEnv,
  isBackendOnlyChange,
  isVisualCriterion,
  rubricForChangedFiles,
  buildDsConformanceCriteria,
  BACKEND_CORRECTNESS_CRITERION,
  repoHasE2eSuite,
  criteriaHaveQaBar,
  buildQaConformanceCriteria,
} from './design-context.js'
import type { Objective } from '@command-center/shared'

// Minimal Objective factory — only the fields the UI-gate path reads.
function obj(partial: Partial<Objective>): Objective {
  return {
    id: 1,
    title: 't',
    type: 'task',
    workspace: 'personal',
    project: null,
    acceptance_criteria: null,
    ...partial,
  } as Objective
}

// A registered frontend repo (present in /home/operator/projects/.design-registry.json).
const uiObjective = obj({ project: 'example-project-platform' })
// A non-UI objective: unregistered project, no visual/browser criterion.
const backendObjective = obj({ project: 'some-backend-svc', acceptance_criteria: [] })

describe('buildVisionRubricBlock — dormancy (the dominant safety property)', () => {
  it("returns '' when gate is off, even for a UI objective", () => {
    expect(buildVisionRubricBlock(uiObjective, 'off', false)).toBe('')
    expect(buildVisionRubricBlock(uiObjective, 'off', true)).toBe('')
  })

  it("returns '' for a non-UI objective at every active mode (no overhead on backend work)", () => {
    for (const mode of ['advisory', 'soft', 'hard'] as const) {
      expect(buildVisionRubricBlock(backendObjective, mode, false)).toBe('')
    }
  })
})

describe('buildVisionRubricBlock — active modes inject the rubric', () => {
  it('advisory: injects the 9-point rubric but the verdict IGNORES it', () => {
    const block = buildVisionRubricBlock(uiObjective, 'advisory', true)
    expect(block).toContain('MANDATORY UI/UX RUBRIC')
    expect(block).toContain('R8 Accessibility floor')
    expect(block).toContain('R9 Token/primitive conformance')
    expect(block).toContain('360px, 768px, and 1440px')
    expect(block).toContain('scripts/ui-conformance.sh')
    expect(block).toContain('VERDICT IMPACT — ADVISORY')
    expect(block).not.toContain('VERDICT IMPACT — ENFORCED')
  })

  it('soft: ENFORCES for a delegator→worker task, ADVISORY otherwise', () => {
    expect(buildVisionRubricBlock(uiObjective, 'soft', true)).toContain('VERDICT IMPACT — ENFORCED')
    const nonWorker = buildVisionRubricBlock(uiObjective, 'soft', false)
    expect(nonWorker).toContain('VERDICT IMPACT — ADVISORY')
    expect(nonWorker).toContain('not a delegator→worker task')
  })

  it('hard: ENFORCES for any UI objective regardless of delegator-worker status', () => {
    expect(buildVisionRubricBlock(uiObjective, 'hard', false)).toContain('VERDICT IMPACT — ENFORCED')
    expect(buildVisionRubricBlock(uiObjective, 'hard', true)).toContain('VERDICT IMPACT — ENFORCED')
  })

  it('fires for an explicit visual/browser criterion even on an unregistered repo', () => {
    const adhoc = obj({
      project: 'random-repo',
      acceptance_criteria: [
        { id: 'x', criterion: 'looks right', type: 'visual', method: 'browser' },
      ],
    })
    expect(isUiObjective(adhoc)).toBe(true)
    expect(buildVisionRubricBlock(adhoc, 'advisory', false)).toContain('MANDATORY UI/UX RUBRIC')
  })

  it('tolerates acceptance_criteria as a raw JSON string (spawn path passes the unmapped DB row)', () => {
    // Raw DB rows store acceptance_criteria as a JSON string; only mapObjective()
    // parses it. The spawn path passes the raw row, so isUiObjective must not throw
    // (regression: obj-1114 spawn crashed with "(…).some is not a function").
    const rawRow = obj({
      project: 'random-repo',
      acceptance_criteria: JSON.stringify([
        { id: 'x', criterion: 'looks right', type: 'visual', method: 'browser' },
      ]) as unknown as Objective['acceptance_criteria'],
    })
    expect(() => isUiObjective(rawRow)).not.toThrow()
    expect(isUiObjective(rawRow)).toBe(true)

    const rawBackend = obj({
      project: 'some-backend-svc',
      acceptance_criteria: JSON.stringify([
        { id: 'a', criterion: 'returns 200', type: 'functional', method: 'api' },
      ]) as unknown as Objective['acceptance_criteria'],
    })
    expect(isUiObjective(rawBackend)).toBe(false)
  })
})

describe('buildReviewerDesignContextBlock — absolute paths (the ~-home fix)', () => {
  it('resolves the token source to an absolute /home/mike path, never ~-relative', () => {
    const block = buildReviewerDesignContextBlock(uiObjective)
    expect(block).toContain('/home/operator/projects/example-project-platform/src/design-system/tokens.css')
    expect(block).not.toMatch(/~\//)
  })
})

describe('getUiGateMode — defaults to off (typo-safe)', () => {
  it('returns off when unset', () => {
    delete process.env.UI_GATE_MODE
    expect(getUiGateMode()).toBe('off')
  })
  it('returns off for an unrecognized value', () => {
    process.env.UI_GATE_MODE = 'enabled'
    expect(getUiGateMode()).toBe('off')
    delete process.env.UI_GATE_MODE
  })
  it('parses the valid phased values', () => {
    for (const m of ['advisory', 'soft', 'hard']) {
      process.env.UI_GATE_MODE = m
      expect(getUiGateMode()).toBe(m)
    }
    delete process.env.UI_GATE_MODE
  })
})

describe('canonicalRootEnv — injects the real /home/mike roots', () => {
  it('exposes the vault + projects roots so sessions can avoid ~ expansion', () => {
    const env = canonicalRootEnv()
    expect(env.SECOND_BRAIN_DIR).toBe('/home/operator/second-brain')
    expect(env.PROJECTS_DIR).toBe('/home/operator/projects')
    expect(env.MIKE_HOME).toBe('/home/mike')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// isUiInjectionActive — the FILE-backed, per-objective spawn-injection master switch
// (obj 1117). Unifies the injection/auto-append halves onto the same `.ui-gate.json`
// control-plane the reviewer already uses, so a no-restart file write turns spawn-time
// conditioning on for every UI worker on the allowlisted platforms. These tests point
// UI_GATE_FILE at a scratch file so they NEVER touch the real /home/operator/projects/.ui-gate.json.
// ─────────────────────────────────────────────────────────────────────────────

const INJ_GATE_FILE = path.join(os.tmpdir(), `ui-gate-injection-test-${process.pid}.json`)
// The four registered frontend platforms obj 1117 activates (all present in .design-registry.json).
const PLATFORMS = ['command-center-infra', 'example-project-platform', 'example-platform', 'example3-platform']

function writeInjGate(contents: string) {
  fs.writeFileSync(INJ_GATE_FILE, contents)
}
function removeInjGate() {
  try { fs.unlinkSync(INJ_GATE_FILE) } catch { /* already gone */ }
}
function uiObj(project: string): Objective {
  return obj({ project })
}
// The exact two-condition gate the spawn path (prompt-builder buildPrompt) applies before
// appending the design-context block. Mirroring it here proves the spawn-prompt delta.
function injectionFires(o: Objective): boolean {
  return isUiInjectionActive(o) && isUiObjective(o)
}

describe('isUiInjectionActive — spawn-injection control-plane (obj 1117)', () => {
  beforeEach(() => {
    delete process.env.UI_GATE_MODE
    process.env.UI_GATE_FILE = INJ_GATE_FILE
    removeInjGate()
    clearGateConfigCache()
  })
  afterEach(() => {
    delete process.env.UI_GATE_MODE
    delete process.env.UI_GATE_FILE
    removeInjGate()
    clearGateConfigCache()
  })

  // (a) Dormancy: file absent + env unset ⇒ NO injection ⇒ byte-identical spawn prompt.
  it('(a) dormant when off: no file + no env ⇒ no injection for any platform (byte-identical)', () => {
    for (const p of PLATFORMS) {
      const o = uiObj(p)
      expect(isUiInjectionActive(o)).toBe(false)
      expect(injectionFires(o)).toBe(false)
    }
    // And explicit mode:off in the file is equally dormant even with platforms listed.
    writeInjGate(JSON.stringify({ mode: 'off', platforms: PLATFORMS }))
    clearGateConfigCache()
    for (const p of PLATFORMS) expect(injectionFires(uiObj(p))).toBe(false)
  })

  // (b) Injection PRESENT for a UI objective on each of the four platforms under advisory,
  //     both GLOBAL (empty allowlist) and platform-ALLOWLISTED config.
  it('(b) advisory GLOBAL ⇒ injection fires for a UI objective on all four platforms', () => {
    writeInjGate(JSON.stringify({ mode: 'advisory' }))
    clearGateConfigCache()
    for (const p of PLATFORMS) {
      const o = uiObj(p)
      expect(getEffectiveGateMode(p)).toBe('advisory')
      expect(injectionFires(o)).toBe(true)
      // The block that actually gets appended is non-empty and carries the guardrails.
      const block = buildDesignContextBlock(o)
      expect(block.length).toBeGreaterThan(0)
      expect(block.join('\n')).toContain('DIALED UI IS A REQUIREMENT')
    }
  })

  it('(b) advisory with the four-platform allowlist ⇒ injection fires for each listed platform', () => {
    writeInjGate(JSON.stringify({ mode: 'advisory', platforms: PLATFORMS }))
    clearGateConfigCache()
    for (const p of PLATFORMS) {
      expect(injectionFires(uiObj(p))).toBe(true)
    }
  })

  // (c) A platform EXCLUDED from a non-empty allowlist gets NO injection (byte-identical).
  it('(c) a platform outside a non-empty allowlist ⇒ no injection (byte-identical)', () => {
    // Allowlist only example-project; the other three (and an unrelated repo) stay dormant.
    writeInjGate(JSON.stringify({ mode: 'advisory', platforms: ['example-project-platform'] }))
    clearGateConfigCache()
    expect(injectionFires(uiObj('example-project-platform'))).toBe(true)
    for (const p of ['command-center-infra', 'example-platform', 'example3-platform', 'example-dashboard']) {
      expect(isUiInjectionActive(uiObj(p))).toBe(false)
      expect(injectionFires(uiObj(p))).toBe(false)
    }
  })

  // (d) A non-UI / backend objective gets NO injection in ANY mode — even when the gate
  //     resolves ACTIVE for its project (global advisory), the isUiObjective half blocks it.
  it('(d) a non-UI/backend objective gets NO injection in any active mode', () => {
    const backend = obj({ project: 'some-backend-svc', acceptance_criteria: [] })
    for (const cfg of [{ mode: 'advisory' }, { mode: 'soft' }, { mode: 'hard' }]) {
      writeInjGate(JSON.stringify(cfg))
      clearGateConfigCache()
      // Gate resolves active globally for this project…
      expect(isUiInjectionActive(backend)).toBe(true)
      // …but it is not a UI objective, so the combined spawn gate does NOT fire.
      expect(isUiObjective(backend)).toBe(false)
      expect(injectionFires(backend)).toBe(false)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// obj 1453 — backend-only PRs must NOT be graded against the UI ds-* rubric.
// The auto-append keys the ds-* block on the PROJECT; at review time we down-scope
// it to the per-CHANGED-FILES signal so a backend-only PR has a reachable green path.
// ─────────────────────────────────────────────────────────────────────────────
describe('isBackendOnlyChange (obj 1453)', () => {
  it('is true only when a NON-EMPTY file list touches no frontend file', () => {
    expect(isBackendOnlyChange(['app/server/src/services/state-poller.ts'])).toBe(true)
    expect(isBackendOnlyChange(['scripts/quick-deploy.sh', 'app/server/src/index.ts'])).toBe(true)
  })
  it('is false for a frontend file (extension or directory heuristic)', () => {
    expect(isBackendOnlyChange(['app/client/src/components/KanbanBoard.tsx'])).toBe(false)
    expect(isBackendOnlyChange(['app/server/src/x.ts', 'app/client/src/styles.css'])).toBe(false)
  })
  it('is false (SAFE DEFAULT) when the file list is empty or unknown', () => {
    // Empty/unknown ⇒ we must NOT strip the visual bar — preserve the full ds-* rubric.
    expect(isBackendOnlyChange([])).toBe(false)
    expect(isBackendOnlyChange(null)).toBe(false)
    expect(isBackendOnlyChange(undefined)).toBe(false)
  })
})

describe('isVisualCriterion (obj 1453)', () => {
  it('flags ds-* ids, type:visual, and method:browser/static', () => {
    expect(isVisualCriterion({ id: 'ds-a11y-contrast', type: 'functional', method: 'browser' })).toBe(true)
    expect(isVisualCriterion({ id: 'x', type: 'visual', method: 'doc' })).toBe(true)
    expect(isVisualCriterion({ id: 'x', type: 'functional', method: 'browser' })).toBe(true)
    expect(isVisualCriterion({ id: 'x', type: 'functional', method: 'static' })).toBe(true)
  })
  it('does NOT flag a plain functional/doc or api criterion', () => {
    expect(isVisualCriterion({ id: 'login', type: 'functional', method: 'doc' })).toBe(false)
    expect(isVisualCriterion({ id: 'endpoint', type: 'data', method: 'api' })).toBe(false)
    expect(isVisualCriterion(null)).toBe(false)
  })
})

describe('rubricForChangedFiles (obj 1453)', () => {
  const dsCriteria = buildDsConformanceCriteria('command-center-infra')
  const fnCriterion = { id: 'scheduler-fix', criterion: 'queue drains', type: 'functional' as const, method: 'doc' as const }

  it('detect-no-ui: strips every visual/ds-* criterion for a backend-only PR', () => {
    const mixed = [fnCriterion, ...dsCriteria]
    const { criteria, stripped } = rubricForChangedFiles(mixed, ['app/server/src/services/state-poller.ts'])
    expect(stripped).toBe(true)
    expect(criteria).toEqual([fnCriterion])
    expect(criteria.some((c) => c.id?.startsWith('ds-'))).toBe(false)
  })

  it('backend-rubric: substitutes a reachable correctness bar when stripping empties the rubric', () => {
    // The exact obj-1284 case: the locked rubric is ONLY the 5 ds-* criteria.
    const { criteria, stripped } = rubricForChangedFiles(dsCriteria, ['app/server/src/index.ts'])
    expect(stripped).toBe(true)
    expect(criteria).toEqual([BACKEND_CORRECTNESS_CRITERION])
    expect(criteria[0].method).toBe('doc') // graded on correctness, not a screenshot
  })

  it('no-regression-ui: a frontend PR keeps the FULL ds-* rubric untouched', () => {
    const mixed = [fnCriterion, ...dsCriteria]
    const { criteria, stripped } = rubricForChangedFiles(mixed, ['app/client/src/components/Card.tsx'])
    expect(stripped).toBe(false)
    expect(criteria).toEqual(mixed)
  })

  it('safe default: unknown/empty file list keeps the FULL rubric (no strip)', () => {
    const mixed = [fnCriterion, ...dsCriteria]
    expect(rubricForChangedFiles(mixed, []).stripped).toBe(false)
    expect(rubricForChangedFiles(mixed, null).criteria).toEqual(mixed)
  })
})

describe('buildVisionRubricBlock — backend-only skip (obj 1453)', () => {
  // command-center-infra IS a registered frontend repo ⇒ isUiObjective true.
  const ccObj = obj({ project: 'command-center-infra' })

  it("returns '' for a registered UI repo when the PR touches no UI file", () => {
    expect(buildVisionRubricBlock(ccObj, 'hard', false, ['app/server/src/services/state-poller.ts'])).toBe('')
  })
  it('still injects the rubric when the PR touches a frontend file', () => {
    const out = buildVisionRubricBlock(ccObj, 'hard', false, ['app/client/src/components/Card.tsx'])
    expect(out).toContain('MANDATORY UI/UX RUBRIC')
  })
  it('still injects (no regression) when the file list is empty/unknown', () => {
    expect(buildVisionRubricBlock(ccObj, 'hard', false, [])).toContain('MANDATORY UI/UX RUBRIC')
    expect(buildVisionRubricBlock(ccObj, 'hard', false)).toContain('MANDATORY UI/UX RUBRIC')
  })
})

describe('production-worthy QA gate (obj 2390)', () => {
  it('repoHasE2eSuite: true for repos with a Playwright/e2e suite, false otherwise', () => {
    expect(repoHasE2eSuite('example-platform')).toBe(true)
    expect(repoHasE2eSuite('example3-platform')).toBe(true)
    // CC has Vitest only (no Playwright e2e) — must NOT be gated
    expect(repoHasE2eSuite('command-center-infra')).toBe(false)
    expect(repoHasE2eSuite('example-project-platform')).toBe(false)
    expect(repoHasE2eSuite(null)).toBe(false)
    expect(repoHasE2eSuite(undefined)).toBe(false)
  })

  it('criteriaHaveQaBar: detects a qa-* id, ignores ds-*/functional/empty', () => {
    expect(criteriaHaveQaBar([{ id: 'qa-smoke' }])).toBe(true)
    expect(criteriaHaveQaBar([{ id: 'ds-tokens-only', method: 'static' }])).toBe(false)
    expect(criteriaHaveQaBar([{ id: 'some-functional', method: 'api' }])).toBe(false)
    expect(criteriaHaveQaBar([])).toBe(false)
    expect(criteriaHaveQaBar(null)).toBe(false)
  })

  it('buildQaConformanceCriteria: exactly the 3 contract classes (smoke + role-matrix + error-state)', () => {
    const c = buildQaConformanceCriteria()
    expect(c.map((x) => x.id)).toEqual(['qa-smoke', 'qa-role-matrix', 'qa-error-state'])
    // every criterion is gradable in a browser and concrete
    for (const x of c) {
      expect(x.method).toBe('browser')
      expect(x.criterion.length).toBeGreaterThan(20)
    }
  })
})
