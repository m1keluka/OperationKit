# You

Settings → **You** is the identity page. It is not Secrets and it is not Dashboard seats.

## API key

Generate. Copy. Paste into Grok Bot or any agent as `Authorization: Bearer cc_live_…`. We show the full key **once**. Generate new to rotate (old key dies). Revoke to kill it.

## GitHub

Paste a fine-grained PAT. PRs and commits on cards assigned to you use that login and email. Stored encrypted; only the last four characters come back. Revoke here *and* on GitHub.

## Google Workspace

Connect. Sessions acting as you send Gmail and touch Drive/Docs/Sheets/Slides/Calendar as that Google account. Disconnect revokes the grant.

If a card assigned to Ava used to send as Mike, the card had the wrong assignee or Ava was not connected. Assigned user wins; creator is the fallback.

## Assistant

Name, system prompt, autonomy (read-only → autonomous). Jarvis reads this.

## Personal secrets

Key/value, encrypted, never shown again. These are **yours**. Organization keys live on the Secrets tab. Both inject into the session env when a card starts. GitHub and Google inject the same way. There is no Doppler CLI in the session.
