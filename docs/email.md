# Transactional email

Every install sends a handful of account emails — a sign-in link, a new user's
invite, a temp-password reset. Out of the box there is **no sender configured**
and no central relay: a fresh install just shows the temp password on screen
instead of emailing it. Settings → Email lets the install owner connect **their
own** sender in a couple of minutes, and from then on those emails go out from
an address the owner controls.

There is no default third-party account and no Operation Kit / Example relay —
every install's mail goes out under its own name, from its own domain, using
its own provider credentials.

## What's configurable

| What | Where | Default |
|---|---|---|
| Provider | Settings → Email | none (not configured) |
| From name / address | Settings → Email | empty |
| Reply-to | Settings → Email | empty (falls back to from-address) |
| SMTP host / port / security / username | Settings → Email (SMTP only) | `587` / STARTTLS |
| Provider credential (SMTP password, Resend API key, Postmark server token) | Settings → Email, stored in the secrets store | none |
| Public app URL (used to build the links inside emails) | Settings → Email | empty |

## Providers

| Provider | Credential needed | Notes |
|---|---|---|
| **SMTP** (generic) | SMTP password | Works with any mailbox or relay you already have — Gmail/Workspace SMTP, your own Postfix, Mailgun's SMTP endpoint, a company relay. Security is TLS, STARTTLS or none (plain — only for a local sink in dev). |
| **Resend** | API key (Sending access) | HTTP API, no SMTP server to run. |
| **Postmark** | Server token | HTTP API, one token per Postmark "server". |

SES is not wired as its own adapter yet; use SES's SMTP endpoint through the
generic SMTP provider in the meantime.

Pick one in the panel, fill in from-name/from-address/reply-to and the
provider-specific fields, paste the credential, and click **Send test email**.

## Credentials: where they live

The **non-secret** half of the setup (provider, from name/address, SMTP host/
port/security/username, app URL, last test result) is a JSON blob in the
`settings` table (`email_config`).

The **credential** (SMTP password / Resend API key / Postmark server token)
goes through the existing secrets store — the same encrypted-at-rest
mechanism every other integration on this install uses — at **global scope**,
marked **service-only**. That means:

- it is **never returned by any API response**, including the Email panel's
  own `GET /admin/email` (which reports `configured: true/false`, not the
  value);
- it is **never logged**, by the mailer or by the test-send path;
- it is **never handed to an agent session** — service-only secrets are the
  server's own, not something a Claude/Codex/Grok session spawned on this
  install can read.

Rotating a credential is the same flow as adding it the first time: paste the
new value in the panel and save. Clearing the provider (switching provider, or
removing email entirely) deletes the stored credential.

## Sending path

`app/server/src/services/mailer/` is the whole module:

- `types.ts` — `EmailConfig`, `EmailProvider`, `SendResult` (always `{ ok, provider, ... }`, never throws past the mailer boundary).
- `config.ts` — load/save the non-secret config; read/write/clear the credential via the secrets store; `emailConfigProblems()` / `emailConfigured()` report exactly what's missing.
- `smtp.ts` — a small SMTP client (no external mail library) supporting TLS / STARTTLS / plain, AUTH LOGIN/PLAIN.
- `http-providers.ts` — Resend and Postmark adapters over their HTTP APIs.
- `templates.ts` — the three email bodies (sign-in link, invite, temp password), each with an HTML part **and a plain-text fallback**, and `currentBrand()` which pulls the install's brand name/logo from the branding config (Settings → Branding, sprint 3) so emails carry the install's own name and logo rather than a vendor's.
- `account-emails.ts` — `sendInvite` / `sendTempPassword` / `sendSignInLink`, the three call sites the rest of the app uses.
- `index.ts` — `sendMail()` dispatches to the configured provider; `dns-help.ts` builds the DNS help block (below).

No code here ever references a third-party relay account or a hardcoded
vendor API key — every call uses the install's own stored config and
credential, and a provider with no credential simply returns
`{ ok: false, code: 'not_configured' }`.

## Where email is used today, and the fallback

| Flow | Email sent | Fallback when not configured (or send fails) |
|---|---|---|
| New user invite (Settings → Workspaces → Users) | Invite with the temp password and a sign-in link | Temp password shown on screen, copyable, exactly like before this sprint |
| Password reset (admin resets a user's password) | Temp password email | Temp password shown on screen, copyable |
| Sign-in link ("Email me a sign-in link" on the login page) | One-time sign-in link, 15 minutes, single use | Link option doesn't appear / errors clearly; password sign-in is unaffected |

The admin UI (Users tab) checks `GET /admin/email` for `configured` before it
ever offers to email something, and still displays the temp password alongside
whatever happened with the email ("emailed to jane@…" or the email error plus
the password to hand over directly). A install that has never configured
email behaves exactly like one that predates this sprint.

## DNS help (SPF / DKIM / DMARC)

The panel's DNS tab (`GET /admin/email/dns`) explains, per provider, exactly
which records to add at your DNS host — in plain language, not a copy-pasted
vendor doc:

- **SPF** — authorizes the provider to send as your domain.
- **DKIM** — a signature proving the mail wasn't altered in transit; Resend/
  Postmark show you the exact value once you add the domain on their side.
- **DMARC** — what receiving mail servers should do with mail that fails SPF/
  DKIM (`p=none` to start, tightened later).

It also does a **live, read-only DNS lookup** of your current SPF and DMARC
records (no write access, nothing changes your DNS) so you can tell "not set
yet" from "already set to something else" at a glance.

## Setting it up (the easy path)

1. Settings → Email.
2. Pick a provider.
3. Fill in from-name, from-address, reply-to, and this install's public URL.
4. Paste the provider credential (SMTP password / API key / server token).
5. Follow the DNS tab's steps for your domain (add the records once, at your
   registrar/DNS host).
6. Click **Send test email** to an address you control. A result (sent / the
   exact error) shows immediately.

### Have your coding agent do it

The onboarding checklist's Email step includes a ready-to-paste prompt (via
the in-app **"Have your coding agent set up email"** box) that hands a coding
agent your provider choice and asks it to gather the credential and DNS
records for you and report back what to paste into the panel. It never asks
the agent to invent or guess a credential — only to gather what the provider's
own dashboard shows.

## Onboarding order

Settings → the setup checklist (`/setup`, and linked from the dashboard for a
fresh install) walks a new install through four steps, in this order:

1. **Branding** — name and logo shown everywhere, including in email (above).
2. **Transactional email** — this page.
3. **Add one coding subscription account** — connect a Claude/Codex/Grok
   subscription so agents can start working.
4. **Set up your knowledge base** — drop in existing documents at
   `/knowledge/setup`; see [the setup agent guide](knowledge-base/setup-agent.md).

Each step links straight to its settings panel (`/settings/branding`,
`/settings/email`, `/settings/models`) and ticks itself done once
`GET /admin/setup-status` reports it configured (branding can also be
explicitly "kept at default" without configuring anything).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Email is not set up: set this site's public URL" | `app_url` is empty — sign-in/invite links are built from this, never from a request's Host header, so it must be set explicitly. |
| Test send fails with an auth error | Credential is wrong, or (SMTP) the username is wrong — host/port being reachable is reported separately from auth failing. |
| DNS tab shows SPF/DMARC as "not found" after you just added them | DNS propagation; re-check in a few minutes. The panel's check is live, not cached. |
| Invite/password still only shows on screen, no email | `GET /admin/email` reports `configured: false` — finish the panel's required fields (see `emailConfigProblems()` above) and the next invite/reset will email automatically. |

## Testing

The suite never sends real mail: `smtp-sink.testkit.ts` runs an in-process
SMTP server the SMTP adapter connects to over `localhost`, and the HTTP
provider tests inject a fake `fetch`. CI and local `vitest run` never touch
the public internet or a real inbox. The same in-process sink is used for the
Mailpit-style evidence capture referenced in this objective's artifact.
