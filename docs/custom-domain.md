# Custom domain & DNS

This covers what the installer already automates for a client's own domain,
and the one thing it does **not** automate (the zone needs to already be on
Cloudflare).

## What `install.sh` does for you

Everything below runs when `client.conf` sets `DOMAIN` + `ZONE` (and the
install isn't `--skip-cloudflare` / local-only).

1. **Config keys.** `DOMAIN` and `ZONE` set the address — `DOMAIN` must equal
   `ZONE` itself or sit under it (`install/lib.sh:111-113`). The zone must
   already be live on Cloudflare: the installer looks up the zone and account
   ID with `GET /zones?name=ZONE` (`install/cloudflare.sh:14,191`). Unless the
   install is local-only, you also need `ACCESS_ALLOWED_EMAILS` or
   `ACCESS_ALLOWED_EMAIL_DOMAIN` set (`install/lib.sh:121-122`) — otherwise
   nobody could sign in. A subdomain delegated to Cloudflare by NS records
   still needs to resolve to a Cloudflare-managed zone; a subdomain served
   from a *different* DNS provider is manual setup, not something the
   installer does.

2. **Tunnel + DNS.** The installer creates or reuses a Cloudflare Tunnel named
   `ok-<CLIENT_SLUG>` and points it at `DOMAIN -> http://command-center:3002`,
   with everything else on the tunnel 404ing (`install/cloudflare.sh:598-611`).
   It stores the tunnel's connector token as `TUNNEL_TOKEN` in
   `secrets/stack.env`. It then adds a proxied `CNAME DOMAIN ->
   <tunnel-id>.cfargotunnel.com` (TTL auto). If `DOMAIN` already has a record
   pointing somewhere else, the installer **stops** rather than overwrite it —
   pass `--replace-dns` once you've confirmed with the client that the
   existing record can go (`install/cloudflare.sh:616-629`).

3. **Access (login gate).** The installer sets up a login method (one-time
   passcode, Google, or Microsoft) and a Cloudflare Access application on
   `DOMAIN` with two policies: "Allowed people" (your
   `ACCESS_ALLOWED_EMAILS`/`_EMAIL_DOMAIN`) and an "Install verify robot"
   service-token policy the installer's own health checks use. It also
   creates a second Access app, "Operation Kit API (key auth)", with a
   Bypass policy over the paths in `install/api-bypass-paths.conf` — so an
   agent holding a `cc_live_` API key can call `/api/*` without a browser
   login. It adds exactly one zone Configuration Rule turning off Browser
   Integrity Check (`bic: false`), scoped ONLY to `DOMAIN/api/`
   (`install/bic-lib.sh`), and stores `OK_CF_ACCESS_TEAM` / `OK_CF_ACCESS_AUD`
   (the team domain + Access app AUD tag) so the running app can verify
   Cloudflare's signed identity on every request.

4. **No open ports, no certificate to manage.** Docker Compose publishes the
   app only on `127.0.0.1` and the internal Docker bridge — there is nothing
   listening on a public port, and no TLS certificate to issue or renew on
   the server; Cloudflare terminates TLS and tunnels the connection in.
   `cloudflared` runs as the `tunnel` compose profile. Pass
   `--skip-cloudflare` to install fully local (no tunnel, no DNS, no Access;
   `OK_CF_ACCESS_TEAM`/`_AUD` are cleared).

5. **Changing the domain later.** Changing `DOMAIN` in `client.conf` and
   re-running `install.sh` does **not** clean up the old CNAME, the old
   Access app, or the old Configuration Rule — those are left in place for
   you to remove by hand in the Cloudflare dashboard.

## Verifying it worked

`install/verify.sh` (or `install.sh`'s own post-install check) confirms:

- `cloudflared` is up and connected (checks the `tunnel` compose service).
- A stranger hitting `https://DOMAIN/` with no cookie is bounced to
  `cloudflareaccess.com` (the Access login gate is actually in front of the
  site, not just configured).
- `/api/health` returns 200 using the installer's own robot service-token
  pass, and a plain login attempt reports `no_email` — proof the app is
  verifying Cloudflare's signed identity token end-to-end, not just trusting
  the hostname.
- `/api/objectives` with no key returns a 401 **from the app** (bypassed
  through Access for API callers), while `/api/internal`, `/api/admin/seats`,
  `/api/secrets` and `/api/auth/token` are still gated by the browser Access
  login (not on the API bypass list) — and a Cloudflare error 1010 (bot
  block) is reported as its own distinct failure, not lumped in with a 401.
- `/api/branding` returns your configured `BRAND_NAME` — see
  [docs/branding.md](./branding.md) for how to set that.

Run it any time after install to confirm the domain, tunnel and Access setup
are all still wired correctly:

```bash
bash install/verify.sh --config client.conf
```

## Quick checklist for a new client domain

1. Confirm the apex zone (e.g. `client.com`) is already an active zone in
   the Operation Kit Cloudflare account (or transferred/delegated to it).
2. Set `DOMAIN` (e.g. `ops.client.com`) and `ZONE` (`client.com`) in
   `client.conf`.
3. Set `ACCESS_ALLOWED_EMAILS` or `ACCESS_ALLOWED_EMAIL_DOMAIN`.
4. Run `install.sh` (or `install/cloudflare.sh up --config client.conf`
   standalone, with `--dry-run` first if you want to see the plan before it
   touches anything).
5. Run `bash install/verify.sh --config client.conf` and confirm every check
   passes.
6. If `DOMAIN` already had an unrelated DNS record, re-run with
   `--replace-dns` only after confirming with the client.

See also: [docs/branding.md](./branding.md) for re-branding the UI the
domain serves, and `INSTALL.md` for the full install walkthrough.
