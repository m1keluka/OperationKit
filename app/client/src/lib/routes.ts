/**
 * Route constants shared across navigation surfaces (obj 900495, Sprint 4a).
 *
 * One place to change a path that more than one surface links to, so sibling
 * sprints coordinate on a constant instead of a string scattered across files.
 */

/** The System page (formerly "Dashboard"): AI usage, spend, host stats. */
export const SYSTEM_ROUTE = '/system'

/** Old System URLs. Kept as redirects so bookmarks keep working. */
export const LEGACY_SYSTEM_ROUTES = ['/dashboard', '/costs'] as const

/** The one Agents page. Tabs are addressed with `?tab=`. */
export const AGENTS_ROUTE = '/agents'
export const AGENTS_TABS = ['registry', 'board', 'templates'] as const
export type AgentsTab = typeof AGENTS_TABS[number]
export const agentsTabRoute = (tab: AgentsTab) => `${AGENTS_ROUTE}?tab=${tab}`

/** Jobs, and the anchor of its host-cron section (was Settings → Platform). */
export const JOBS_ROUTE = '/jobs'
export const HOST_CRON_ANCHOR = 'host-cron'
export const HOST_CRON_ROUTE = `${JOBS_ROUTE}#${HOST_CRON_ANCHOR}`

/**
 * Where AI accounts (subscription seats) are managed. Sprint 4b (obj 900496)
 * renamed Settings → Seats to Settings → Models; '/settings/seats' now
 * redirects here. Every link (the System page's included) follows this one
 * constant.
 */
export const MODELS_SETTINGS_ROUTE = '/settings/models'

/**
 * Old URLs → their new homes (obj 900495). App.tsx renders exactly this table
 * as `<Navigate replace>` routes, and routes.redirects.test.tsx drives it
 * through a real router, so the two cannot drift.
 */
export const LEGACY_REDIRECTS: ReadonlyArray<{ from: string; to: string }> = [
  { from: '/dashboard', to: SYSTEM_ROUTE },
  { from: '/costs', to: SYSTEM_ROUTE },
  { from: '/agent-templates', to: agentsTabRoute('templates') },
  { from: '/settings/agents', to: agentsTabRoute('registry') },
  { from: '/settings/platform', to: HOST_CRON_ROUTE },
]
