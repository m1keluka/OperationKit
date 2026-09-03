// Spawns and supervises the Telegram Rolodex sibling process (Phase 5 Personal CRM).
//
// The sibling is intentionally not part of entrypoint.sh (which is baked into
// the image and would need a rebuild to change). Spawning it from the main
// server means:
//   - New deploys ship via the existing source-mount, no image rebuild.
//   - When the main server restarts, the sibling restarts with it.
//   - If the sibling crashes, this supervisor restarts it with backoff.
//
// Skipped silently if TELEGRAM_BOT_TOKEN or TELEGRAM_ROLODEX_OWNER_ID is unset.

import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import { CC_REPO_DIR } from '../config.js'

// Resolved from config rather than hardcoded (obj 709956): the literal used to be
// `/home/operator/projects/command-center-infra/app/telegram-rolodex/index.ts`, which
// pinned both the operator's home and the PRIVATE upstream repo name into shipped
// source. The sibling itself is operator-specific and is stripped from the public
// cut (scripts/oss-strip-paths.txt), so in a public install this path simply does
// not exist — which the existsSync guard below already handles by skipping.
const SIBLING_ENTRY =
  process.env.ROLODEX_SIBLING_ENTRY || `${CC_REPO_DIR}/app/telegram-rolodex/index.ts`
const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
const RESET_BACKOFF_AFTER_MS = 60_000  // a run that lasted this long resets backoff

let child: ChildProcess | null = null
let stopping = false
let backoffMs = MIN_BACKOFF_MS
let lastStartAt = 0

export function startRolodexSibling(): void {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_ROLODEX_OWNER_ID) {
    console.log('[rolodex-supervisor] disabled — TELEGRAM_BOT_TOKEN or TELEGRAM_ROLODEX_OWNER_ID not set')
    return
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[rolodex-supervisor] ANTHROPIC_API_KEY missing — sibling will exit immediately')
  }
  if (!fs.existsSync(SIBLING_ENTRY)) {
    console.warn(`[rolodex-supervisor] entry not found: ${SIBLING_ENTRY} (skipping)`)
    return
  }
  spawnOnce()
}

function spawnOnce(): void {
  if (stopping) return
  lastStartAt = Date.now()
  console.log(`[rolodex-supervisor] spawning sibling: tsx ${SIBLING_ENTRY}`)
  child = spawn('tsx', [SIBLING_ENTRY], {
    cwd: '/app',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout?.on('data', chunk => {
    process.stdout.write(prefix(chunk))
  })
  child.stderr?.on('data', chunk => {
    process.stderr.write(prefix(chunk))
  })
  child.on('exit', (code, signal) => {
    const ranFor = Date.now() - lastStartAt
    console.log(`[rolodex-supervisor] sibling exited code=${code} signal=${signal} after ${ranFor}ms`)
    if (stopping) return
    if (ranFor >= RESET_BACKOFF_AFTER_MS) backoffMs = MIN_BACKOFF_MS
    const delay = backoffMs
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
    setTimeout(spawnOnce, delay)
  })
  child.on('error', err => {
    console.error('[rolodex-supervisor] spawn error:', err)
  })
}

function prefix(buf: Buffer): string {
  return buf.toString('utf-8')
    .split('\n')
    .map((l, i, a) => l || (i === a.length - 1 ? '' : ''))
    .join('\n')
}

export function stopRolodexSibling(): void {
  stopping = true
  if (child && !child.killed) child.kill('SIGTERM')
}

process.on('SIGTERM', stopRolodexSibling)
process.on('SIGINT', stopRolodexSibling)
