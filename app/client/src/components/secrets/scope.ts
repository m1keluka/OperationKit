/**
 * Secrets scope helpers — extracted from SecretsPage.tsx (behavior frozen).
 *
 * TERMINOLOGY: Mike thinks of workspaces as ORGANIZATIONS, so this UI *labels*
 * the scopes "Command Center" (global — applies everywhere), "Organization"
 * (workspace), "User" (follows the user into any organization) and
 * "Organization + User" (workspace_user). This is a DISPLAY-LABEL decision only:
 * the wire, the query params, the shared types and the DB columns still say
 * `workspace` / `workspace_user`, and nothing here renames them.
 */
import type { SecretScopeType, SecretSummary } from '@operationkit/shared'

/** Display labels. The wire values stay `global`/`workspace`/`user`/`workspace_user`. */
export const SCOPE_LABELS: Record<SecretScopeType, string> = {
  global: 'Command Center',
  workspace: 'Organization',
  user: 'User',
  workspace_user: 'Organization + User',
}

/**
 * One-line explanation of each scope. Rendered INLINE under every scope
 * selector (page filter and create/edit modal alike) — a `title=` tooltip alone
 * left "Organization" ambiguous (all of Command Center, or one org?), which is
 * exactly the confusion this copy has to kill on sight.
 */
export const SCOPE_HINTS: Record<SecretScopeType, string> = {
  global: 'Command-Center-wide — applies everywhere, in every organization.',
  workspace: 'Applies to everyone working inside this organization.',
  user: 'Follows this user into ANY organization they work in.',
  workspace_user: 'Applies to this user, but only inside this organization.',
}

/**
 * Create-mode copy for the two organization-bearing scopes. Creation is
 * multi-organization (one row per ticked organization), so the singular "this
 * organization" of SCOPE_HINTS would understate it.
 */
export const SCOPE_HINTS_CREATE: Record<SecretScopeType, string> = {
  ...SCOPE_HINTS,
  workspace:
    'Applies only to everyone working inside the selected organization(s) — not everywhere. Pick "Command Center" for a secret that applies everywhere.',
  workspace_user:
    'Applies to the selected user, but only inside the selected organization(s) — not everywhere.',
}

/** Badge chrome, lifted verbatim from ui/Badge so the chip reads identically. */
export const BADGE_BASE =
  'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap'

/** Distinct tone per scope type, straight off the shared ui/Badge tone table —
 *  status/accent tokens only, never a hardcoded hex. */
export const SCOPE_TONES: Record<SecretScopeType, string> = {
  global: 'border-[color:var(--accent-line)] bg-[var(--accent-tint)] text-accent-hover',
  workspace: 'border-status-working/30 bg-status-working/10 text-status-working',
  user: 'border-signal-verify/30 bg-signal-verify/10 text-signal-verify',
  workspace_user: 'border-signal-amber/30 bg-signal-amber/10 text-signal-amber',
}

/** Reading order for the all-scopes list: broadest blast radius first. */
export const SCOPE_ORDER: Record<SecretScopeType, number> = {
  global: 0,
  workspace: 1,
  user: 2,
  workspace_user: 3,
}

export const ALL_SCOPES = 'all' as const
export type ScopeFilter = SecretScopeType | typeof ALL_SCOPES

export const MASK = '••••••'

/** The scope dimensions of a single row/target — the shape every action needs. */
export interface Scope {
  scopeType: SecretScopeType
  workspace: string | null
  userId: number | null
}

/** Narrow a summary down to its own scope (the ONLY scope its actions may use). */
export function scopeOf(s: SecretSummary): Scope {
  return { scopeType: s.scopeType, workspace: s.workspace, userId: s.userId }
}

export function sameScope(a: Scope, b: Scope): boolean {
  return a.scopeType === b.scopeType && (a.workspace || null) === (b.workspace || null) && (a.userId ?? null) === (b.userId ?? null)
}

/** Build the query string for a scope. Empty dimensions are simply omitted. */
export function scopeQuery(scope: Scope): string {
  const p = new URLSearchParams({ scopeType: scope.scopeType })
  if (scope.workspace) p.set('workspace', scope.workspace)
  if (scope.userId != null) p.set('userId', String(scope.userId))
  return p.toString()
}

/** Human sentence for a row's scope, used in confirm copy. */
export function scopeDescription(
  s: SecretSummary,
  orgName: (slug: string | null) => string,
  userName: (id: number | null) => string,
): string {
  switch (s.scopeType) {
    case 'global': return 'the Command Center (applies everywhere)'
    case 'workspace': return `the ${orgName(s.workspace)} organization`
    case 'user': return `the user ${userName(s.userId)}`
    case 'workspace_user': return `${userName(s.userId)} inside ${orgName(s.workspace)}`
  }
}

/** The qualified label rendered inside the scope badge. */
export function scopeBadgeLabel(
  s: SecretSummary,
  orgName: (slug: string | null) => string,
  userName: (id: number | null) => string,
): string {
  switch (s.scopeType) {
    case 'global': return SCOPE_LABELS.global
    case 'workspace': return `${SCOPE_LABELS.workspace} · ${orgName(s.workspace)}`
    case 'user': return `${SCOPE_LABELS.user} · ${userName(s.userId)}`
    case 'workspace_user': return `${SCOPE_LABELS.workspace_user} · ${orgName(s.workspace)} / ${userName(s.userId)}`
  }
}
