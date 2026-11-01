import { useAuth } from '../context/AuthContext'
import { useBranding } from '../hooks/useBranding'
import { BrandMark } from './BrandMark'
import { Button } from './ui'

/**
 * Cloudflare Access verified this person's email, but no Operation Kit user has
 * it (obj 720332). Never an auto-created account: say so plainly, and offer the
 * two ways out — sign out of Cloudflare to use another email, or the password
 * form (break-glass for an admin whose email is not linked yet).
 */
export function NoAccountPage() {
  const { accessDenied, showPasswordLogin } = useAuth()
  const branding = useBranding()
  if (!accessDenied) return null
  const ambiguous = accessDenied.code === 'ambiguous_account'

  return (
    <div className="flex h-full items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <BrandMark branding={branding} />
        </div>

        <div role="alert" className="space-y-4 rounded-lg border border-border bg-surface-raised p-6">
          <h1 className="text-base font-semibold text-fg-0">
            {ambiguous ? 'This email is on more than one account' : 'No account for this email'}
          </h1>
          <p className="text-sm text-fg-1">
            You signed in to Cloudflare as{' '}
            <span className="break-words font-medium text-fg-0">{accessDenied.email}</span>
            {ambiguous
              ? ', but more than one account uses that email, so we cannot tell which one is yours.'
              : ', but nobody here has an account with that email.'}
          </p>
          <p className="text-sm text-fg-2">
            Ask your admin to {ambiguous ? 'fix the email on those accounts' : 'add you, or link this email to your account'} in
            Settings → Users.
          </p>

          <div className="flex flex-col gap-2 pt-1">
            <Button variant="primary" className="w-full" onClick={() => window.location.assign(accessDenied.logoutUrl)}>
              Sign out and use another email
            </Button>
            <Button variant="ghost" className="w-full" onClick={showPasswordLogin}>
              Sign in with a username and password
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
