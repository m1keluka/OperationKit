/**
 * Numbered setup steps for the guided-OAuth wizard (obj 900506, Sprint 7.2).
 * One entry per connector id covered by the Sprint 7.2 scope; content mirrors
 * each connector's `docs/connectors/guides/<id>.md` walkthrough, minus the
 * redirect-URI and scope list (the wizard renders those from the server's
 * `oauth_setup`, pre-filled and copy-ready, instead of repeating them in prose).
 *
 * A connector with `auth_path: 'oauth_guided'` but no entry here still gets a
 * usable (generic) wizard — see `genericSteps()` below — so a newly preloaded
 * guided-OAuth connector is never left with an empty walkthrough.
 */

export interface WizardStep {
  title: string
  detail: string
}

const WIZARD_STEPS: Record<string, WizardStep[]> = {
  slack: [
    { title: 'Create a Slack app', detail: 'Go to api.slack.com/apps and click "Create New App → From scratch".' },
    { title: 'Add the redirect URL', detail: 'Under OAuth & Permissions, paste the redirect URI below into "Redirect URLs".' },
    { title: 'Add the bot token scopes', detail: 'Under Scopes → Bot Token Scopes, add the scopes listed below.' },
    { title: 'Copy the app credentials', detail: 'Under Basic Information, copy the Client ID and Client Secret.' },
    { title: 'Save the credentials and connect', detail: 'Add them in Settings → Secrets as SLACK_OAUTH_CLIENT_ID / SLACK_OAUTH_CLIENT_SECRET, then click "Add to Slack" below.' },
  ],
  'google-workspace': [
    { title: 'Configure the server’s OAuth app', detail: 'Make sure GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are set in Settings → Secrets — until then this connector shows as unavailable.' },
    { title: 'Check the redirect URI is registered', detail: 'Confirm the redirect URI below is added to that Google Cloud OAuth client’s "Authorized redirect URIs".' },
    { title: 'Click Sign in with Google', detail: 'Use the button below to start the sign-in.' },
    { title: 'Approve the requested scopes', detail: 'Approve the scopes listed below (Gmail, Calendar, Drive) on Google’s consent screen.' },
  ],
  'microsoft-365': [
    { title: 'Register an Azure AD app', detail: 'Sign in to portal.azure.com → Azure Active Directory → App registrations → New registration.' },
    { title: 'Add the redirect URI', detail: 'Add the redirect URI below as a Web platform redirect URI.' },
    { title: 'Create a client secret', detail: 'Under Certificates & secrets, create a new client secret and copy its value immediately (it is shown once).' },
    { title: 'Add the Graph permissions', detail: 'Under API permissions, add the Microsoft Graph delegated scopes listed below.' },
    { title: 'Save the credentials and connect', detail: 'Add the Application (client) ID and secret in Settings → Secrets as MICROSOFT_365_OAUTH_CLIENT_ID / _SECRET, then click "Sign in with Microsoft" below.' },
  ],
  hubspot: [
    { title: 'Create a HubSpot developer app', detail: 'Go to developers.hubspot.com/get-started and create an app under your own HubSpot account.' },
    { title: 'Add the redirect URL', detail: 'Under the app’s Auth tab, add the redirect URI below.' },
    { title: 'Add the scopes', detail: 'Add the scopes listed below to the app.' },
    { title: 'Copy the app credentials', detail: 'Copy the app’s Client ID and Client secret.' },
    { title: 'Save the credentials and connect', detail: 'Add them in Settings → Secrets as HUBSPOT_OAUTH_CLIENT_ID / _SECRET, then click "Connect HubSpot" below.' },
  ],
  discord: [
    { title: 'Create a Discord application', detail: 'Go to discord.com/developers/applications and create a new application.' },
    { title: 'Add the redirect URL', detail: 'Under OAuth2 → General, add the redirect URI below.' },
    { title: 'Copy the app credentials', detail: 'Copy the Client ID, and under OAuth2 → Client information, reset/copy the Client Secret.' },
    { title: 'Save the credentials and connect', detail: 'Add them in Settings → Secrets as DISCORD_OAUTH_CLIENT_ID / _SECRET, then click "Add to Discord" below and authorize the server(s) agents should use.' },
  ],
  intercom: [
    { title: 'Create an Intercom app', detail: 'Go to app.intercom.com/a/developer-signup (or your existing developer workspace) and create a new app.' },
    { title: 'Add the redirect URL', detail: 'Under Authentication, add the redirect URI below.' },
    { title: 'Copy the app credentials', detail: 'Copy the Client ID and Client Secret.' },
    { title: 'Save the credentials and connect', detail: 'Add them in Settings → Secrets as INTERCOM_OAUTH_CLIENT_ID / _SECRET, then click "Connect Intercom" below.' },
  ],
}

function genericSteps(name: string): WizardStep[] {
  return [
    { title: `Register your own ${name} OAuth app`, detail: `Create an OAuth app with ${name} under your own account — this install never uses a shared Example app.` },
    { title: 'Add the redirect URI', detail: 'Add the redirect URI below to the app’s allowed redirect/callback list.' },
    { title: 'Add the scopes', detail: 'Add the scopes listed below to the app.' },
    { title: 'Save the credentials and connect', detail: 'Copy the app’s client ID/secret into Settings → Secrets, then use the connect button below.' },
  ]
}

export function wizardStepsFor(connectorId: string, connectorName: string): WizardStep[] {
  return WIZARD_STEPS[connectorId] ?? genericSteps(connectorName)
}
