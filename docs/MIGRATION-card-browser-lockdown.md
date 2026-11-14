# Migration: card browser lockdown (obj 900024)

**Short version: existing installs need to do nothing.** The new defaults are
applied by the next `install.sh` / `install/update.sh` run, no data is migrated,
no setting is removed, and nothing already allowed on your install is taken away
*except* unrestricted browsing — which is the point of the change.

Read on only if (a) your reviews open a site that is not this install's own
domain and not localhost, or (b) the card browser stops working after the update.

## What changes on an existing install

| Before | After |
| --- | --- |
| Chromium launched with `--no-sandbox` | OS sandbox ON (`BROWSER_SANDBOX="on"`, the default) |
| Any origin reachable, including `169.254.169.254` and your LAN | Only this install's domain + localhost; metadata and private network refused |
| `@playwright/mcp@latest` resolved at every session spawn | Pinned: Playwright 1.65.0 / Chromium 158.0.8127.18 / `@playwright/mcp` 0.0.85 |
| No way to check any of the above | `install/verify.sh` check 9; `GET /api/internal/install/browser-status` |

The browser already ran as the unprivileged `ccuser` account; that is unchanged
and is now asserted rather than assumed.

## Steps

1. Update as usual:
   ```sh
   sudo bash install/update.sh --config client.conf
   ```
   The run ends by printing which Playwright/Chromium you are now on and whether
   the sandbox and the egress guard are up.

2. Prove it:
   ```sh
   sudo bash install/verify.sh --config client.conf
   ```
   Check 9 must be all-PASS. It tests both directions — that the metadata
   endpoint and an off-allowlist site are refused, **and** that an allowed
   origin still loads.

3. Only if your reviews open third-party sites, add them to `client.conf` and
   re-run `install.sh`:
   ```sh
   BROWSER_ALLOWED_ORIGINS="https://*.vercel.app;https://staging.example.com"
   ```

## If something broke

**"The reviewer has no browser tools any more."** The egress guard failed to
start, and the server fails *closed*: it would rather register no browser than
register an unrestricted one. Look for `[card-browser] egress guard failed to
start` in `docker logs command-center`. The usual cause is port 3099 already in
use — set `CARD_BROWSER_PROXY_PORT` to a free port.

**"A review says it cannot open <site>."** That is the allowlist doing its job.
The app log carries the exact refusal:
`[card-browser] BLOCKED https://site:443: … is not in the card browser's allowed origins`.
Add the origin to `BROWSER_ALLOWED_ORIGINS` if the site is one your team
legitimately reviews.

**"Chromium will not start at all."** The OS sandbox needs either unprivileged
user namespaces (present on stock Ubuntu 24.04) or the setuid `chrome_sandbox`
helper the image now installs. If a hardened host has disabled both, fix the
host — `BROWSER_SANDBOX="off"` is available but it removes the control this
change exists to add, and `verify.sh` will fail the install until you put it
back.

## Rolling back

`install/update.sh` already tags the previous images `operationkit-app:pre-update-<time>`
and prints the rollback commands. There is no schema change here, so a code
rollback is a complete rollback.

Full reference: [`docs/wiki/Card-Browser-Lockdown.md`](wiki/Card-Browser-Lockdown.md).
