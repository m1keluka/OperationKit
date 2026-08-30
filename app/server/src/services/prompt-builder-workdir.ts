/**
 * Prompt-builder workdir, agent maps, and on-behalf user resolution —
 * extracted from prompt-builder.ts (behavior frozen).
 *
 * No prompt assembly. buildPrompt stays on the prompt-builder.ts facade.
 */
import fs from 'fs'
import path from 'path'
import type { Objective, AgentContext } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import {
  AGENTS_DIR,
  WORKSPACES_JSON,
  PROJECTS_DIR,
  AI_WORKSPACE_DIR,
  HOME_DIR,
} from '../config.js'

// ── On-behalf-of user resolution ──

export interface OnBehalfUser {
  username: string
  role: 'admin' | 'member'
  workspaces: string[]
  profilePathAbs: string | null
}

/**
 * Look up the human the session is working on behalf of. Order of preference:
 *  1. assigned_user_id  — explicit ownership
 *  2. created_by        — fallback to whoever filed the objective
 * Returns null when neither field is set (legacy rows or pre-multi-user).
 *
 * Also resolves an optional per-user profile file at
 *   ~/ai-workspace/users/<username>/profile.md
 * which sessions read for tone/preference/access defaults. The absolute path
 * is included so the prompt can reference it (the spawn shell HOME is the
 * ccuser dir, not /home/operator, so ~/ in instructions won't resolve correctly).
 */
export function resolveOnBehalfUser(objective: Objective): OnBehalfUser | null {
  const userId = objective.assigned_user_id ?? objective.created_by
  if (!userId) return null
  try {
    const db = getDb()
    const row = db
      .prepare("SELECT username, role FROM users WHERE id = ?")
      .get(userId) as { username: string; role: 'admin' | 'member' } | undefined
    if (!row) return null
    const wsRows = db
      .prepare("SELECT workspace FROM user_workspaces WHERE user_id = ?")
      .all(userId) as { workspace: string }[]
    const profileAbs = `/home/operator/ai-workspace/users/${row.username}/profile.md`
    return {
      username: row.username,
      role: row.role,
      workspaces: wsRows.map(r => r.workspace),
      profilePathAbs: fs.existsSync(profileAbs) ? profileAbs : null,
    }
  } catch (err) {
    console.warn(`[session-manager] resolveOnBehalfUser(${userId}) failed:`, (err as Error).message)
    return null
  }
}

// ── Constants ──

export const MAX_OBJECTIVE_HISTORY_CHARS = 20000
export const OBJ_COMPACTION_THRESHOLD = 30
export const OBJ_COMPACTION_TAIL_TURNS = 15
export const COMPACTION_SESSION_SENTINEL = 'compaction'

export type ObjectiveTurn = { role: 'user' | 'assistant'; text: string }

// agent_context → persona filename (no `.md`). Identity for every persona file
// in `~/ai-workspace/agents/`. All 17 are mapped (obj-2387, D7) so every
// assignable agent inlines its real instructions — no broken/empty reads.
export const AGENT_MAP: Record<AgentContext, string> = {
  cto: 'cto',
  cmo: 'cmo',
  coo: 'coo',
  cfo: 'cfo',
  general: 'general',
  designer: 'designer',
  hr: 'hr',
  'general-counsel': 'general-counsel',
  'chief-of-staff': 'chief-of-staff',
  assistant: 'assistant',
  'campaign-auditor': 'campaign-auditor',
  'campaign-launcher': 'campaign-launcher',
  'data-sourcing': 'data-sourcing',
  'fundraising-advisor': 'fundraising-advisor',
  'example2-campaign-ops': 'example2-campaign-ops',
  'ma-advisor': 'ma-advisor',
  rolodex: 'rolodex',
}

// agent_context → default working directory. cto is the only code-shipping role
// (→ the projects checkout); `general` runs from $HOME; every other persona is
// an ops/strategy role that runs from the ai-workspace. Project-linked
// objectives override this entirely via resolveWorkdir() (the worktree path).
export const WORKDIR_MAP: Record<AgentContext, string> = {
  cto: PROJECTS_DIR,
  cmo: AI_WORKSPACE_DIR,
  coo: AI_WORKSPACE_DIR,
  cfo: AI_WORKSPACE_DIR,
  general: HOME_DIR,
  designer: AI_WORKSPACE_DIR,
  hr: AI_WORKSPACE_DIR,
  'general-counsel': AI_WORKSPACE_DIR,
  'chief-of-staff': AI_WORKSPACE_DIR,
  assistant: AI_WORKSPACE_DIR,
  'campaign-auditor': AI_WORKSPACE_DIR,
  'campaign-launcher': AI_WORKSPACE_DIR,
  'data-sourcing': AI_WORKSPACE_DIR,
  'fundraising-advisor': AI_WORKSPACE_DIR,
  'example2-campaign-ops': AI_WORKSPACE_DIR,
  'ma-advisor': AI_WORKSPACE_DIR,
  rolodex: AI_WORKSPACE_DIR,
}

// ── Functions ──

/** Read agent instructions file server-side to inline into prompts (saves setup tool calls) */
export function readAgentInstructions(agentName: string): string | null {
  try {
    const agentPath = path.join(AGENTS_DIR, `${agentName}.md`)
    const content = fs.readFileSync(agentPath, 'utf-8')
    // Truncate to ~4000 chars to keep prompt reasonable
    return content.length > 4000 ? content.slice(0, 4000) + '\n\n[... truncated — read full file at ~/ai-workspace/agents/' + agentName + '.md]' : content
  } catch {
    return null
  }
}

// Load workspaces config for project path resolution
export function loadWorkspacesConfig(): Record<string, { projects: Array<{ name: string; path: string }> }> | null {
  try {
    const content = fs.readFileSync(WORKSPACES_JSON, 'utf-8')
    return JSON.parse(content).workspaces
  } catch {
    return null
  }
}

/**
 * Resolve the directory a session for `objective` should run in.
 *
 * For a project-linked objective the directory MUST be the project's real
 * checkout, because every project-scoped session is isolated into a git worktree
 * cut from it. Two safety invariants (obj 1451):
 *
 *  1. Search EVERY workspace, not just `objective.workspace`. A project is
 *     registered under one workspace (e.g. command-center-infra under
 *     'personal'), but objectives can be tagged with a different workspace
 *     (e.g. 'example'). The old code only looked in `workspaces[objective.workspace]`,
 *     so an example-tagged command-center-infra objective missed the lookup and fell
 *     through to the bare projects root.
 *
 *  2. FAIL CLOSED for a project-linked objective that resolves to nothing.
 *     Never return the bare `PROJECTS_DIR` root (the WORKDIR_MAP['cto'] fallback):
 *     that root is not a git repo, so `ensureWorktree` fails and the session
 *     spawns UNGUARDED in the live tree — the 2026-04-25 crash-loop class. We
 *     throw a descriptive error instead so the spawn aborts before any status
 *     mutation and the operator sees a blocked card, not a silent unguarded run.
 *
 * `deps` is injectable purely for hermetic unit testing; production passes none.
 */
export function resolveWorkdir(
  objective: Objective,
  deps: {
    workspaces?: Record<string, { projects: Array<{ name: string; path: string }> }> | null
    existsSync?: (p: string) => boolean
  } = {},
): string {
  const existsSync = deps.existsSync ?? fs.existsSync
  // If objective has a linked project, resolve its path from workspaces.json.
  if (objective.project) {
    const workspaces =
      deps.workspaces !== undefined ? deps.workspaces : loadWorkspacesConfig()
    if (workspaces) {
      // Search the objective's OWN workspace first (preserves prior behaviour
      // when the project lives there), then EVERY other workspace.
      const ordered = [
        workspaces[objective.workspace],
        ...Object.entries(workspaces)
          .filter(([name]) => name !== objective.workspace)
          .map(([, ws]) => ws),
      ].filter((ws): ws is { projects: Array<{ name: string; path: string }> } => !!ws)
      for (const ws of ordered) {
        const proj = ws.projects?.find(p => p.name === objective.project)
        if (proj) {
          const resolved = proj.path.replace('~', HOME_DIR).replace(/\/+$/, '')
          if (existsSync(resolved)) return resolved
        }
      }
    }
    // Project-linked but unresolvable to an existing checkout → FAIL CLOSED.
    // Do NOT fall back to the bare projects root, which would spawn an unguarded
    // session in the live tree.
    throw new Error(
      `resolveWorkdir: objective ${objective.id} is linked to project "${objective.project}" but no workspace in workspaces.json maps it to an existing checkout. Refusing to fall back to the bare projects root "${PROJECTS_DIR}" — that would spawn an UNGUARDED session in the live checkout (obj 1451 fail-closed). Register "${objective.project}" under a workspace.`,
    )
  }
  // Non-project objective → agent-based workdir (unchanged).
  return WORKDIR_MAP[objective.agent_context] || HOME_DIR
}

