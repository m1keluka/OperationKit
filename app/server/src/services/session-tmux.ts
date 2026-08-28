/**
 * tmux spawn wrapper — extracted from session-manager.ts (behavior frozen).
 * Does not own the live-session table; that lives in session-registry.ts.
 */
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { PROJECTS_DIR, SECOND_BRAIN_DIR, AI_WORKSPACE_DIR } from '../config.js'
import { canonicalRootEnv } from './design-context.js'
import { getModelEngine } from './model-registry.js'
import { buildClaudeCommand } from './session-spawn-command.js'
import { spawnSegmentOffset } from './session-registry.js'

// ── `~`-home false-negative fix (obj 532 / 553) ──
// Spawned sessions run as OS user `ccuser` with HOME pointed at a per-account
// scratch dir (/home/ccuser-{a..e}). So a session that types `~/second-brain/...`
// expands `~` to that scratch home — NOT /home/mike — and the path "does not
// exist", producing false-negative reviews (obj 532's first ai_review failed this
// way). We cannot set HOME=/home/mike (each account needs its own Claude OAuth
// config + Playwright profile under its own HOME), so instead we drop convenience
// symlinks INTO each account home so `~/second-brain`, `~/projects`, and
// `~/ai-workspace` resolve to the real /home/mike roots. Idempotent; skips any
// name already occupied by a real (non-symlink) entry. Combined with the canonical
// root env vars (canonicalRootEnv) injected at spawn, both `~`-relative and
// env-based absolute paths now land on /home/mike.
const canonicalLinkTargets: Record<string, string> = {
  'second-brain': SECOND_BRAIN_DIR,
  projects: PROJECTS_DIR,
  'ai-workspace': AI_WORKSPACE_DIR,
}
function ensureCanonicalRootLinks(homeDir: string): void {
  for (const [name, target] of Object.entries(canonicalLinkTargets)) {
    const linkPath = path.join(homeDir, name)
    try {
      const cur = fs.lstatSync(linkPath, { throwIfNoEntry: false } as { throwIfNoEntry: false })
      if (cur) {
        // Already a correct symlink → done. A real dir/file → leave it (don't clobber).
        if (cur.isSymbolicLink() && fs.readlinkSync(linkPath) === target) continue
        if (!cur.isSymbolicLink()) continue
        fs.unlinkSync(linkPath) // stale symlink → repoint
      }
      fs.symlinkSync(target, linkPath)
    } catch (err) {
      console.warn(`[session-manager] canonical-root link ${linkPath} -> ${target} skipped:`, (err as Error).message)
    }
  }
}

// ── tmux session helpers ──

// Shared scratch dir for spawn scripts/prompts/MCP configs. Overridable so tests
// (and any process on a host where /tmp/cc-scripts is root-owned) can point at a
// writable dir instead of failing with EACCES.
export const TMUX_SCRIPT_DIR = process.env.CC_SCRIPT_DIR || '/tmp/cc-scripts'

/**
 * Force the google-workspace MCP onto THIS session's isolated credential dir.
 * Ambient `~/.claude.json` still points at the shared multi-user folder; an
 * extra --mcp-config with the same server name overrides that env.
 */
function overlayGoogleMcpConfig(
  sessionId: string,
  homeDir: string,
  env: Record<string, string>,
  existingPath?: string,
): string | undefined {
  const credsDir = env.WORKSPACE_MCP_CREDENTIALS_DIR
  if (!credsDir) return existingPath
  let mcpServers: Record<string, unknown> = {}
  if (existingPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(existingPath, 'utf8')) as { mcpServers?: Record<string, unknown> }
      mcpServers = parsed.mcpServers ?? {}
    } catch { /* start fresh */ }
  }
  const uvx = path.join(homeDir, '.local/bin/uvx')
  mcpServers['google-workspace'] = {
    command: fs.existsSync(uvx) ? uvx : 'uvx',
    args: ['workspace-mcp', '--tools', 'gmail', 'calendar', 'drive', 'docs', 'sheets', 'slides', '--tool-tier', 'extended'],
    env: {
      ...(env.GOOGLE_OAUTH_CLIENT_ID ? { GOOGLE_OAUTH_CLIENT_ID: env.GOOGLE_OAUTH_CLIENT_ID } : {}),
      ...(env.GOOGLE_OAUTH_CLIENT_SECRET ? { GOOGLE_OAUTH_CLIENT_SECRET: env.GOOGLE_OAUTH_CLIENT_SECRET } : {}),
      WORKSPACE_MCP_CREDENTIALS_DIR: credsDir,
      USER_GOOGLE_EMAIL: env.USER_GOOGLE_EMAIL || '',
    },
  }
  const outPath = existingPath || path.join(TMUX_SCRIPT_DIR, `${sessionId}.mcp.json`)
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify({ mcpServers }, null, 2))
    fs.chmodSync(outPath, 0o666)
    return outPath
  } catch (err) {
    console.warn(`[session-manager] google MCP overlay failed for ${sessionId}:`, (err as Error).message)
    return existingPath
  }
}

/** Check if a tmux session exists */
export function tmuxSessionAlive(tmuxName: string): boolean {
  try {
    execSync(`tmux has-session -t ${JSON.stringify(tmuxName)} 2>/dev/null`, { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

export function spawnInTmux(opts: {
  sessionId: string
  homeDir: string
  workdir: string
  prompt: string
  jsonlPath: string
  logPath: string
  env: Record<string, string>
  effort?: string
  model?: string
  resumeSessionId?: string            // claude CLI session id — spawn with --resume for native continuity
  mcpConfigPath?: string              // extra --mcp-config file (e.g. Playwright for the reviewer gate)
  settingsPath?: string               // extra --settings file (obj 1059 PreToolUse worktree guard)
  worktreeRoot?: string               // isolated session's worktree root → exported as CC_WORKTREE_ROOT for the guard
}): string {
  const { sessionId, homeDir, workdir, prompt, jsonlPath, logPath, env, effort, model, resumeSessionId, mcpConfigPath, settingsPath, worktreeRoot } = opts
  const tmuxName = sessionId // use session ID as tmux session name

  // `~`-home fix: ensure ~/second-brain, ~/projects, ~/ai-workspace in this
  // account home resolve to the real /home/mike roots before the session starts.
  ensureCanonicalRootLinks(homeDir)

  fs.mkdirSync(TMUX_SCRIPT_DIR, { recursive: true })

  // Write prompt as plain text file — piped to claude via stdin (no stream-json input needed)
  const promptFile = path.join(TMUX_SCRIPT_DIR, `${sessionId}.prompt.txt`)
  fs.writeFileSync(promptFile, prompt)
  fs.chmodSync(promptFile, 0o666)

  // Build env exports for the wrapper script. Canonical /home/mike roots are
  // merged in (caller env wins on collision) so every session can reference the
  // real vault/projects/workspace via env vars instead of brittle `~` expansion.
  // Isolated sessions (obj 1059): expose the worktree root to the PreToolUse guard.
  const fullEnv: Record<string, string> = { ...canonicalRootEnv(), ...env, ...(worktreeRoot ? { CC_WORKTREE_ROOT: worktreeRoot } : {}) }
  const engine = getModelEngine(model)
  const envExports = Object.entries(fullEnv)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join('\n')

  // Write wrapper script — runs Claude (or Codex), then cleans up.
  // CRITICAL: unset provider API keys so the CLI uses OAuth/subscription auth,
  // not API billing. Codex reads ~/.codex/auth.json when OPENAI_API_KEY is
  // absent; Grok reads ~/.grok/auth.json (SuperGrok) when XAI_API_KEY is absent.
  const scriptFile = path.join(TMUX_SCRIPT_DIR, `${sessionId}.sh`)
  const budget = effort === 'ultracode' ? 200 : effort === 'high' ? 100 : 50
  // Map objective effort tiers to CLI --effort levels (reviewers pass 'low' directly)
  const effortLevel = effort === 'ultracode' ? 'max' : effort === 'high' ? 'high' : effort === 'low' ? 'low' : 'medium'
  // Engine (claude vs codex) comes from the model's registry row, not the id
  // string — so Codex can run any of its models (gpt-5.5 / 5.4 / 5.4-mini).
  // Build the agent command + runaway caps (turn cap + token ceiling) — see
  // buildClaudeCommand. Pure builder so the caps are unit-testable. (ST3)
  // mcpConfigPath threads main's #684 reviewer Playwright gate, and settingsPath
  // threads main's #69 obj-1059 PreToolUse worktree guard, through the builder.
  const isolatedMcp = overlayGoogleMcpConfig(sessionId, homeDir, env, mcpConfigPath)
  const claudeCmd = buildClaudeCommand({ engine, budget, effortLevel, model, resumeSessionId, mcpConfigPath: isolatedMcp ?? mcpConfigPath, settingsPath })
  // Official grok CLI takes the prompt as `-p` (not stdin / --prompt-file).
  const runLine = engine === 'grok'
    ? `${claudeCmd} -p "$(cat ${JSON.stringify(promptFile)})" >> ${JSON.stringify(jsonlPath)} 2>> ${JSON.stringify(logPath)}`
    : `${claudeCmd} < ${JSON.stringify(promptFile)} >> ${JSON.stringify(jsonlPath)} 2>> ${JSON.stringify(logPath)}`
  if (resumeSessionId) {
    console.log(`[session-manager] Resume spawn for ${sessionId}: ${claudeCmd}`)
  }
  fs.writeFileSync(scriptFile, `#!/bin/bash
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY XAI_API_KEY GROK_CODE_XAI_API_KEY
# Run session work at lower CPU priority so heavy concurrent sessions don't
# starve the control plane — the Node web server + state-poller stay at nice 0
# and the UI keeps responding. Self-renice (raising OWN niceness) needs no
# privilege; the container lacks CAP_SYS_NICE so negative nice is unavailable
# anyway. claude and every subagent it spawns inherit this niceness. (2026-06-22:
# 7 concurrent sessions pegged the 8-core box at load ~40 and the site crawled.)
renice -n 15 -p $$ >/dev/null 2>&1 || true
${envExports}
cd ${JSON.stringify(workdir)} || exit 1
echo "[wrapper] Starting at $(date)" >> ${JSON.stringify(logPath)}
echo "[wrapper] Prompt file size: $(wc -c < ${JSON.stringify(promptFile)})" >> ${JSON.stringify(logPath)}
${runLine}
EXIT_CODE=$?
rm -f ${JSON.stringify(promptFile)} ${JSON.stringify(scriptFile)} 2>/dev/null || true
exit $EXIT_CODE
`)
  fs.chmodSync(scriptFile, 0o777)

  // Record the spawn-segment boundary BEFORE this spawn's wrapper appends to the
  // jsonl, so the death-scan attributes rate limits only to events from THIS
  // segment — not a prior account's events left in the shared jsonl by auto-resume.
  let priorLineCount = 0
  try { priorLineCount = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(l => l.trim()).length } catch {}
  spawnSegmentOffset.set(sessionId, priorLineCount)

  // Spawn tmux session as ccuser running the wrapper script
  // Kill any stale tmux session with the same name before spawning (prevents
  // "duplicate session" crash when a follow-up races with a dying process).
  try { execSync(`tmux kill-session -t '${tmuxName}' 2>/dev/null`, { timeout: 5000 }) } catch {}
  execSync(
    `tmux new-session -d -s '${tmuxName}' 'runuser -u ccuser -- bash ${scriptFile}'`,
    { timeout: 10000 }
  )

  return tmuxName
}
