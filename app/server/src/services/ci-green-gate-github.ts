/**
 * CI-green gate GitHub IO (ruleset + PR rollup) —
 * extracted from ci-green-gate.ts (behavior frozen).
 *
 * Pure decision lives in ci-green-gate-decide.ts; runCompletionGate in
 * ci-green-gate-run.ts.
 */
import { execFile } from 'child_process'
import {
  type ExecFn,
  type RequiredChecks,
  type RollupEntry,
} from './ci-green-gate-decide.js'

// ── IO: GitHub ──────────────────────────────────────────────────────────────────

/** Mirrors state-poller's ghExecEnv: the server's gh auth lives in /etc/gh. */
export function ghExecEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, GH_CONFIG_DIR: base.GH_CONFIG_DIR || '/etc/gh' }
}

export const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 20000, maxBuffer: 8 * 1024 * 1024, env: ghExecEnv() }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout).trim())
    })
  })

interface RulesetRule {
  type?: string
  parameters?: {
    required_status_checks?: { context?: string }[]
  }
}

/** 5-minute memo: a ruleset changes on the order of never, and a sweep must not fan out. */
const requiredCache = new Map<string, { at: number; value: RequiredChecks }>()
const REQUIRED_CACHE_MS = 5 * 60 * 1000

export function clearRequiredChecksCache(): void {
  requiredCache.clear()
}

/**
 * Read the REQUIRED check contexts for `repo`'s `branch` from the repo itself.
 *
 * Primary: `GET /repos/{o}/{r}/rules/branches/{branch}` — the *evaluated* rules for that
 * branch. This is the right endpoint: it reflects whichever ruleset actually applies,
 * needs no admin scope, and returns `[]` (not 404) for an unprotected branch.
 * Fallback: classic branch protection, for repos still on the old mechanism.
 *
 * Returns source `unknown` (never an empty required set) when both fail, so the caller
 * can tell "no required checks" apart from "I could not find out".
 */
export async function fetchRequiredChecks(
  repo: string,
  branch: string,
  exec: ExecFn = defaultExec,
  now: () => number = Date.now,
): Promise<RequiredChecks> {
  const key = `${repo}#${branch}`
  const hit = requiredCache.get(key)
  if (hit && now() - hit.at < REQUIRED_CACHE_MS) return hit.value

  let rulesErr = ''
  try {
    const raw = await exec('gh', ['api', `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`])
    const rules = JSON.parse(raw) as RulesetRule[]
    if (Array.isArray(rules)) {
      const contexts: string[] = []
      for (const r of rules) {
        if (r.type !== 'required_status_checks') continue
        for (const c of r.parameters?.required_status_checks ?? []) {
          if (c.context) contexts.push(c.context)
        }
      }
      const value: RequiredChecks = {
        contexts: [...new Set(contexts)],
        source: contexts.length ? 'ruleset' : 'none',
      }
      // An empty rules array might just mean "rulesets unused here" — try classic
      // protection before concluding nothing is required.
      if (contexts.length > 0) {
        requiredCache.set(key, { at: now(), value })
        return value
      }
    }
  } catch (err) {
    rulesErr = (err as Error).message
  }

  try {
    const raw = await exec('gh', ['api', `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`])
    const prot = JSON.parse(raw) as { required_status_checks?: { contexts?: string[]; checks?: { context?: string }[] } }
    const contexts = [
      ...(prot.required_status_checks?.contexts ?? []),
      ...(prot.required_status_checks?.checks ?? []).map(c => c.context).filter((c): c is string => !!c),
    ]
    const value: RequiredChecks = {
      contexts: [...new Set(contexts)],
      source: contexts.length ? 'branch-protection' : 'none',
    }
    requiredCache.set(key, { at: now(), value })
    return value
  } catch (err) {
    const protErr = (err as Error).message
    // 404 from BOTH endpoints is a real answer: the branch is simply unprotected.
    if (rulesErr === '' || (/404|Not Found/i.test(rulesErr) && /404|Not Found/i.test(protErr))) {
      const value: RequiredChecks = { contexts: [], source: 'none' }
      requiredCache.set(key, { at: now(), value })
      return value
    }
    return { contexts: [], source: 'unknown', error: `rules: ${rulesErr}; protection: ${protErr}` }
  }
}

export interface PrCheckState {
  number: number
  url: string
  headSha: string
  baseRef: string
  rollup: RollupEntry[] | null
}

export async function fetchPrCheckState(
  repo: string,
  prNumber: number,
  exec: ExecFn = defaultExec,
): Promise<PrCheckState> {
  const raw = await exec('gh', [
    'pr', 'view', String(prNumber), '--repo', repo,
    '--json', 'number,url,headRefOid,baseRefName,statusCheckRollup,state',
  ])
  const j = JSON.parse(raw) as {
    number: number; url: string; headRefOid: string; baseRefName: string
    statusCheckRollup?: RollupEntry[] | null; state?: string
  }
  return {
    number: j.number,
    url: j.url,
    headSha: j.headRefOid,
    baseRef: j.baseRefName,
    rollup: j.statusCheckRollup ?? null,
  }
}

