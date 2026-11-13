# Branding your install

Every install ships with the Operation Kit brand 1.0 ("circle O") defaults —
Ultramarine accent on neutral GitHub-style surfaces, light theme by default
with a dark toggle, the OK wordmark/icon/favicon. You can re-brand without
touching code or rebuilding
the container: set env vars, drop in a config file, or use the
Settings > Branding admin panel.

## White-labeling = one accent + your logo

The UI follows the GitHub / enterprise-tool model (obj 900750): every page
background, card, sidebar, border and line of text is a **neutral grey** in
both light and dark mode, and the brand appears in exactly one place — the
**primary accent**. It is used for primary buttons, links, focus rings, the
selected-item marker and the "Needs you" state; never as a page, card or
sidebar fill.

So re-branding an install is:

1. Set the **accent** (one hex — env, config file or the Branding panel).
2. Upload a **wordmark / icon / favicon** (or leave the defaults).

That's it. The hover and pressed shades, the text-on-accent colour (white or
near-black, whichever reads better) and a per-theme **accent text** colour
that clears WCAG AA 4.5:1 on both the light and dark grounds are **derived**
from that one hex (`app/shared/brand-color.ts`, `deriveAccent`). Set any of
them explicitly only if you want to override the derivation — the panel shows
them as "Auto (from accent)" until you do.

## What's configurable

| What | Default |
|---|---|
| Product name | `Operation Kit` |
| Accent (primary) — **the one brand lever** | `#2B2BE8` (Ultramarine) |
| Accent hover / pressed | derived from the accent (`#2727C9` / `#2323A9` for the default) |
| Text-on-accent | derived (`#FFFFFF` for the default) |
| Success color (light, dark) — semantic, not brand | `#1A7F37` / `#3FB950` |
| Danger color (light, dark) — semantic, not brand | `#D1242F` / `#F85149` |
| Wordmark (light bg, dark bg) | shipped OK wordmark SVGs |
| Icon (sign-in mark, app icons) | shipped OK icon SVG |
| Favicon | shipped OK favicon |

Success / danger (plus warning `#9a6700` and info `#0969da`) are **status**
colours — they carry meaning, not brand, and most installs never change them
(the panel keeps them under "Advanced").

Everything else in the UI (neutral surfaces, text, hairlines, the status
pipeline, agent-identity colors) lives in CSS custom properties in
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
OK_BRAND_ACCENT=#1565C0          # the only one most installs need
# optional overrides — derived from the accent / semantic defaults if unset:
# OK_BRAND_ACCENT_HOVER=#0D47A1
# OK_BRAND_ACCENT_PRESS=#0A3880
# OK_BRAND_ACCENT_FG=#FFFFFF
# OK_BRAND_VERIFY=#1A7F37
# OK_BRAND_VERIFY_ON_DARK=#3FB950
# OK_BRAND_CAUTION=#D1242F
# OK_BRAND_CAUTION_ON_DARK=#F85149
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

The example sets only `name` and `accent` — that is all a white-label
install needs. Add a shade or status key only to pin it on purpose.

**Upgrading an older install.** Before the single-accent model the Branding
panel saved all eight tokens on every Save, so an older
`config/branding.json` may still hold the previous shipped defaults
(`accentHover #2727C9`, `accentPress #2323A9`, `accentFg #F3F0E8`,
`verify #0B7643`, `verifyOnDark #63D18F`, `caution #BD321B`,
`cautionOnDark #F47D67`). Those exact values are read as **unset**
(`LEGACY_DEFAULT_TOKENS` in `branding-config.ts`), so changing only the
accent still re-derives every shade, and the next panel Save removes them
from the file. Any other value you set by hand is kept.

### Settings > Branding panel

Sign in as an admin and open the Branding panel (exported from
`app/client/src/components/settings/BrandingPanel.tsx`; mounted at
`/dev/branding` for now — the settings-reorg work wires it into real
navigation). It shows a live preview as you edit, a **Reset to default**
button, and disables any field that's locked by an environment variable
(labeled "env-locked"). Saving writes `config/branding.json` through
`POST /api/branding` and applies the new tokens to the whole app immediately
— no restart needed for a panel-driven change. Save sends only what you
changed: shades left on "Auto" are cleared (derived from the accent), and a
status colour is written only when you edit it, so the defaults are never
frozen into the file.

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
