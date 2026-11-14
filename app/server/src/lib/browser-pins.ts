/**
 * browser-pins.ts — the ONE place the card browser's versions are declared.
 *
 * Before obj 900024 nothing was pinned: `app/Dockerfile` ran
 * `npm install -g playwright @playwright/mcp` and the MCP config launched
 * `npx -y @playwright/mcp@latest`. Two consequences, both bad:
 *
 *   * Un-reproducible. Two installs built a week apart ran different browsers,
 *     and `@latest` re-resolved at EVERY session spawn — so a session could
 *     silently pull a new major of the MCP server mid-incident.
 *   * Un-auditable. "Which Chromium are we exposed on?" had no answer short of
 *     exec'ing into the container, which is exactly the question an advisory
 *     like the Chrome 157 security release makes urgent.
 *
 * Pinning also makes the UPDATE an explicit, reviewable act: bump the three
 * constants here, bump the matching ARG lines in `app/Dockerfile`, rebuild.
 * `browser-pins.test.ts` fails the gate if those two drift apart, so there is
 * no way to update one and forget the other.
 *
 * ── Updating (see also docs/wiki/Card-Browser-Lockdown.md) ──────────────────
 *   1. `npm view playwright version` and `npm view @playwright/mcp version`
 *   2. Check which Chromium the release bundles:
 *        npm view playwright-core@<version> dist.tarball
 *        … then read `package/browsers.json` → browsers[name=chromium].browserVersion
 *   3. Pick the @playwright/mcp release whose own playwright-core dependency
 *      expects the same Chromium revision (see PLAYWRIGHT_MCP_VERSION).
 *   4. Update the constants below AND the ARGs in app/Dockerfile.
 *   5. `bash install/update.sh --config client.conf` (rebuilds the image), then
 *      `bash install/verify.sh --config client.conf` (proves sandbox + policy).
 */

/** npm `playwright` / `playwright-core` version installed in the image. */
export const PLAYWRIGHT_VERSION = '1.65.0'

/**
 * npm `@playwright/mcp` version the MCP config launches. Never `latest`.
 *
 * @playwright/mcp ships its OWN playwright-core (an alpha of the next minor),
 * and that copy is what speaks CDP to the browser. Pick an MCP release whose
 * bundled playwright-core expects the SAME Chromium revision PLAYWRIGHT_VERSION
 * installs (`CHROMIUM_REVISION` below), so the protocol client and the browser
 * were built for each other. Verified 2026-11-13 from the npm tarballs:
 *   @playwright/mcp@0.0.84 → playwright-core 1.65.0-alpha-2026-10-30 → rev 1252 (157.0.8103.15)  ✗
 *   @playwright/mcp@0.0.85 → playwright-core 1.66.0-alpha-2026-11-09 → rev 1254 (158.0.8127.18)  ✓
 */
export const PLAYWRIGHT_MCP_VERSION = '0.0.85'

/** Chromium revision (`browsers.json` → chromium.revision) of PLAYWRIGHT_VERSION. */
export const CHROMIUM_REVISION = '1254'

/**
 * The Chromium build `PLAYWRIGHT_VERSION` downloads, for auditing against
 * Chrome's security releases. Informational — Playwright picks the build — but
 * asserted by the tests so a version bump cannot leave a stale claim behind.
 *
 * Provenance (verified 2026-11-08, from the official npm tarballs' own
 * `browsers.json`, not from any third-party summary):
 *   playwright-core@1.64.1 → chromium 156.0.8078.4   (revision 1248)
 *   playwright-core@1.65.0 → chromium 158.0.8127.18  (revision 1254)
 * Chrome stable 157.0.8103.38 (2026-11-03) was a security release, so the
 * 1.64.1 build predates those fixes and 1.65.0's does not.
 */
export const CHROMIUM_VERSION = '158.0.8127.18'

/** The last Playwright release whose Chromium is known to be behind Chrome stable. */
export const KNOWN_VULNERABLE_PLAYWRIGHT_BELOW = '1.65.0'
