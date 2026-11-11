# Branding your install

Every install ships with the Operation Kit brand 1.0 ("circle O") defaults —
Ultramarine accent, light theme by default with a dark toggle, the OK
wordmark/icon/favicon. You can re-brand without touching code or rebuilding
the container: set env vars, drop in a config file, or use the
Settings > Branding admin panel.

## What's configurable

| What | Default |
|---|---|
| Product name | `Operation Kit` |
| Accent (primary) | `#2B2BE8` (Ultramarine) |
| Accent hover / pressed | `#2727C9` / `#2323A9` |
| Text-on-accent | `#F3F0E8` |
| Verify / done color (light, dark) | `#0B7643` / `#63D18F` |
| Caution / blocked color (light, dark) | `#BD321B` / `#F47D67` |
| Wordmark (light bg, dark bg) | shipped OK wordmark SVGs |
| Icon (sign-in mark, app icons) | shipped OK icon SVG |
| Favicon | shipped OK favicon |

Everything else in the UI (surfaces, text, hairlines, status pipeline,
agent-identity colors) is derived from these via CSS custom properties in
`app/client/src/index.css` — there is no other hardcoded brand color to hunt
down; Tailwind's color theme (`app/client/tailwind.config.ts`) resolves every
utility class (`bg-surface-0`, `text-accent`, …) to the same custom
properties, for both light and dark (`[data-theme="dark"]`).

## Precedence (highest wins)

1. **Environment variables** — set at the OS/container/compose level; these
   cannot be overridden by the panel or the config file. Good for a fixed,
   ops-managed deploy.
2. **`config/branding.json`** — gitignored, per-install runtime state (a
   committed `config/branding.json.example` documents the shape). The
   Settings > Branding admin panel writes this file. A server **restart is
   enough** — no rebuild — because it's read fresh from the mounted source
   tree on every request (see "no-rebuild" below for the one exception).
3. **Built-in Operation Kit brand 1.0 defaults.**

### Environment variables

```bash
OK_BRAND_NAME=Acme Operations
OK_BRAND_ACCENT=#1565C0
OK_BRAND_ACCENT_HOVER=#0D47A1
OK_BRAND_ACCENT_PRESS=#0A3880
OK_BRAND_ACCENT_FG=#FFFFFF
OK_BRAND_VERIFY=#0B7643
OK_BRAND_VERIFY_ON_DARK=#63D18F
OK_BRAND_CAUTION=#BD321B
OK_BRAND_CAUTION_ON_DARK=#F47D67
```

A color value must be a valid `#rrggbb`/`#rgb` hex string — anything else is
silently rejected and the next source in the precedence chain is used
instead (this is also how the server refuses an injected non-color value).

### Config file

```bash
cp config/branding.json.example config/branding.json
# edit config/branding.json, then restart the backend:
bash scripts/self-deploy.sh backend   # or: docker compose restart command-center
```

### Settings > Branding panel

Sign in as an admin and open the Branding panel (exported from
`app/client/src/components/settings/BrandingPanel.tsx`; mounted at
`/dev/branding` for now — the settings-reorg work wires it into real
navigation). It shows a live preview as you edit, a **Reset to default**
button, and disables any field that's locked by an environment variable
(labeled "env-locked"). Saving writes `config/branding.json` through
`POST /api/branding` and applies the new tokens to the whole app immediately
— no restart needed for a panel-driven change.

## Logos, icon & favicon

Upload a wordmark (full logo, optionally a separate dark-background variant),
an icon (square mark — used on the sign-in page and to derive the favicon/app
icons), and/or a favicon, from the Branding panel. SVG, PNG or ICO, 2MB max.
Uploads land in the install's data dir (next to the SQLite DB, under
`branding/`) and are served from `GET /api/branding/{wordmark,wordmark-dark,icon,favicon}`
— falling back to the shipped Operation Kit default for any slot you haven't
set. Clear a slot in the panel to revert just that asset to the default.

## "No rebuild if feasible"

Env vars and `config/branding.json` take effect on a **backend restart**
(`mode=backend`/`both` in `self-deploy.sh` — tmux sessions survive, the
frontend doesn't rebuild). Logo uploads and panel saves take effect
**immediately**, no restart. The one thing that needs a full frontend build is
changing `app/client/index.html`'s pre-React skeleton colors or the default
favicon data URI baked there for the very first paint — that's cosmetic
(it's replaced the instant React mounts and `/api/branding` resolves) and not
part of the normal re-branding flow above.

## Have your coding agent set this up

Paste this into Claude Code (or any coding agent) with this repo open — also
available as a copy-paste button in the Branding panel:

> Here is my company website: `<your company website URL>`. Read the brand
> colors and logo from it and configure Operation Kit branding (env/config
> file + logo files) per docs/branding.md.

A capable agent will: fetch the site, pick out the primary brand color (and
a sensible hover/pressed shade), grab the logo/favicon assets, and either set
`OK_BRAND_*` env vars or write `config/branding.json`, plus drop the logo
files via the Branding panel's upload endpoints (`POST
/api/branding/upload/{wordmark,wordmark-dark,icon,favicon}`) or directly into
the install's `branding/` data directory.

## Custom domain

Branding is independent of which domain serves the install. See
[docs/custom-domain.md](./custom-domain.md) for DNS, Cloudflare Tunnel and
Access setup — that's also linked from the Branding panel.
