# Card browser lockdown (Playwright / Chromium)

Review and QA sessions drive a real Chromium through
[Playwright MCP](https://github.com/microsoft/playwright-mcp) to look at pages —
"open the preview and tell me whether the button renders". That browser runs
**inside the app's own container**, next to the secrets store, the AI seat
logins and the SQLite database. So the browser is a boundary: whatever a page
can do to Chromium, it starts out being able to do to that container.

This page is what that boundary is, how to configure it, and how to move the
browser forward when a Chromium advisory lands.

## Why it matters, concretely

A bundled browser is always behind the browser you use. Playwright ships a
Chromium build with each release and that build ages until the next one:

| Playwright | bundles Chromium (revision) | notes |
| --- | --- | --- |
| 1.64.1 | 156.0.8078.4 (1248) | behind Chrome 156 Extended Stable (156.0.8078.88) and the whole 157 stable line |
| 1.65.0 (2026-11-05) | 158.0.8127.18 (1254) | **pinned** — a newer major than current stable 157 |
| 1.65.1 | 159.0.8154.6 (1255) | not pinned: no `@playwright/mcp` release yet bundles a playwright-core that expects this revision |

What was verified, and where (2026-11-13):

* **Bundled builds** — read from the `package/browsers.json` inside each official
  `playwright-core` npm tarball (`npm pack playwright-core@<v>`), not from any
  third-party summary.
* **Chrome stable** — Google's version-history API
  (`versionhistory.googleapis.com/v1/chrome/platforms/linux/channels/stable/versions`)
  lists 157.0.8103.38 → .50 → .78 (serving since 2026-11-11). The Chrome Releases
  blog announced 157.0.8103.38 on 2026-11-03 as the stable promotion with a large
  batch of security fixes, and Extended Stable 156.0.8078.88 the same day. So
  Playwright 1.64.1's 156.0.8078.4 is behind **both** supported channels and lacks
  every security fix shipped in them since that build was cut.
* **Not verified** — the individual CVE IDs named in the social-media post that
  prompted this work (the post was not retrievable), and a per-CVE mapping for
  158.0.8127.18 (it is a pre-stable build; fixes land on trunk first, but no
  advisory states which ones it carries). The load-bearing fact is the version
  comparison above, and the defence that does not depend on it is the sandbox +
  egress guard below.

Historically this install made that much worse in two ways:

* Chromium was launched with **`--no-sandbox`**, unconditionally. The OS sandbox
  is the thing that turns "the renderer was compromised" into "the renderer was
  compromised, and that is where it stops". Without it, a renderer exploit is
  immediately code execution as the session user.
* There was **no origin policy at all**. The browser could reach the cloud
  instance-metadata endpoint (`169.254.169.254`), every service on the private
  network, and anything else it was pointed at — including by a redirect from a
  page that looked harmless.

## What it does now

**The OS sandbox stays on.** `--no-sandbox` is passed only if an operator
explicitly sets `BROWSER_SANDBOX="off"`, and that choice is logged at boot and
reported by `install/verify.sh`. The image makes Chromium's `chrome_sandbox`
helper setuid-root so the sandbox works for the unprivileged session account.

**The browser is not root.** Sessions — and therefore the browser — run as the
unprivileged `ccuser` account (`runuser -u ccuser`), never as uid 0.

**Egress is restricted, by a real boundary.** Two layers, and the distinction
matters:

| Layer | What it is | Why it is not enough on its own |
| --- | --- | --- |
| Playwright's `--allowed-origins` / `--blocked-origins` | route interception inside the page | Playwright's own help text says it "*does not* serve as a security boundary and *does not* affect redirects" |
| The **egress guard** (`app/server/src/services/browser-egress-proxy.ts`) | a loopback HTTP/CONNECT proxy Chromium is pointed at with `--proxy-server` | — it is the boundary |

Chromium cannot open an http/https socket without going through the guard, and
the guard re-checks **every** hop, including each hop of a redirect chain. It
also pins DNS: the name is resolved once, the decision is made against those
addresses, and the socket is opened to *that address* — so a name that answers
a public address on the first lookup and `169.254.169.254` on the second cannot
win the race.

The guard fails **closed**. An unresolvable name, an unparseable request, a
policy error — all end in a refusal. And if the guard is supposed to be running
and is not, the server declines to register Playwright for the session at all
rather than handing it an unrestricted browser.

**Versions are pinned.** `@playwright/mcp@latest` used to be re-resolved at
every single session spawn. Both versions now live in exactly two places —
`app/server/src/lib/browser-pins.ts` and the `ARG` lines in `app/Dockerfile` —
and `browser-pins.test.ts` fails CI if those two disagree.

## What the browser may reach, out of the box

* this install's own site (`DOMAIN` in `client.conf`)
* anything on `localhost` / `127.0.0.1` / `[::1]` — the preview servers sessions
  start, which is what preview review depends on

Everything else is refused, including the cloud metadata endpoint and the whole
private network, and every refusal is logged as
`[card-browser] BLOCKED <target>: <reason>`.

## Configuring it (`client.conf`)

```sh
# Extra sites your reviews need. ";"-separated; a leading *. matches sub-domains.
BROWSER_ALLOWED_ORIGINS="https://*.vercel.app;https://staging.example.com"

# Refused even if a rule above would allow them. Checked first, so it always wins.
BROWSER_BLOCKED_ORIGINS=""

# Reach other machines on this server's private network (10.x / 192.168.x / 172.16-31.x).
BROWSER_ALLOW_PRIVATE_NETWORK="off"

# Open http://localhost:… — needed for preview review.
BROWSER_ALLOW_LOOPBACK="on"

# Chromium's operating-system sandbox. Do not turn this off.
BROWSER_SANDBOX="on"
```

Re-run `sudo ./install.sh --config client.conf` (or `install/update.sh`) to
apply. The cloud metadata endpoint has **no** `client.conf` switch: it is
blocked by host AND by resolved address, and the only override is the
`CARD_BROWSER_ALLOW_METADATA` environment variable, which exists so the block
is testable, not so it is convenient.

### The full environment surface

| Variable | Default | Effect |
| --- | --- | --- |
| `CARD_BROWSER_SANDBOX` | `on` | keep Chromium's OS sandbox |
| `CARD_BROWSER_EGRESS_GUARD` | `on` | run the loopback proxy and point Chromium at it |
| `CARD_BROWSER_ALLOWED_ORIGINS` | *(empty)* | extra allowed origin patterns, `;`-separated |
| `CARD_BROWSER_BLOCKED_ORIGINS` | *(empty)* | extra blocked origin patterns |
| `CARD_BROWSER_ALLOW_LOOPBACK` | `on` | allow `localhost`/loopback destinations |
| `CARD_BROWSER_ALLOW_PRIVATE_NETWORK` | `off` | allow RFC1918 / CGNAT / link-local |
| `CARD_BROWSER_ALLOW_METADATA` | `off` | allow cloud instance metadata |
| `CARD_BROWSER_PROXY_PORT` | `3099` | loopback port the guard binds |

## Proving it

```sh
sudo bash install/verify.sh --config client.conf
```

Check 9 asserts, live and through the same proxy Chromium uses, that:

* the OS sandbox is on
* the browser's user is `ccuser`, not root
* the guard is listening
* `http://169.254.169.254/` is refused (**403**)
* an off-allowlist site is refused (**403**)
* an **allowed** origin still loads (**200**) — the other direction matters just
  as much; a policy that breaks preview review has not secured anything
* Playwright is pinned to a version, not `latest`

The same rules are unit-tested, with real sockets, in
`app/server/src/services/browser-egress-proxy.test.ts`, and the policy itself in
`app/server/src/lib/browser-policy.test.ts`.

Ad hoc, on a running install:

```sh
docker exec command-center curl -s -H "X-Internal-Secret: $INTERNAL_API_SECRET" \
  http://127.0.0.1:3002/api/internal/install/browser-status | jq
```

## Updating the card browser

Pinning makes the update an explicit act. When a Chromium advisory lands:

1. See what is out:
   ```sh
   npm view playwright version
   npm view @playwright/mcp version
   ```
2. See which Chromium a Playwright release bundles — read it from the release's
   own tarball, not from a summary:
   ```sh
   npm pack playwright-core@<version> --pack-destination /tmp >/dev/null
   tar -xzOf /tmp/playwright-core-<version>.tgz package/browsers.json \
     | jq -r '.browsers[] | select(.name=="chromium") | .browserVersion'
   ```
3. Compare that against the Chrome stable version in the advisory
   ([Chrome Releases](https://chromereleases.googleblog.com/)). You want a build
   **at or above** the fixed Chrome stable version.
4. Pick the `@playwright/mcp` release whose OWN `playwright-core` dependency
   expects the same Chromium revision — that copy is what speaks CDP to the
   browser, and it ships as an alpha of the next Playwright minor:
   ```sh
   npm view @playwright/mcp@<version> dependencies          # → playwright-core@<x>
   npm pack playwright-core@<x> --pack-destination /tmp >/dev/null
   tar -xzOf /tmp/playwright-core-<x>.tgz package/browsers.json \
     | jq -r '.browsers[] | select(.name=="chromium") | .revision'
   ```
   If no MCP release matches yet, stay on the previous Playwright pin.
5. Bump the versions in **both** places — CI fails the PR if you only do one:
   * `app/Dockerfile` → `ARG PLAYWRIGHT_VERSION` / `ARG PLAYWRIGHT_MCP_VERSION`
   * `app/server/src/lib/browser-pins.ts` → `PLAYWRIGHT_VERSION`,
     `PLAYWRIGHT_MCP_VERSION`, `CHROMIUM_VERSION`, `CHROMIUM_REVISION`
6. Ship it, then rebuild and re-verify on the install:
   ```sh
   sudo bash install/update.sh --config client.conf
   sudo bash install/verify.sh --config client.conf
   ```
   `update.sh` prints the versions the install is now actually running.

## Residual risk (not hidden)

* **Loopback is allowed by default**, because preview review needs it. A
  compromised browser can therefore reach the app on `127.0.0.1:3002` — which
  still has to get past the app's own auth, but is a bigger surface than the
  public internet. An install that never previews locally should set
  `BROWSER_ALLOW_LOOPBACK="off"`; the guard then forces loopback back through
  itself (`--proxy-bypass <-loopback>`) rather than letting Chromium's default
  bypass apply.
* **The browser still shares the app's container.** The sandbox and the egress
  guard are the controls; container separation is not. Moving the browser into
  its own secret-free container is the structural fix and is a separate change —
  it needs a `docker-compose.yml` mount change, which is a rebuild.
* **Non-proxied protocols.** The guard covers http/https, which is what
  Playwright MCP navigates. WebRTC and raw DNS are not proxied by Chromium's
  `--proxy-server`.
* **Sandboxed (`SESSION_ISOLATION=docker`) sessions have no browser at all** —
  the MCP overlay is dropped in jail mode. That path is unaffected by everything
  on this page, and is already secret-free.
