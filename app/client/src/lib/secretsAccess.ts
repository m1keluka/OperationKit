/**
 * Who may manage shared secrets + test credentials (obj 900681). Same rule as
 * the old Settings → Secrets tab gate: a global admin, or an admin of any
 * workspace. Personal secrets ("Mine") are for every signed-in user. The server
 * enforces scope on every /api/secrets call regardless.
 */
export function canManageSharedSecrets(user: { role?: string; workspaces?: { role: string }[] } | null | undefined): boolean {
  if (!user) return false
  return user.role === 'admin' || (user.workspaces?.some(w => w.role === 'admin') ?? false)
}
