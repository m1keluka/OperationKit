#!/usr/bin/env tsx
/**
 * Review the session-secret migration log and build allowlists — D4 (obj 900540).
 *
 *   docker exec command-center tsx server/src/scripts/secrets-env-allowlist.ts <command>
 *
 * Commands (names only — this tool never reads or prints a secret value):
 *   status                         mode + allowlist size + log size
 *   report [--days 30] [--json]    per agent: non-allowlisted names sessions referenced
 *   list                           the allowlist
 *   allow  --agent SLUG|--skill SLUG KEY [KEY…]     add names ('*' agent = every session)
 *   remove --agent SLUG|--skill SLUG KEY [KEY…]     remove names
 *   apply  [--days 30] [--min-sessions 2] [--yes]   allowlist every name the report
 *                                  suggests, per agent. Dry run without --yes.
 *   mode   migration|enforce       switch (audited). enforce = only allowlisted names
 *                                  reach a session env; the rest via the broker.
 *
 * Every change is written to the append-only secrets audit log (action
 * env_policy, source cli).
 */
import { initDb } from '../db/index.js'
import {
  addAllowlistEntry,
  envUsageReport,
  getSessionEnvMode,
  isSessionEnvMode,
  listAllowlist,
  removeAllowlistEntry,
  setSessionEnvMode,
  type AllowlistSubjectType,
} from '../services/secret-env-policy.js'
import { getDb } from '../db/index.js'
import { readSettingFlag, SESSION_SECRET_ACCESS_FLAG } from '../lib/session-trust.js'

export function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string | true>; rest: string[] } {
  const [cmd = 'status', ...tail] = argv
  const flags: Record<string, string | true> = {}
  const rest: string[] = []
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i]!
    if (a.startsWith('--')) {
      const name = a.slice(2)
      const next = tail[i + 1]
      if (['days', 'min-sessions', 'agent', 'skill'].includes(name) && next !== undefined) {
        flags[name] = next
        i++
      } else flags[name] = true
    } else rest.push(a)
  }
  return { cmd, flags, rest }
}

function subjectOf(flags: Record<string, string | true>): { type: AllowlistSubjectType; subject: string } {
  if (typeof flags.agent === 'string') return { type: 'agent', subject: flags.agent }
  if (typeof flags.skill === 'string') return { type: 'skill', subject: flags.skill }
  throw new Error('give --agent SLUG (or * for every session) or --skill SLUG')
}

/** Runs one command; returns the process exit code. `out` gets every line. */
export function run(argv: string[], out: (s: string) => void = console.log): number {
  const { cmd, flags, rest } = parseArgs(argv)
  const days = Number(flags.days ?? 30)
  switch (cmd) {
    case 'status': {
      const n = (getDb().prepare('SELECT COUNT(*) AS n FROM secret_env_usage').get() as { n: number }).n
      out(`mode: ${getSessionEnvMode()}`)
      out(`allowlist entries: ${listAllowlist().length}`)
      out(`migration log rows: ${n}`)
      out(`broker for non-allowlisted names (session_secret_access): ${readSettingFlag(SESSION_SECRET_ACCESS_FLAG) ? 'on' : 'OFF'}`)
      return 0
    }
    case 'report': {
      const r = envUsageReport({ sinceDays: days, minSessions: Number(flags['min-sessions'] ?? 1) })
      if (flags.json) {
        out(JSON.stringify(r, null, 2))
        return 0
      }
      out(`mode: ${r.mode} — last ${r.sinceDays} days — names referenced by sessions WITHOUT an allowlist entry`)
      if (r.rows.length === 0) out('(nothing logged)')
      let agent = ''
      for (const row of r.rows) {
        if (row.agent !== agent) {
          agent = row.agent
          out(`\nagent ${agent}:`)
        }
        const withheld = row.withheldSessions ? `, withheld in ${row.withheldSessions}` : ''
        out(`  ${row.key.padEnd(32)} ${row.sessions} session(s), ${row.uses} reference(s)${withheld}, last ${row.lastSeenAt}`)
      }
      out('\nto allowlist: secrets-env-allowlist.ts allow --agent <slug> NAME…   (or: apply --yes)')
      return 0
    }
    case 'list': {
      for (const e of listAllowlist()) out(`${e.subjectType} ${e.subject}: ${e.key}`)
      return 0
    }
    case 'allow':
    case 'remove': {
      const s = subjectOf(flags)
      if (rest.length === 0) throw new Error('name at least one KEY')
      for (const key of rest) {
        const changed = cmd === 'allow'
          ? addAllowlistEntry(s.type, s.subject, key, null, 'cli')
          : removeAllowlistEntry(s.type, s.subject, key, null, 'cli')
        out(`${cmd} ${s.type} ${s.subject}: ${key}${changed ? '' : ' (no change)'}`)
      }
      return 0
    }
    case 'apply': {
      const r = envUsageReport({ sinceDays: days, minSessions: Number(flags['min-sessions'] ?? 2) })
      const yes = flags.yes === true
      for (const [agent, keys] of Object.entries(r.suggestions)) {
        for (const key of keys) {
          if (yes) addAllowlistEntry('agent', agent, key, null, 'cli')
          out(`${yes ? 'allowed' : '[dry-run] would allow'} agent ${agent}: ${key}`)
        }
      }
      if (!yes) out('dry run — re-run with --yes to write these entries')
      return 0
    }
    case 'mode': {
      const m = rest[0]
      if (!isSessionEnvMode(m)) throw new Error('mode migration|enforce')
      setSessionEnvMode(m, null, 'cli')
      out(`mode: ${getSessionEnvMode()}`)
      if (m === 'enforce' && !readSettingFlag(SESSION_SECRET_ACCESS_FLAG)) {
        out('NOTE: session_secret_access is OFF, so sessions cannot reach non-allowlisted names through the broker either.')
      }
      return 0
    }
    default:
      throw new Error(`unknown command '${cmd}' (status | report | list | allow | remove | apply | mode)`)
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)
if (isMain) {
  try {
    initDb()
    process.exit(run(process.argv.slice(2)))
  } catch (err) {
    console.error(`secrets-env-allowlist: ${(err as Error).message}`)
    process.exit(1)
  }
}
