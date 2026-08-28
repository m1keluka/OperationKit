/**
 * GitHub Account card — extracted from AccountSettings.tsx (behavior frozen).
 */
import type { UserGithubTokenSummary } from '@command-center/shared'
import { maskedToken, fmtDate } from './helpers'

export function GithubSection({
  loading,
  linked,
  summary,
  tokenInput,
  setTokenInput,
  linking,
  validating,
  handleLink,
  handleRevalidate,
  handleRevoke,
}: {
  loading: boolean
  linked: boolean
  summary: UserGithubTokenSummary | null
  tokenInput: string
  setTokenInput: (v: string) => void
  linking: boolean
  validating: boolean
  handleLink: () => void
  handleRevalidate: () => void
  handleRevoke: () => void
}) {
  return (
    <section className="rounded-lg border border-border bg-surface-raised p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-fg-0">GitHub Account</h2>
          <p className="mt-1 text-xs text-fg-3">
            Link a GitHub Personal Access Token so PRs for cards assigned to you are attributed to you
            — not to whoever created the card. Stored encrypted; only the last 4 characters are ever shown.
          </p>
        </div>
        {linked && (
          <span className="shrink-0 rounded-sm bg-status-review/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-status-review">
            linked
          </span>
        )}
      </div>

      {loading ? (
        <div className="text-sm text-fg-3">Loading…</div>
      ) : linked ? (
        <div className="space-y-4">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-fg-3">GitHub login</dt>
              <dd className="text-sm text-fg-0">{summary!.github_login}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-fg-3">Author email</dt>
              <dd className="text-sm text-fg-0 break-all">{summary!.github_email}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-fg-3">Token</dt>
              <dd className="font-mono text-sm text-fg-1">{maskedToken(summary!.token_last4)}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-fg-3">Last validated</dt>
              <dd className="text-sm text-fg-1">{fmtDate(summary!.last_validated_at)}</dd>
            </div>
          </dl>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              onClick={handleRevalidate}
              disabled={validating}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-fg-1 transition-colors duration-fast ease-out hover:bg-surface-2 hover:text-fg-0 disabled:opacity-50"
            >
              {validating ? 'Re-validating…' : 'Re-validate'}
            </button>
            <button
              onClick={handleRevoke}
              className="rounded-md border border-signal-alarm/40 px-3 py-1.5 text-sm text-signal-alarm transition-colors duration-fast ease-out hover:bg-signal-alarm/10"
            >
              Revoke
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <label htmlFor="gh-pat" className="block text-xs text-fg-2">
            Personal Access Token
          </label>
          <input
            id="gh-pat"
            type="password"
            autoComplete="off"
            value={tokenInput}
            onChange={e => setTokenInput(e.target.value)}
            placeholder="github_pat_… or ghp_…"
            className="w-full rounded border border-border bg-surface px-2.5 py-2 font-mono text-sm text-fg-0 outline-none focus:border-accent"
          />
          <p className="text-[11px] text-fg-3">
            Use a fine-grained PAT scoped to your your-org repos with Contents and Pull requests
            read/write. If your org uses SSO, authorize the token for the your-org org.
          </p>
          <button
            onClick={handleLink}
            disabled={linking || tokenInput.trim().length === 0}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-fg-0 transition-colors duration-fast ease-out hover:bg-accent-hover disabled:opacity-50"
          >
            {linking ? 'Validating…' : 'Link GitHub'}
          </button>
        </div>
      )}
    </section>
  )
}
