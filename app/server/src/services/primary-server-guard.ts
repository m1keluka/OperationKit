// Rogue-server guard (obj-1955).
//
// The primary command-center server (port 3002) must run ONLY from the deployed
// checkout under the entrypoint's supervision. On 2026-06-28 a session launched
// `tsx src/index.ts` from its `/tmp/cc-wt-2386-provenance` worktree; it bound :3002
// and ran for ~13h alongside the real server, so API-triggered restarts exited the
// wrong process and the entrypoint's child couldn't bind — a confusing partial outage.
//
// Structural fix without an entrypoint change (which would need a session-killing
// container restart): the server refuses to bind the PRIMARY port when it detects it
// is running from a session worktree. Throwaway/worktree servers (browser-verify etc.)
// already use a non-3002 PORT, so they are unaffected.

/** True if a path looks like a harness-created session worktree:
 *  /tmp/cc-wt-<id>, /tmp/cc-worktree-<id>, /home/operator/projects/cc-wt-<slug>, etc.
 *  The canonical deployed checkout (/app, …/command-center-infra) does NOT match. */
export function looksLikeWorktreePath(p: string): boolean {
  return /(?:^|\/)(?:cc-wt-|cc-worktree-)/.test(p)
}

/** Refuse to bind only when this IS the primary port AND the running code or cwd is a
 *  session worktree. `primaryPort` defaults to 3002. */
export function shouldRefusePrimaryBind(opts: {
  port: number
  primaryPort?: number
  moduleUrl: string
  cwd: string
}): boolean {
  const primary = opts.primaryPort ?? 3002
  if (opts.port !== primary) return false
  return looksLikeWorktreePath(opts.moduleUrl) || looksLikeWorktreePath(opts.cwd)
}
