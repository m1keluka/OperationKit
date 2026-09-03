#!/usr/bin/env tsx
// ── Daily Session Retrospective — DRY RUN CLI ────────────────────────────────
//
//   tsx src/scripts/retro-dry-run.ts --day 2026-08-07 [--since ""] [--max 5] [--json]
//
// Runs the FULL pipeline for a past day — three-tier detection plus the three
// review lenses — and prints the objectives it WOULD create. It writes nothing:
// no dsr_* rows, no fingerprint ledger entries, no session_corrections, and no
// objectives. This is the artefact Mike reviews at cutover (§D.5).
//
// Point DB_PATH at a COPY of prod, never prod itself:
//   cp /app/data/command-center.db /tmp/dsr-audit.db
//   DB_PATH=/tmp/dsr-audit.db tsx src/scripts/retro-dry-run.ts --day 2026-08-07 --json
//
// --lens-stub replaces the Anthropic lenses with a deterministic pass-through
// so detector output can be inspected without spending tokens or needing a key.
// --lens-echo replays the D-5 self-duplicate failure mode (L2 echoes the source
// objective id back as duplicate_of) — pre-fix it kills 100%, post-fix nothing.

import { initDb } from '../db/index.js'
import { runDailyRetro, type LensRunner } from '../services/daily-retro.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return undefined
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : ''
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

/**
 * D-5 REPLAY lens. Models the observed real-L2 failure mode exactly: read an
 * objective id out of whatever context you were handed and call the candidate a
 * duplicate of it. Deterministic, free, and needs no API key — so the
 * self-duplicate bug can be reproduced and its fix demonstrated over real data.
 *
 * Against the pre-fix gate the source id is in L2's context, so this kills
 * 100% of candidates. Post-fix the id is withheld and filtered from the board
 * context, so candidates survive L2. L1/L3 pass, as with --lens-stub.
 */
const echoLens: LensRunner = async (lens, candidate, context) => {
  if (lens !== 'L2') return stubLens(lens, candidate, context)
  const m = /source: objective (\d+)/.exec(context)
  return m
    ? { verdict: { duplicate: true, already_fixed: false, duplicate_of: Number(m[1]), evidence: `objective ${m[1]} already tracks this` }, cost_usd: 0 }
    : { verdict: { duplicate: false, already_fixed: false, duplicate_of: null, evidence: 'no matching open objective in board context' }, cost_usd: 0 }
}

/** Deterministic "everything passes" lens — detector inspection only. */
const stubLens: LensRunner = async lens => {
  if (lens === 'L1' || lens === "L1'") {
    return {
      verdict: { refuted: false, is_real_defect: true, one_line_statement: '(lens stubbed)', evidence_quote: '', confidence: 0.9 },
      cost_usd: 0,
    }
  }
  if (lens === 'L2') return { verdict: { duplicate: false, already_fixed: false, duplicate_of: null, evidence: '(lens stubbed)' }, cost_usd: 0 }
  return { verdict: { remedy: 'fix_objective', scope_ok: true, priority: 'P2', rationale: '(lens stubbed)' }, cost_usd: 0 }
}

async function main(): Promise<void> {
  const day = arg('day') || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const maxRaw = arg('max')
  const sinceRaw = arg('since')
  const asJson = flag('json')

  initDb()

  const result = await runDailyRetro({
    day,
    mode: 'shadow',
    dryRun: true,
    // `--since ""` defeats the watermark for a full rescan of the day.
    since: sinceRaw === undefined ? undefined : sinceRaw === '' ? null : sinceRaw,
    max: maxRaw ? parseInt(maxRaw, 10) : undefined,
    lensRunner: flag('lens-echo') ? echoLens : flag('lens-stub') ? stubLens : undefined,
  })

  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`\n── DSR dry run — ${day} (SHADOW, writes nothing) ──`)
  console.log(`sessions scanned:        ${result.sessions_scanned}`)
  console.log(`raw signals:             ${result.raw_signals}`)
  console.log(`above floor (unledgered):${result.above_floor}`)
  console.log(`unclassified followups:  ${result.unclassified_followups}`)
  console.log(`lens-killed:             ${result.lens_killed}`)
  console.log(`held (split vote):       ${result.held}`)
  console.log(`routed to corrections:   ${result.routed_corrections}`)
  console.log(`dropped by cap:          ${result.dropped_by_cap}`)
  console.log(`lens cost:               $${result.cost_usd.toFixed(3)}`)
  if (result.skipped) console.log(`SKIPPED: ${result.skipped}`)
  if (result.notes.length) console.log(`notes: ${result.notes.join('; ')}`)

  const would = result.candidates.filter(c => c.verdict === 'promoted')
  console.log(`\nWOULD CREATE ${would.length} objective(s):`)
  for (const c of would) {
    const p = c.would_create as Record<string, unknown> | undefined
    console.log(`\n  • ${p?.title ?? c.excerpt.slice(0, 80)}`)
    console.log(`    signal=${c.signal_type} conf=${c.confidence.toFixed(2)} recurrence=${c.recurrence}`)
    console.log(`    source=obj ${c.source_objective_id ?? 'n/a'} session ${c.source_session_id ?? 'n/a'}`)
    console.log(`    fingerprint=${c.fingerprint}`)
  }
  console.log('\n(no objectives, no dsr_* rows, and no corrections were written)\n')
}

main().catch(err => {
  console.error('[retro-dry-run] failed:', err)
  process.exit(1)
})
