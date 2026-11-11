// Vault ownership normalization.
//
// The Command Center server runs as ROOT inside its container (its Claude auth
// lives at /root/.claude, it owns the SQLite DB, and it needs the Docker socket).
// But the second-brain vault is bind-mounted from the host and is managed by the
// agent user `ccuser` (uid 1001). Any vault file this root process writes would
// otherwise be root-owned and unmanageable by Claude Code sessions (they run as
// ccuser) — which is exactly how ~200 root-owned files accumulated under
// second-brain/ (meetings, loops-archive, content) before 2026-06-20.
//
// Fix: after writing or creating any vault path, normalize its ownership to
// ccuser. Best-effort by design — a no-op when not running as root (local dev /
// CI) and swallows errors so ownership normalization can NEVER break a write.
// Mirrors the existing root-side `chown -R ccuser:ccuser` pattern in
// session-manager.ts (which normalizes the rotation home dirs).
import fs from 'fs'

const VAULT_UID = Number(process.env.VAULT_UID ?? 1001)
const VAULT_GID = Number(process.env.VAULT_GID ?? 1001)

/**
 * Chown a single vault path (file or dir) to the agent user. Safe to call on
 * every write: no-op unless the current process is root, and never throws.
 */
export function chownToVaultUser(p: string): void {
  try {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      fs.chownSync(p, VAULT_UID, VAULT_GID)
    }
  } catch {
    // best-effort — a failed chown must not surface as a write failure
  }
}
