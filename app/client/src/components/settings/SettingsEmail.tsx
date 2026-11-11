/**
 * Settings → Email — slot reserved for sprint 5 (mailer / onboarding email).
 * That sprint owns the actual email settings; this is a placeholder so the
 * sprint 4b sidebar reorg has a stable spot for it to land in. Do not build
 * its contents here — mount sprint 5's component when it exists.
 */
import { Card, CardHeader, CardBody, Badge } from '../ui'

export function SettingsEmail() {
  return (
    <Card inset>
      <CardHeader title="Email" eyebrow={<Badge>Coming soon</Badge>} />
      <CardBody>
        <p className="text-[13px] leading-relaxed text-fg-2">
          Outbound mail (invites, onboarding, notifications) will be configured here. This panel is a reserved slot —
          the mailer settings themselves ship separately (sister sprint 5, mailer and onboarding).
        </p>
      </CardBody>
    </Card>
  )
}
