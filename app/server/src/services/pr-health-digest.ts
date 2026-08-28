/**
 * PR-health markdown digest — extracted from pr-health-watchdog.ts (behavior frozen).
 */
import type { Classification, PrHealth, SweepResult } from './pr-health-decisions.js'

// ── Mike-facing rendering ───────────────────────────────────────────────────────

const LABEL: Record<Classification, string> = {
  'green': 'GREEN',
  'pending': 'PENDING',
  'advisory-only': 'ADVISORY ONLY (red, but nothing REQUIRED is failing)',
  'cancellation-only': 'NOISE (cancelled jobs only)',
  'unowned': 'UNOWNED',
  'environmental': 'ENVIRONMENTAL (unfixable by push)',
  'real-failure': 'REAL FAILURE',
}

/** Order red PRs worst-first so the top of the digest is always the thing to look at. */
const SEVERITY: Record<Classification, number> = {
  'real-failure': 0,
  'environmental': 1,
  'unowned': 2,
  'cancellation-only': 3,
  'advisory-only': 4,
  'pending': 5,
  'green': 6,
}

/** One line explaining what gates a PR's base branch — the receipt behind every
 *  "advisory" claim in the digest, so a reader never has to take it on faith. */
function gateLine(p: PrHealth): string {
  switch (p.requiredGateState) {
    case 'enforced':
      return `gate (base \`${p.baseBranch}\`): required → ${p.requiredContexts.map(c => `\`${c}\``).join(', ')}`
    case 'no-ruleset':
      return `gate (base \`${p.baseBranch}\`): **no required checks configured** — nothing is gating this PR (this is NOT "checks verified green")`
    default:
      return `gate (base \`${p.baseBranch || '?'}\`): **UNKNOWN — ruleset unreadable**, treating every red check as blocking (fail-safe)`
  }
}

/**
 * The single Mike-facing surface: one compact markdown digest answering, per red PR,
 * WHICH checks are red, whether it is a real failure or noise, WHICH objective owns it,
 * and HOW MANY remediation attempts have been spent. Green and pending PRs collapse to
 * a one-line tally — the point of the digest is to remove hunting, not to re-list
 * everything Mike already knows is fine.
 */
export function renderDigest(report: SweepResult): string {
  const red = report.prs
    .filter(p => p.classification !== 'green' && p.classification !== 'pending')
    .sort((a, b) => SEVERITY[a.classification] - SEVERITY[b.classification] || a.repo.localeCompare(b.repo) || a.number - b.number)

  const green = report.prs.filter(p => p.classification === 'green').length
  const pending = report.prs.filter(p => p.classification === 'pending').length

  const L: string[] = []
  L.push('# PR Health — all tracked repos')
  L.push('')
  L.push(
    `_swept ${report.ranAt} · ${report.prsScanned} open PR(s) across ${report.repos.length} repo(s) · ` +
      `act-path ${report.enabled ? 'ARMED' : 'DARK'}${report.dryRun ? ' · dry-run' : ''}_`,
  )
  L.push('')
  const mergeable = report.prs.filter(p => p.mergeableNow)
  const blocked = report.prs.filter(p => (p.requiredRedChecks?.length ?? 0) > 0).length
  L.push(
    `**${red.length} red · ${blocked} with a REQUIRED check failing · ${mergeable.length} mergeable now · ` +
      `${pending} pending · ${green} green**`,
  )
  const unknownGates = Object.entries(report.gates || {}).filter(([, g]) => g.state === 'unknown')
  if (unknownGates.length) {
    L.push('')
    L.push(
      `> RULESET UNREADABLE for ${unknownGates.map(([k, g]) => `${k} (${g.error})`).join('; ')} — ` +
        'those PRs fall back to treating every red check as blocking.',
    )
  }
  if (report.errors.length) {
    L.push('')
    L.push(`> PARTIAL REPORT — could not enumerate: ${report.errors.map(e => `${e.repo} (${e.message})`).join('; ')}`)
  }
  L.push('')

  // MERGEABLE-NOW goes FIRST and includes green PRs, because it answers the question the
  // rest of the digest cannot: "what can I land right now?" A PR with three red advisory
  // checks belongs here just as much as a fully-green one.
  if (mergeable.length) {
    L.push('## MERGEABLE NOW')
    L.push('')
    L.push(
      '_No REQUIRED status check is failing and GitHub does not report the merge blocked or ' +
        'conflicted. Ordered by repo. The watchdog never merges — this is a list for a human._',
    )
    L.push('')
    for (const p of [...mergeable].sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number)) {
      const redNote =
        p.advisoryRedChecks?.length
          ? ` · ${p.advisoryRedChecks.length} advisory red (${p.advisoryRedChecks.map(c => c.name).join(', ')})`
          : ''
      L.push(
        `- **${p.repo}#${p.number}** — ${p.title}` +
          `\n  - ${p.url} · merge state \`${p.mergeStateStatus || 'UNKNOWN'}\`${redNote}` +
          `\n  - ${gateLine(p)}`,
      )
    }
    L.push('')
  }

  if (red.length === 0) {
    L.push('No red PRs. Nothing to hunt.')
    return L.join('\n').trimEnd() + '\n'
  }

  let lastClass = ''
  for (const p of red) {
    if (p.classification !== lastClass) {
      L.push(`## ${LABEL[p.classification]}`)
      L.push('')
      lastClass = p.classification
    }
    const ownerTxt =
      p.objectiveId === null
        ? `**no owning objective** — ${p.ownerReason}`
        : `obj ${p.objectiveId} (${p.objectiveStatus}) → ${p.owner} — ${p.ownerReason}`
    const age = p.redForMinutes === null ? 'unknown' : `${p.redForMinutes}m`
    L.push(`- **${p.repo}#${p.number}** — ${p.title}`)
    L.push(`  - ${p.url}${p.isDraft ? ' _(draft)_' : ''} · @${p.author}${p.authorIsBot ? ' (bot)' : ''} · red for ${age}`)
    L.push(`  - owner: ${ownerTxt} · attempts spent: ${p.attemptsSpent}`)
    L.push(`  - ${gateLine(p)}${p.mergeStateStatus ? ` · merge state \`${p.mergeStateStatus}\`` : ''}`)
    const req = p.requiredRedChecks ?? p.redChecks
    const adv = p.advisoryRedChecks ?? []
    const reqFails = req.filter(c => c.kind === 'failed')
    const reqCancels = req.filter(c => c.kind === 'cancelled')
    if (!req.length) {
      L.push('  - ⛔ BLOCKING (required): none')
    }
    if (reqFails.length) {
      L.push(
        `  - ⛔ BLOCKING (required), failing: ${reqFails
          .map(c => `\`${c.name}\`${c.environmental ? ' _(environmental)_' : ''}`)
          .join(', ')}`,
      )
    }
    if (reqCancels.length) {
      L.push(
        `  - ⛔ BLOCKING (required), cancelled (noise): ${reqCancels.length} — ` +
          `${reqCancels.slice(0, 4).map(c => `\`${c.name}\``).join(', ')}${reqCancels.length > 4 ? ', …' : ''}`,
      )
    }
    if (adv.length) {
      L.push(
        `  - advisory red (gates nothing): ${adv.length} — ` +
          `${adv.slice(0, 6).map(c => `\`${c.name}\``).join(', ')}${adv.length > 6 ? ', …' : ''}`,
      )
    }
    if (p.action !== 'none') {
      const verb = p.wouldOnly ? `WOULD ${p.action}` : p.action
      // NOT "(next sweep)" — that was a promise the reconciler could not keep while the
      // budget was spent in a fixed order. actionDetail now carries the real queue slot.
      L.push(`  - next action: **${verb}${p.deferred ? ' (queued)' : ''}** — ${p.actionDetail}`)
    }
    L.push('')
  }

  renderOrphanBacklog(report, L)

  return L.join('\n').trimEnd() + '\n'
}

/**
 * The orphan backlog: every open PR that NO objective owns, red or green, appended to
 * the digest.
 *
 * WHY (obj 704787). An unowned PR has, by definition, nobody to nudge — the act-path's
 * only move is `escalate`, which is gated behind BOTH the arming flag and the per-sweep
 * cap. So while the watchdog is dark or the cap is spent, an unowned PR is visible to
 * literally no one and simply ages. That is how example#239 reached 31 days red and
 * example3#340 reached 24 days without anyone being told. This section is deliberately
 * independent of arming AND of the cap: it is a plain census of what nobody owns, so the
 * ageing is impossible to miss even with every act-path switched off.
 *
 * Measured live 2026-08-06: 22 of 57 open PRs across the three repos were unowned.
 */
function renderOrphanBacklog(report: SweepResult, L: string[]): void {
  // Green and pending PRs stay collapsed into the tally — the digest's standing contract
  // is that it lists what needs hunting, and an unowned PR whose checks are fine is not
  // it. What this section adds is the ownerless RED PRs that the classification sections
  // scatter: example#239 files under `unowned`, example3#629 under `environmental`, and
  // neither is legible as "nobody is coming for this" until they are counted together.
  const orphans = report.prs
    .filter(p => p.owner === 'unowned' && p.classification !== 'green' && p.classification !== 'pending')
    .sort((a, b) => (b.redForMinutes ?? -1) - (a.redForMinutes ?? -1) || a.repo.localeCompare(b.repo) || a.number - b.number)

  if (orphans.length === 0) return

  const bots = orphans.filter(p => p.authorIsBot).length
  L.push('')
  L.push('## Unowned backlog — no objective owns these')
  L.push('')
  L.push(
    `**${orphans.length} of ${report.prsScanned} open PR(s)** have no owning objective ` +
      `(${bots} bot, ${orphans.length - bots} human). Nobody is being nudged about these — ` +
      'they need a human disposition: close, revive, or adopt.',
  )
  L.push('')
  for (const p of orphans) {
    const age = p.redForMinutes === null ? '' : ` · red ${Math.floor(p.redForMinutes / 1440)}d`
    L.push(
      `- ${p.repo}#${p.number} — ${p.title} · @${p.author}${p.authorIsBot ? ' (bot)' : ''}` +
        `${age} · ${p.classification}`,
    )
  }
}

