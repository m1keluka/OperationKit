/**
 * Worker/reviewer agent command string + Codex engine constants.
 * Extracted from session-manager.ts (behavior frozen). Pure — no tmux spawn.
 */
import fs from 'fs'
import path from 'path'
import { SPAWN_MAX_TURNS, SPAWN_MAX_OUTPUT_TOKENS } from '../config.js'
import { FALLBACK_MODEL_ID } from './model-attribution.js'

// ── Codex engine ──
// Objectives with model === 'codex' run OpenAI's Codex CLI (ChatGPT subscription
// auth) instead of Claude Code. Codex sessions do NOT consume a Claude account
// slot — they use a dedicated home dir whose ~/.codex/auth.json is mounted from
// the host (/home/operator/.ccuser-codex). Account-router functions no-op gracefully
// for the synthetic 'codex' account id.

export const CODEX_MODEL = 'codex'
export const CODEX_ACCOUNT_ID = 'codex'
export const CODEX_HOME_DIR = '/home/ccuser-codex'

export function codexAuthAvailable(): boolean {
  return fs.existsSync(path.join(CODEX_HOME_DIR, '.codex', 'auth.json'))
}

// ── Grok engine ──
// Objectives with engine === 'grok' run the xAI Grok CLI on a SuperGrok /
// X Premium Plus *subscription* (same idea as Codex + ChatGPT Plus). They do
// NOT consume a Claude rotation slot and do NOT use XAI_API_KEY pay-as-you-go.
// Auth is `grok login` → ~/.grok/auth.json in GROK_HOME_DIR (host-backed
// /app/data). Connect on the dashboard drives `grok login --device-auth`.

export const GROK_ACCOUNT_ID = 'grok'
export const GROK_HOME_DIR = process.env.GROK_HOME_DIR || '/app/data/cc-accounts/grok'
export const GROK_DEFAULT_MODEL = 'grok-4.6'

export function grokAuthFile(homeDir = GROK_HOME_DIR): string {
  return path.join(homeDir, '.grok', 'auth.json')
}

/**
 * The official installer leaves `/usr/local/bin/grok` → `/root/.grok/downloads/…`.
 * `/root` is 0700, so `runuser -u ccuser grok` dies with Permission denied and
 * Connect hangs on "Generating sign-in link…". Flatten to a world-exec binary.
 */
export function ensureGrokCliExecutable(): void {
  const link = '/usr/local/bin/grok'
  const dest = '/usr/local/bin/grok.real'
  try {
    const st = fs.lstatSync(link)
    if (!st.isSymbolicLink()) return
    const target = fs.readlinkSync(link)
    if (target === dest || path.resolve(path.dirname(link), target) === dest) return
    if (!target.includes('/root/')) return
    fs.copyFileSync(fs.realpathSync(link), dest)
    fs.chmodSync(dest, 0o755)
    fs.unlinkSync(link)
    fs.symlinkSync(dest, link)
  } catch (err) {
    console.warn('[grok] could not flatten CLI for ccuser:', err instanceof Error ? err.message : err)
  }
}

export function grokAuthAvailable(homeDir = GROK_HOME_DIR): boolean {
  try {
    const st = fs.statSync(grokAuthFile(homeDir))
    return st.isFile() && st.size > 8
  } catch {
    return false
  }
}

/**
 * Build the worker/reviewer agent command string (pure — no side effects), so
 * the runaway-cap flags can be unit-tested without spawning tmux. (ST3)
 *
 * For the `claude` engine this attaches three caps:
 *   - `--max-budget-usd <budget>` (existing per-spawn dollar ceiling),
 *   - `--max-turns <maxTurns>`     (per-spawn turn cap — the dollar ceiling
 *                                   resets every respawn, so without this an
 *                                   agent can loop unbounded within one spawn),
 *   - an inline `CLAUDE_CODE_MAX_OUTPUT_TOKENS=<n>` env prefix (per-response
 *                                   output-token ceiling — the CLI has no
 *                                   session-total token flag, this is the lever
 *                                   it honours, emitted on the command itself).
 * Caps with a value <= 0 are omitted. The Codex engine carries its own caps and
 * is left untouched.
 */
export function buildClaudeCommand(opts: {
  engine: string
  budget: number
  effortLevel: string
  model?: string
  resumeSessionId?: string
  mcpConfigPath?: string
  settingsPath?: string
  maxTurns?: number
  maxOutputTokens?: number
}): string {
  const { engine, budget, effortLevel, model, resumeSessionId, mcpConfigPath, settingsPath } = opts
  const maxTurns = opts.maxTurns ?? SPAWN_MAX_TURNS
  const maxOutputTokens = opts.maxOutputTokens ?? SPAWN_MAX_OUTPUT_TOKENS

  if (engine === 'codex') {
    // Codex engine: headless exec, JSONL events to stdout, prompt via stdin (`-`).
    // Follow-ups resume natively: `codex exec resume <thread_id>` (thread_id is
    // captured from the `thread.started` event, stored in session_runtime).
    // Sandbox bypass is required: sessions already run unsandboxed-by-design as
    // ccuser inside the container (same trust model as --dangerously-skip-permissions).
    const codexEffort = effortLevel === 'max' || effortLevel === 'high' ? 'high' : effortLevel === 'low' ? 'low' : 'medium'
    const codexSub = resumeSessionId ? `exec resume ${JSON.stringify(resumeSessionId)}` : 'exec'
    // Select the OpenAI model on a fresh exec; resume keeps the thread's original
    // model. Legacy generic id 'codex' → no flag → Codex's own default (gpt-5.5).
    const codexModelFlag = (!resumeSessionId && model && model !== CODEX_MODEL) ? ` --model ${JSON.stringify(model)}` : ''
    return `codex ${codexSub}${codexModelFlag} --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -c model_reasoning_effort=${JSON.stringify(codexEffort)} -`
  }

  if (engine === 'grok') {
    const grokModel = (!resumeSessionId && model) ? ` --model ${JSON.stringify(model)}` : ''
    const grokResume = resumeSessionId ? ` --resume ${JSON.stringify(resumeSessionId)}` : ''
    const grokTurns = maxTurns > 0 ? ` --max-turns ${maxTurns}` : ''
    // Prompt is passed as `-p "$(cat promptfile)"` in the tmux wrapper — the
    // official grok CLI does not read the prompt from stdin.
    return `grok --no-auto-update --always-approve --no-alt-screen --output-format streaming-json${grokTurns}${grokModel}${grokResume}`
  }

  const modelFlag = model ? ` --model ${JSON.stringify(model)}` : ''
  const resumeFlag = resumeSessionId ? ` --resume ${JSON.stringify(resumeSessionId)}` : ''
  const turnsFlag = maxTurns > 0 ? ` --max-turns ${maxTurns}` : ''
  const tokenPrefix = maxOutputTokens > 0 ? `CLAUDE_CODE_MAX_OUTPUT_TOKENS=${maxOutputTokens} ` : ''
  // Extra --mcp-config file (e.g. Playwright for the reviewer/UI gate, #684).
  const mcpFlag = mcpConfigPath ? ` --mcp-config ${JSON.stringify(mcpConfigPath)}` : ''
  // Extra --settings file: the obj-1059 PreToolUse worktree guard (#69). Fires even
  // under --dangerously-skip-permissions, blocking any isolated session from
  // editing the live checkout.
  const settingsFlag = settingsPath ? ` --settings ${JSON.stringify(settingsPath)}` : ''
  // Fall DOWN to Sonnet, never up to another Opus. Omit when the requested
  // model already IS the fallback so the CLI cannot bounce between two ids.
  const fallbackFlag = model === FALLBACK_MODEL_ID ? '' : ` --fallback-model ${FALLBACK_MODEL_ID}`
  return `${tokenPrefix}claude${resumeFlag} --print --output-format stream-json --include-partial-messages --verbose --dangerously-skip-permissions --max-budget-usd ${budget}${turnsFlag} --effort ${effortLevel}${fallbackFlag}${modelFlag}${mcpFlag}${settingsFlag}`
}
