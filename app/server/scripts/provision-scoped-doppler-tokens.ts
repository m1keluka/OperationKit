/**
 * provision-scoped-doppler-tokens.ts  (obj-2411 / Phase 0 of #1731)
 *
 * Mints ONE read-only Doppler *service* token per (workspace, Doppler config) and
 * populates the encrypted `doppler_scoped_tokens` map that the spawn-env
 * `getScopedDopplerToken` seam resolves against. This is Step 1 of
 * app/server/SPAWN-ENV-SCOPING-CUTOVER.md.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SAFETY: DRY-RUN BY DEFAULT.                                              │
 * │   • With no flags it prints EXACTLY what it WOULD mint + store and       │
 * │     mints/writes NOTHING.                                                │
 * │   • To actually mint live Doppler tokens and write live rows you must    │
 * │     pass BOTH `--commit` AND set env PROVISION_SCOPED_DOPPLER_COMMIT=1.   │
 * │     (Defense in depth: a stray `--commit` alone cannot mint.)            │
 * │   • This is a deliberate, Mike-gated action — see the runbook.           │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Usage (from app/server):
 *   tsx scripts/provision-scoped-doppler-tokens.ts                 # DRY-RUN plan
 *   tsx scripts/provision-scoped-doppler-tokens.ts --status        # show current map (masked)
 *   PROVISION_SCOPED_DOPPLER_COMMIT=1 \
 *     tsx scripts/provision-scoped-doppler-tokens.ts --commit      # LIVE mint + store (Mike-gated)
 *
 * Requirements for a live run:
 *   • `doppler` CLI authenticated with an account that can create service tokens
 *     for the target projects/configs (the admin token / your login).
 *   • TEST_CRED_ENCRYPTION_KEY + DB_PATH set the same as the server, so the row
 *     encrypts under the same key the server decrypts with at spawn.
 *
 * The token is created with `--access read` (READ-ONLY) and scoped to a single
 * project/config — textbook least-privilege, the opposite of today's broadcast
 * admin token.
 */

import { execFileSync } from 'child_process'
import { initDb } from '../src/db/index.js'
import {
  setScopedDopplerToken,
  listScopedDopplerTokens,
  DEFAULT_DOPPLER_CONFIG,
} from '../src/services/doppler-scoped-tokens.js'

// ── Provisioning registry ────────────────────────────────────────────────────
// One entry per workspace a MEMBER may spawn into. `dopplerProject` is the
// Doppler project the read-only token is scoped to; `config` is the Doppler config
// (defaults to 'prd'). EDIT this to match the real Doppler project names before a
// live run — verify each with `doppler projects` / `doppler configs --project <p>`.
interface ProvisionTarget {
  workspace: string
  dopplerProject: string
  config?: string
}

const TARGETS: ProvisionTarget[] = [
  { workspace: 'example', dopplerProject: 'example-platform', config: 'prd' },
  { workspace: 'example2', dopplerProject: 'example3-platform', config: 'prd' },
  { workspace: 'example-project', dopplerProject: 'example-project-platform', config: 'prd' },
  { workspace: 'personal', dopplerProject: 'command-center', config: 'prd' },
]

function tokenName(t: ProvisionTarget, config: string): string {
  return `cc-scoped-ro-${t.workspace}-${config}`
}

/** Build the `doppler configs tokens create` argv for a target (read-only). */
function mintArgs(t: ProvisionTarget, config: string): string[] {
  return [
    'configs', 'tokens', 'create', tokenName(t, config),
    '--project', t.dopplerProject,
    '--config', config,
    '--access', 'read',     // READ-ONLY — least privilege
    '--plain',              // print just the token to stdout
  ]
}

function mintLiveToken(t: ProvisionTarget, config: string): string {
  const out = execFileSync('doppler', mintArgs(t, config), { encoding: 'utf-8' })
  const token = out.trim()
  if (!token) throw new Error(`doppler returned an empty token for ${t.workspace}/${config}`)
  return token
}

function printStatus(): void {
  initDb()
  const rows = listScopedDopplerTokens()
  if (rows.length === 0) {
    console.log('doppler_scoped_tokens: (empty — no scoped tokens provisioned yet)')
    return
  }
  console.log('doppler_scoped_tokens (masked):')
  for (const r of rows) {
    console.log(
      `  ${r.workspace.padEnd(14)} ${r.config.padEnd(6)} …${r.token_last4}` +
        `  project=${r.doppler_project ?? '?'}  updated=${r.updated_at}`,
    )
  }
}

function main(): void {
  const argv = process.argv.slice(2)
  if (argv.includes('--status')) {
    printStatus()
    return
  }

  const commitFlag = argv.includes('--commit')
  const commitEnv = process.env.PROVISION_SCOPED_DOPPLER_COMMIT === '1'
  const live = commitFlag && commitEnv

  if (commitFlag && !commitEnv) {
    console.error(
      '[provision] REFUSING to mint: --commit was passed but ' +
        'PROVISION_SCOPED_DOPPLER_COMMIT=1 is NOT set. This double-gate prevents an ' +
        'accidental live mint. Set the env var to proceed (Mike-gated).',
    )
    process.exit(1)
  }

  console.log(
    live
      ? '=== LIVE RUN — minting read-only Doppler tokens and writing rows ==='
      : '=== DRY-RUN — nothing is minted or written. Pass --commit AND ' +
          'PROVISION_SCOPED_DOPPLER_COMMIT=1 to go live. ===',
  )

  if (live) initDb()

  for (const t of TARGETS) {
    const config = t.config || DEFAULT_DOPPLER_CONFIG
    const cmd = `doppler ${mintArgs(t, config).join(' ')}`
    if (!live) {
      console.log(`\n[${t.workspace}/${config}] WOULD mint read-only token:`)
      console.log(`    ${cmd}`)
      console.log(`  WOULD upsert doppler_scoped_tokens(workspace=${t.workspace}, config=${config}, project=${t.dopplerProject})`)
      continue
    }
    try {
      console.log(`\n[${t.workspace}/${config}] minting…`)
      const token = mintLiveToken(t, config)
      const saved = setScopedDopplerToken({
        workspace: t.workspace,
        config,
        token,
        dopplerProject: t.dopplerProject,
        note: `minted by provision-scoped-doppler-tokens.ts (${tokenName(t, config)})`,
      })
      console.log(`  stored …${saved.token_last4} (read-only, project=${t.dopplerProject})`)
    } catch (err) {
      console.error(`  FAILED for ${t.workspace}/${config}: ${(err as Error).message}`)
      console.error('  (continuing with remaining targets; re-run to retry this one)')
    }
  }

  if (live) {
    console.log('\n=== done. Current map: ===')
    printStatus()
    console.log(
      '\nNEXT: flip USE_SCOPED_DOPPLER_TOKENS + SCOPE_SUPABASE_ACCESS_TOKEN, verify, ' +
        'then rotate the old admin token — see app/server/SPAWN-ENV-SCOPING-CUTOVER.md.',
    )
  } else {
    console.log(
      '\n(DRY-RUN complete. Edit TARGETS to match real Doppler project names, then ' +
        'do a Mike-gated live run.)',
    )
  }
}

main()
