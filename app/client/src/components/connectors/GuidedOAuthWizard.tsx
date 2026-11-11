/**
 * In-app guided-OAuth setup wizard (obj 900506, Sprint 7.2) for
 * `auth_path: 'oauth_guided'` connectors. Replaces "go read the vendor's
 * docs" with a numbered, copy-ready walkthrough: the install's own
 * server-computed redirect URI, the exact scopes to add, and 3-5 steps per
 * provider (see `oauthWizardSteps.ts`).
 *
 * Standalone component — mounted into the existing `ConnectorCard`, not a
 * rewrite of Settings → Integrations (#900496 owns that page/nav).
 *
 * Install-local by construction: `redirect_uri` comes straight from the
 * server's `oauth_setup` (computed from THIS install's own domain), so
 * nothing here depends on Example or any shared callback service.
 */
import { Badge, CopyButton, Modal } from '../ui'
import type { ConnectorSummary } from '@operationkit/shared'
import { wizardStepsFor } from './oauthWizardSteps'

export function GuidedOAuthWizard({
  connector: c,
  open,
  onClose,
}: {
  connector: ConnectorSummary
  open: boolean
  onClose: () => void
}) {
  const setup = c.oauth_setup
  const steps = wizardStepsFor(c.id, c.name)
  const titleId = `guided-oauth-wizard-title-${c.id}`

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} panelClassName="max-w-lg">
      <div className="max-h-[80vh] overflow-y-auto p-5 sm:p-6">
        <h2 id={titleId} className="font-display text-[17px] font-semibold tracking-[-0.01em] text-fg-0">
          Connect {c.name}
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-fg-2">
          This install owns its own {c.name} OAuth app — there is no shared Example app or central
          callback service. Follow the steps below on {c.name}’s own site, using the values here.
        </p>

        {setup && (
          <div className="mt-5 space-y-4">
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-[12px] font-medium uppercase tracking-wider text-fg-3">Redirect URI</span>
                <CopyButton value={setup.redirect_uri} />
              </div>
              <code className="block break-all rounded-md border border-line bg-surface-1 px-3 py-2 text-[12px] text-fg-0">
                {setup.redirect_uri}
              </code>
            </div>

            {setup.scopes.length > 0 && (
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-[12px] font-medium uppercase tracking-wider text-fg-3">Scopes to add</span>
                  <CopyButton value={setup.scopes.join(' ')} />
                </div>
                <ul className="flex flex-wrap gap-1.5" aria-label={`Scopes ${c.name} requests`}>
                  {setup.scopes.map(s => (
                    <li key={s}>
                      <Badge>{s}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <ol className="mt-5 space-y-4">
          {steps.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <span
                aria-hidden="true"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[12px] font-semibold text-accent"
              >
                {i + 1}
              </span>
              <div>
                <p className="text-[13px] font-medium text-fg-0">{step.title}</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-fg-2">{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>

        {c.setup_guide && (
          <p className="mt-5 text-[12px] text-fg-3">
            Full reference: <code className="text-fg-2">{c.setup_guide}</code>
          </p>
        )}
      </div>
    </Modal>
  )
}
