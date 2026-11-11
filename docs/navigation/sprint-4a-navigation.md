# Sprint 4a — Navigation + System page (obj 900495)

Status: PR only (not merged, not deployed). Sister card Sprint 4b owns the Settings pages and
the settings tab strip; Sprint 3 owns theme tokens / logo.

## 1. "More" removed — old item → new home

The "More" nav group (the desktop "More ▾" dropdown and the 5th mobile tab) is gone. Every item
it held now lives in the account (avatar) dropdown, which is the same menu on desktop and mobile.

| Old item (in "More") | Old URL | Who saw it | New home | New URL | Old URL still works? |
|---|---|---|---|---|---|
| Archive | `/archive` | everyone | Account dropdown → **Archive** (everyone) | `/archive` | unchanged |
| Agents | `/agents` | admin | Account dropdown → Admin → **Agents** (one page, tabbed) | `/agents` | unchanged |
| Templates | `/agent-templates` | admin | **Agents** page → *Templates* tab | `/agents?tab=templates` | redirects |
| Dashboard | `/dashboard` (+ alias `/costs`) | admin | Account dropdown → Admin → **System** | `/system` | `/dashboard` and `/costs` redirect |

Items that were never in "More" but move in this sprint:

| Old item | Old URL | New home | New URL | Old URL still works? |
|---|---|---|---|---|
| Settings → Agents (registry: roster, assignments, skill graph) | `/settings/agents` | **Agents** page → *Registry* tab (the second Agents page, condensed into one) | `/agents?tab=registry` | redirects |
| Settings → Platform (host cron, "No cron jobs found") | `/settings/platform` | **Jobs** page → *Host cron jobs* section, with an explanation of what it is | `/jobs#host-cron` | redirects |
| Dashboard "Subscription seats" list + "Accounts n/m" tile | on `/dashboard` | Settings → Models (Sprint 4b renames Seats → Models), reached by one link on System | `MODELS_SETTINGS_ROUTE` | n/a |
| ⌘K "Agent registry" | `/settings/agents` | ⌘K "Agent registry" | `/agents?tab=registry` | |

Unchanged primary nav: **Bots** (when built in), **Board**, **Knowledge base**, **Jobs** (admin).
The mobile bottom bar is now just those ≤4 tabs; everything else is one tap away in the avatar menu.

### Account dropdown (after)

```
<name>  [admin]
──────────────
Settings
Archive
ADMIN                  (global admins only)
System
Agents
──────────────
Logout
```

## 2. Dashboard → System

- Route `/system`; `/dashboard` and `/costs` are `<Navigate replace>` redirects (bookmarks keep working).
- Nav label "System", page title "System", ⌘K entry "System".

## 3. Spend disclaimer

Shown on the System page directly under the usage tiles:

> Spend is estimated from public token prices. If you use subscription accounts (Claude, Codex,
> Grok), this reflects your token volume, not what you are billed.

## 4. Host stats — what was checked and fixed

| Stat | Source | Verdict | Change |
|---|---|---|---|
| CPU % | `/proc/stat` diff over 500 ms (`os.cpus()`) | correct (host-wide) | none |
| Cores, load avg | `os.cpus()`, `/proc/loadavg` | correct (host-wide) | none |
| Memory | `os.totalmem()` / `os.freemem()` | correct on Node ≥ 20 (libuv reads MemAvailable) but wrong on older runtimes, where `freemem` is MemFree and page cache counts as "used" (on the test host: 95 % vs the real 3 %) | read `MemAvailable` from `/proc/meminfo` explicitly; fall back to `os.freemem()` |
| Disk | `df -B1 /` via a shell every 5 s | values correct | `fs.statfsSync('/')` with df's exact math (used ÷ (used + avail), rounded up) — no shell |
| Uptime | `os.uptime()` (`/proc/uptime`) | correct (host — containers share the kernel) | none |
| Process count | `ps aux \| wc -l` − 1 | **wrong**: counted its own `sh`/`ps`/`wc` (+2), and inside a container it only sees the container's PID namespace while being shown next to host numbers | count numeric `/proc/<pid>` dirs (no spawn); labelled "processes visible to the server" |
| Hostname | `os.hostname()` | **misleading** in Docker: a random container id shown as the machine name | server reports `inContainer`; UI says "container &lt;id&gt;" |
| Freshness | 5 s poll | **stale**: a failed poll left the last numbers on screen with no sign they were old | "updated Ns ago", amber "stale" badge after 30 s |

## 5. Seat widgets removed from System

Removed: the "Accounts n/m available" tile and the whole "Subscription seats" list with its
actions. Replaced by one small link, "Manage AI accounts in Settings > Models", pointing at
`MODELS_SETTINGS_ROUTE` (`app/client/src/lib/routes.ts`). That constant is `/settings/seats`
today because the Models route does not exist yet; Sprint 4b flips it to `/settings/models` in the
PR that renames the tab. No Settings file is created or edited here.

## 6. Cron under Jobs

Jobs now has explained sections: *Scheduled routines* (the app's own scheduler), *Host cron jobs*
(server crontab entries tagged `# command-center: <name>`), and the run lanes. With no tagged host
cron jobs the section collapses to one explanatory line instead of the old full-card
"No cron jobs found" empty state.

## 7. One Agents page

`/agents` is the only Agents page, with tabs **Registry** (roster, assignments, skill graph — was
`/settings/agents`), **Board layer** (was `/agents`) and **Templates** (was `/agent-templates`).

## 8. Notifications

UI only (`AlertBell.tsx`); delivery (#900368 / PR 668) is untouched and the same `/api/alerts`
endpoints are used. Unread / All filter, grouped by day (Today / Yesterday / Earlier), unread dot
and weight, read items muted, "Mark read" / "Mark all read" wording, severity label only when it
matters, a real empty state, Esc to close, and a viewport-safe panel at 390 px (it used to run off
the left edge of the screen).

## Coordination notes for Sprint 4b

- The Settings tab strip still lists **Agents** and **Platform**; both now redirect out of
  Settings. 4b should drop those two tabs (and their `TAB_COPY`) when it reworks the strip.
- Flip `MODELS_SETTINGS_ROUTE` to `/settings/models` when Seats is renamed.
