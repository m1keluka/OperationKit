# Recommended stack: OVHcloud Rise + Backblaze B2 + Cloudflare

This guide takes you from nothing to a working Operation Kit install, with off-site backups, on the
setup we run ourselves:

| Piece | What it does | Rough cost |
|---|---|---|
| **OVHcloud Rise** dedicated server, Ubuntu 24.04 | Runs the app and one sandbox per AI job | from about $64/month (see the table in step 1) |
| **Backblaze B2** + restic | Encrypted nightly backups off the server | cents per month; the first 10 GB are free |
| **Cloudflare** (Free plan) | Your domain, the private tunnel to the server, and the sign-in door (Access) | $0, plus the domain itself |
| **Claude** subscription seats | The AI that does the work on the cards | your existing Pro / Max / Team plan |

**Why this stack.**

- **Cost.** We moved our own install from a DigitalOcean c2-32vcpu-64gb droplet ($978/month) to an
  OVH Rise-4 (16 cores / 32 threads, 128 GB or more RAM) at about $276/month plus a one-time setup
  fee. That saves about $700 a month (details: [the migration runbook](./migration/ovh-rise4.md)). A
  dedicated server also means the cores are yours: no noisy neighbours, and the traffic is unmetered.
- **Off-site backups.** B2 costs $6.95 per TB per month, the first 10 GB are free, and downloads are
  free up to three times what you store
  ([B2 pricing](https://www.backblaze.com/cloud-storage/pricing)). A year of nightly backups for a
  small team costs cents.
- **Cloudflare Free** gives you the tunnel and the Access sign-in (a one-time code by email). The
  server opens **no web ports** at all.
- **To be honest about it:** any Ubuntu 24.04 server with enough memory works (Hetzner, AWS, another
  OVH line, a box in your office). This is the setup we run and test, so it is the one this guide
  walks through. If you use something else, read step 1 for the size and skip step 2.

You will do ten things, in this order. Steps marked **👤** are clicks only you can do (they involve
money, a password or your identity). Everything else can be done by Claude Code on your laptop
following [INSTALL.md](../INSTALL.md).

1. [Choose a server size](#1-choose-a-server-size)
2. [Order the server at OVHcloud](#2-order-the-server-at-ovhcloud-)
3. [Make an SSH key and log in](#3-make-an-ssh-key-and-log-in-)
4. [Put the domain on Cloudflare](#4-put-the-domain-on-cloudflare-)
5. [Run the installer](#5-run-the-installer)
6. [Turn on off-site backups (Backblaze B2)](#6-turn-on-off-site-backups-backblaze-b2-)
7. [Connect subscription seats](#7-connect-subscription-seats-)
8. [GitHub: tokens and repositories](#8-github-tokens-and-repositories)
9. [Updating](#9-updating)
10. [Day-to-day checks and costs](#10-day-to-day-checks-and-costs)

---

## 1. Choose a server size

### What we measured

On our own install (OVH Rise-4: AMD EPYC 7313, 16 cores / 32 threads, 256 GB RAM, 878 GB NVMe RAID),
measured on 2026-11-01:

| | Measured |
|---|---|
| Server idle (Ubuntu + Docker + the app) | 3.8 GB RAM used, load 0.5-0.8 |
| The app container | about 153 MB RAM, 0.1-1.5% CPU |
| Cloudflare connector (`cloudflared`) | about 21 MB RAM |
| **One AI session** (its sandbox, `ok-jail-<id>`) | the Claude process holds about 290-305 MB. The sandbox as a whole sat at 1.5 GB mid-session and **peaked at 3.6 GB** (this includes the file cache from `npm ci`, tests and builds). CPU is about 0.3-1.5% of 32 threads while the model thinks, with bursts of a few cores during installs and tests |
| Disk per active card | its work folder (about 25 MB) plus a sandbox home of 1.3-1.8 GB when the repository has `node_modules` (3.0 GB across 6 sandbox homes) |
| Docker images | app 7.06 GB, sandbox 1.03 GB. `update.sh` keeps the newest 3 pre-update copies, so budget **about 32 GB for images plus about 8 GB of Docker build cache** |
| Database after one day | 1.1 MB (+ 4 MB write-ahead log). Local backups folder: 11 MB |
| First off-site snapshot | 1.26 MiB stored (12 MiB before compression, 4.2x) |

How many sessions run at once? On our previous, busier board (all workspaces), a rough upper-bound
estimate gave **2-8 cards working at the same time on quiet days and 7-15 on busy days** (7 on two
days, 12, 15 and 8 on others). Treat that as approximate: it is worked out from when cards were
created and last updated, with each window capped at 3 hours, not from exact session times.

### The rule

> **RAM = 6 GB + 3 GB per concurrent session**
> **CPU threads = 2 + 1.5 per concurrent session**
> **Disk = 60 GB + about 3 GB per concurrent session + room for the knowledge-base files**

**Size up when unsure.** A dedicated server cannot be shrunk or grown: you order a new one and move.
(OVH's VPS line can be upgraded in place, but never downgraded.) Running out of memory mid-session is
much more expensive than a few dollars a month.

### Which server

Prices checked **2026-11-01**, excluding VAT. They change: re-check them on the order page.

| Tier | Sessions at once | Needs (threads / RAM / disk) | OVH pick | Hetzner Cloud alternative | B2 after about 6 months* |
|---|---|---|---|---|---|
| **Solo / light** | 1-2 | 8+ threads, 16 GB, 150 GB | **RISE-1** (6 cores / 12 threads, 32 GB, 2 x 512 GB NVMe) from $64/month ([OVH Rise](https://www.ovhcloud.com/en/bare-metal/rise/)). Cheaper start: **OVH VPS-4** (8 vCores, 24 GB, 200 GB NVMe) from $23.37/month ([OVH VPS](https://www.ovhcloud.com/en/vps/)); shared cores, can only be upgraded in place | CCX13 is too small (2 vCPU / 8 GB, EUR 43.49/month, [Hetzner](https://www.hetzner.com/cloud/general-purpose)); not recommended | under 1 GB: free |
| **Small team** | 3-5 | 12+ threads, 32 GB, 250 GB | **RISE-2** (8 cores / 16 threads, 32 GB, 2 x 512 GB NVMe) from $72/month ([OVH Rise](https://www.ovhcloud.com/en/bare-metal/rise/)) | nothing that matches at this price | 1.7-5 GB: free |
| **Heavy** (what we run) | 6-10+ | 24-32 threads, 64-128 GB, 500 GB+ | **RISE-4** (AMD EPYC 7313, 16 cores / 32 threads): from EUR 159.99/month; 128 GB with 2 x 3.8 TB about EUR 272/month; 256 GB with 3 x 3.84 TB about EUR 376/month (from a price tracker, [ovheco.com](https://ovheco.com/en/plans/24rise04-v2); confirm on OVH when you order) | CCX43 (16 dedicated vCPU, 64 GB, 360 GB) EUR 276.49/month ([Hetzner](https://www.hetzner.com/cloud/general-purpose)): billed by the hour and can be resized upwards, but less RAM and disk per euro | 5-17 GB: $0 to about $0.05/month |

RISE-1 and RISE-2 prices come from OVH's own page; the RISE-4 prices come from a third-party tracker.

\* **How the B2 column is worked out** (a deliberately pessimistic upper bound): nightly backup size x
about 34 kept snapshots. The default retention (7 daily, 4 weekly, 6 monthly, step 6) keeps at most
17; 34 also covers you if you raise it. Each nightly backup is a set of `.tar.gz` files, which restic
cannot de-duplicate well, so we assume none. Assumed nightly size: solo 10-30 MB, small team
50-150 MB, heavy 150-500 MB. Above the free 10 GB, B2 storage costs about $0.007 per GB per month.
Your first real snapshot will probably be much smaller (ours was 1.26 MiB).

---

## 2. Order the server at OVHcloud 👤

1. Create an account at [ovhcloud.com](https://www.ovhcloud.com/) and open
   [Bare Metal → Rise](https://www.ovhcloud.com/en/bare-metal/rise/). Pick the model from step 1.
2. **Region.** Pick the datacenter closest to the people who will use it (and where the client's
   data is allowed to live). Latency to Cloudflare matters far less than the data rule.
3. **Term and fees.** Rise servers carry a **one-time installation fee** on top of the monthly
   price. OVH offers monthly billing or a 12- or 24-month commitment; a commitment usually lowers or
   removes the setup fee and the monthly price. Read both on the order page before you pay. Our
   Rise-4 had about a $200 setup fee on monthly billing.
4. **Operating system: Ubuntu Server 24.04 LTS.**
5. **Disks and RAID.** Use **custom partitioning** so the NVMe drives are mirrored (software RAID):
   - 2 drives (RISE-1, RISE-2, most RISE-4 builds with 2 x 3.8 TB): **RAID1** for every partition.
     Usable space = one drive.
   - 4 drives: **RAID10** for `/` and RAID1 for `/boot`. Usable space = half the drives, fastest
     writes, survives one failed drive (two if they are in different mirror pairs).
   - 3 drives: RAID1 across all three (usable space = one drive) is the simple, safe choice.
   - Put everything in `/` (no separate small `/var` or `/home`: Docker images live under `/var`).

   Why, and what we chose on a 4-drive Rise-4: [the migration runbook, section A](./migration/ovh-rise4.md#a-the-owner-does-these-personally).
   RAID protects against a dead drive; it does **not** protect against losing the server. That is
   what step 6 is for.
6. **SSH key.** The order or the OS install screen has a field for an **SSH public key**. Paste the
   key from step 3 there (make the key first if you do not have one). OVH puts it on the server's
   first user, so you can log in without a password.
7. Pay. OVH emails you when the server is delivered (minutes to a few days for some models), with
   its **IPv4 address**.

Using a different provider? Order Ubuntu 24.04 with at least the size from step 1, give it your SSH
public key, and continue with step 3.

---

## 3. Make an SSH key and log in 👤

An SSH key is how you (and Claude Code on your laptop) log in to the server. Make one on your
laptop if you do not have one yet:

```bash
ssh-keygen -t ed25519 -C "you@yourcompany.com"     # Enter for the default file; set a passphrase
cat ~/.ssh/id_ed25519.pub                          # the PUBLIC key: this one line is what you paste
```

(Windows: the same commands work in PowerShell.) Only ever paste the `.pub` file. The other file,
`id_ed25519`, is the private key and never leaves your laptop.

Paste the public key in the OVH panel (step 2.6). If the server is already installed, add it from
the OVH panel (reinstall with the key) or append it to `~/.ssh/authorized_keys` on the server.

**First login.** OVH's Ubuntu image logs in as **`ubuntu`** (with `sudo`), not `root`:

```bash
ssh ubuntu@<server IP>
```

The first time, SSH asks you to confirm the server's fingerprint: type `yes`.

**What the installer does to SSH.** It switches the server to **key-only logins** (no passwords),
but only after it has checked that a key is already installed, so it cannot lock you out. It also
turns on the firewall (SSH only), automatic **Ubuntu security updates** and fail2ban. Keep your
private key safe: once passwords are off, it is the only way in (besides OVH's rescue console).

---

## 4. Put the domain on Cloudflare 👤

The site will live at an address like `ops.yourcompany.com`. The domain (`yourcompany.com`) must be
on Cloudflare.

1. **Get a domain.** Already have one? Use it. Otherwise buy one at any registrar, or at
   [Cloudflare Registrar](https://www.cloudflare.com/products/registrar/), which sells at cost.
2. **Add the site.** In the [Cloudflare dashboard](https://dash.cloudflare.com/): *Add a domain* →
   enter `yourcompany.com` → pick the **Free** plan. Cloudflare copies your existing DNS records.
   Check that the list looks complete (especially **MX** records, or email stops working).
3. **Switch the nameservers.** Cloudflare shows two nameservers (like `ana.ns.cloudflare.com`). At
   your registrar, replace the domain's nameservers with those two. (Bought it at Cloudflare? This is
   already done.)
4. **Wait for "Active".** Usually minutes, at most 24 hours. Cloudflare emails you, and the domain
   shows **Active** under *Websites*.
5. **Turn on Zero Trust.** Open *Zero Trust* in the left menu. The first time, choose a *team name*
   (any name, e.g. `yourcompany`) and the **Free** plan (up to 50 users). Cloudflare may ask for a
   card even for the Free plan.
6. **Create the API token** with the six permissions in
   [INSTALL.md step 2](../INSTALL.md#step-2-cloudflare--you-about-5-minutes-one-time-per-client), limited
   to this domain and this account. Keep it in an environment variable on your laptop
   (`export CF_API_TOKEN=...`), never in a chat.

That is all on Cloudflare. The installer creates the tunnel, the DNS record and the sign-in door
itself.

---

## 5. Run the installer

The code lives at **<https://github.com/m1keluka/OperationKit>**. Updates come from the same place
(step 9).

**The easy way: Claude Code does it.** Clone the repository on your laptop, open Claude Code in it,
and say:

> Install Operation Kit on my server by following INSTALL.md in this repository.
> The server is `<IP address>`, I log in as `ubuntu`, with sudo.
> My Cloudflare API token is in the environment variable `CF_API_TOKEN`.

It asks you a few questions (the client name, the address, who may sign in) and stops for the clicks
only you can do. About 30-45 minutes, most of it the build.

**By hand.** The same steps Claude Code follows, in short (details and every option:
[INSTALL.md](../INSTALL.md)):

```bash
# on the server
sudo apt-get update -qq && sudo apt-get install -y -qq git
sudo git clone https://github.com/m1keluka/OperationKit.git /opt/operationkit-src
cd /opt/operationkit-src
sudo cp install/client.conf.example client.conf
sudo nano client.conf                                # fill in CLIENT_NAME, DOMAIN, ZONE, ACCESS_ALLOWED_EMAILS…

# the Cloudflare token goes in a hand-over file (read hidden, never on screen)
read -rs -p 'Cloudflare API token: ' T; echo
( umask 077; printf 'CLOUDFLARE_API_TOKEN=%s\n' "$T" > ~/ok-handover.env ); unset T

sudo ./install.sh --config client.conf --dry-run      # changes nothing, ends with "Done"
sudo ./install.sh --config client.conf --secrets-file ~/ok-handover.env
```

Run by hand in a terminal, the installer **asks at the end whether to set up off-site backups to
Backblaze B2** (Enter skips; step 6). When Claude Code runs it over plain `ssh` there is no terminal,
so it never asks; you run that one step yourself afterwards.

Then connect Claude ([INSTALL.md step 7](../INSTALL.md#step-7-connect-claude-for-the-ai-workers--you-2-minutes),
or step 7 below) and run the checks:
`sudo bash /opt/operationkit-src/install/verify.sh --config /opt/operationkit-src/client.conf`. Every line
should say PASS.

---

## 6. Turn on off-site backups (Backblaze B2) 👤

Every night at 03:30 (server time zone, `BACKUP_TIME`) the server copies its database, files and
secrets into `/opt/operationkit/backups/`. That copy is on the **same disks** as the data. B2 keeps a
second, encrypted copy somewhere else.

**In Backblaze** ([backblaze.com](https://www.backblaze.com/sign-up/cloud-storage), B2 Cloud Storage):

1. **Create a bucket:** *Buckets → Create a Bucket*. Give it a unique name (e.g. `yourcompany-ok-backup`),
   **Files in Bucket: Private**. Leave encryption and object lock off (restic encrypts everything
   itself). Note the **Endpoint** on the bucket's card (like `s3.us-west-004.backblazeb2.com`); the
   setup script also finds it on its own.
2. **Create an application key for that bucket only:** *Application Keys → Add a New Application Key*.
   *Allow access to Bucket(s)*: **just this bucket**. *Type of Access*: **Read and Write**. Leave the
   file-name prefix empty.
   B2 shows the **keyID** and the **applicationKey** once. Keep the window open for the next step.
   restic needs to list the bucket and to list, read, write and **delete** files (deleting is how old
   snapshots are removed); a *Read and Write* key includes exactly these (`listBuckets`, `listFiles`,
   `readFiles`, `writeFiles`, `deleteFiles`), and the setup script refuses a key without them.

**On the server**, in **your own terminal** (it asks for the key, so not through a chat):

```bash
ssh -t ubuntu@<server IP> sudo bash /opt/operationkit-src/install/b2-setup.sh --config /opt/operationkit-src/client.conf
```

It asks for the keyID, the applicationKey (typing is hidden), the bucket (filled in for you when the
key is limited to one) and a folder (default `operationkit`). Then it:

- checks the key with Backblaze: accepted, limited to that bucket, allowed to list, read, write and
  delete;
- writes `BACKUP_TARGET="s3:https://<endpoint>/<bucket>/operationkit"` into `client.conf` (no secret
  there), and the two keys into `/opt/operationkit/secrets/stack.env` (root only, mode 600);
- keeps the **one** nightly job (`/etc/cron.d/operationkit-backup`), which now does the local copy and
  the off-site send together. There is never a second timer;
- sends the first snapshot, runs the **restore test**, and prints one line, e.g.
  `Off-site backups: ON -> s3:… | first snapshot 1a2b3c4d sent, restore test PASS | nightly at 03:30`.

Re-running it is safe: an existing setup is kept unless you choose to replace the key.

**Save the backup password now.** The off-site copies are encrypted with a password the installer
generated (`OK_BACKUP_PASSWORD`). **If you lose it, the backups cannot be read by anyone, including
you.** Copy it into your password manager, reading it in your own terminal only:

```bash
ssh -t ubuntu@<server IP> sudo grep ^OK_BACKUP_PASSWORD= /opt/operationkit/secrets/stack.env
```

**How many copies are kept.** On the server: the newest 7 nightly folders (`BACKUP_KEEP_LOCAL`).
In B2: one per day for 7 days, one per week for 4 weeks, one per month for 6 months
(`BACKUP_KEEP_DAILY`, `BACKUP_KEEP_WEEKLY`, `BACKUP_KEEP_MONTHLY` in `client.conf`).

**Restore test.** Run it after the first backup and then once a month. It downloads the newest
snapshot into a scratch folder, checks every file against its checksum list, opens every archive,
runs SQLite's `integrity_check` on the database and counts its rows, prints **PASS** or **FAIL**, and
deletes the scratch copy. It changes nothing.

```bash
ssh ubuntu@<server IP> 'sudo bash /opt/operationkit-src/install/backup.sh verify --config /opt/operationkit-src/client.conf'
```

Restoring after a mistake, or onto a new server when the old one is gone:
[INSTALL.md → Backups and restore](../INSTALL.md#backups-and-restore).

---

## 7. Connect subscription seats 👤

A **seat** is one AI account the server's sessions sign in with: a Claude Pro / Max / Team
subscription (or an Anthropic API key), and optionally Codex or Grok. Seats live in
**Settings → Seats** (admins only).

**Add a Claude seat:** **Settings → Seats → Add Claude seat**. Either switch on **Sign in with Claude
instead (no terminal)** and sign in with that Claude account in your browser, or paste a token made
with `claude setup-token` into **Setup token** and press **Add seat**. The first seat can also be
connected during the install ([INSTALL.md step 7](../INSTALL.md#step-7-connect-claude-for-the-ai-workers--you-2-minutes)).

**How work is spread over seats.** For each new session the app picks a healthy seat, preferring the
one with the fewest sessions running right now (then the fewest today). Claude seats are shared: there
is **no fixed number of sessions per seat** in the app. What limits you is each Claude plan's own usage
allowance. So:

- Start with one seat. Add another when cards often wait for a seat (below) or a seat keeps cooling
  down at busy times.
- **Codex and Grok** (**Add Codex seat**, **Add Grok seat**, signed in with a device code) are
  optional. One Codex or Grok login is never used by two sandboxed sessions at the same time, so each
  of those seats runs one session at a time.
- The whole install runs at most 100 sessions at once (a fixed limit in the code).

**When a seat hits its limit.** When the provider says "rate limited", the seat **cools down**: until
the reset time the provider gives, or else for 15 minutes, doubling after each repeat, up to 5 hours.
It comes back by itself, and a successful turn clears it. A seat that ran out of credits, or whose
sign-in expired (it shows **Reconnect**), is parked until you fix it.

**When no seat is free.** Starting a card then fails with *"All Claude seats are unavailable … queued
for auto-retry"*. The card is **queued**, not lost: every 30 seconds the app starts as many queued
cards as there are seats available again. (With **no** Codex or Grok seat at all, a card for that
engine fails at once and asks you to add one.)

---

## 8. GitHub: tokens and repositories

You need this only for cards that work on code: cards that edit a repository or open a pull request.
Three things must be in place: each person's **GitHub token**, a **checkout** of the repository on
the server, and the repository **registered** with that checkout's path.

### 8.1 Each person links a GitHub token

Sessions push and open PRs **as the person the card belongs to**: the card's assigned user, or, if
nobody is assigned, the person who created it. Their token is handed to the session as `GH_TOKEN`.
Without one, the session falls back to the install's shared bot identity, if there is one; on a fresh
install there is none, so pushing fails.

**One connection covers chat and coding.** The GitHub connection in Settings → Connectors is the
same credential chat agents use; coding and sandboxed (jail) sessions get it too, as `GH_TOKEN` /
`GITHUB_TOKEN`, with a git credential helper set in the session env so plain `git push` over https
works without any per-checkout setup. You do **not** need a separate `GH_TOKEN` in Settings → Secrets.
A `GH_TOKEN` secret is still honoured as an **optional override** (for example a bot token for one
workspace): when present it wins over the connection.

Who the session acts for, and when the connection is withheld:

- **Child cards** (fan-out workers, delegated sub-cards created through `POST /api/internal/objectives`)
  inherit the parent's owner and, if the parent was filed by an API key, that key's connector limits.
  A child filed into a different workspace than its parent gets no owner, so no token crosses
  workspaces.
- **Cards filed by an API key** reach GitHub only if that key's connector list includes GitHub
  (Settings → API keys).
- **Cards assigned to you by someone else** use your GitHub only if you allowed it in
  Settings → Connectors → GitHub ("allow on work assigned by others").

Every session's prompt states which of these applies, so a card that cannot reach GitHub names the
setting to change instead of asking for a secret.

1. On GitHub: *Settings → Developer settings → Personal access tokens*. Prefer a **fine-grained**
   token: *Repository access*: **only the repositories** the agents should work in;
   *Permissions*: **Contents: Read and write** and **Pull requests: Read and write**. Set an
   expiry and a reminder to renew it. (A classic token with the `repo` scope also works, but it can
   reach every repository you can, so prefer fine-grained: least privilege.)
2. In Operation Kit: **Settings → Connectors → GitHub → Personal access token**, paste, connect. The
   app checks it with GitHub, stores it encrypted, and never shows it again.

   The same thing over the API, as the signed-in user (cookie, or `Authorization: Bearer <key>`):
   `POST /api/user/github-token` with `{"token": "…"}` links or replaces it; `GET` shows a masked
   summary; `POST /api/user/github-token/validate` re-checks it; `DELETE` removes it.

### 8.2 Check the repository out on the server

Nothing clones repositories for you: the checkout must exist before you register it. Inside the
app, projects live under `/home/operator/projects/<name>`; on the server that folder is
**`/opt/operationkit/state/home/projects/<name>`**.

Clone it once, in your own terminal. The token is read hidden and handed to git through
`GIT_ASKPASS`, so it is never in the URL, on a command line, or in `.git/config`:

```bash
ssh -t ubuntu@<server IP>
sudo -i                                                    # a root shell on the server
read -rs -p 'GitHub token: ' GH_PAT; echo; export GH_PAT
cat > /root/ok-askpass <<'ASKPASS'
#!/bin/sh
case "$1" in Username*) echo x-access-token ;; *) echo "$GH_PAT" ;; esac
ASKPASS
chmod 700 /root/ok-askpass
GIT_ASKPASS=/root/ok-askpass git clone https://github.com/yourcompany/website.git /opt/operationkit/state/home/projects/website
rm -f /root/ok-askpass; unset GH_PAT
cd /opt/operationkit/state/home/projects/website
git config credential.helper '!gh auth git-credential'     # sessions push with their own GH_TOKEN
chown -R 1000:1000 .                                       # the sandboxes run as uid 1000
exit
```

### 8.3 An admin registers the repository, with its path

Registering the repository **with its path** is what lets cards find the checkout: the app records it
in its project list (`workspaces.json`, which the installer creates) and gives the checkout the
`!gh auth git-credential` helper if it has none. Without a path, starting a card for that project
fails with *"resolveWorkdir: … no workspace in workspaces.json maps it to an existing checkout"*.

The screen (**Settings → Org → Organizations →** the workspace **→ Repos & projects**: name,
`owner/repo`, stack) does not ask for the path yet, so use the API. `POST
/api/admin/workspaces/<workspace>/repos` (admin only), on the server, signed in with the admin's
username and password (read hidden; never on a command line):

```bash
ssh -t ubuntu@<server IP>
read -rs -p 'Admin password: ' P; echo
TOKEN=$(jq -Rn --arg u admin '{username: $u, password: input}' <<<"$P" \
  | curl -s -X POST http://127.0.0.1:3002/api/auth/token -H 'Content-Type: application/json' --data @- | jq -r .token)
unset P
printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -s -H @- -H 'Content-Type: application/json' \
  -X POST http://127.0.0.1:3002/api/admin/workspaces/yourcompany/repos --data '{
    "name": "website", "github": "yourcompany/website",
    "stack": ["typescript", "react"],
    "repo_path": "/home/operator/projects/website" }'
unset TOKEN
```

- The workspace is your `CLIENT_SLUG`. `name` is the project name cards are linked to.
- `stack` must be a **list of strings** (`["typescript"]`, not `"typescript"`).
- `repo_path` is the folder **inside the app** (`/home/operator/projects/<name>`), not the server path.
- Already registered without a path (for example from the screen)? Add it with
  `PATCH /api/admin/workspaces/<workspace>/repos/<id>` and `{"repo_path": "/home/operator/projects/website"}`.
  `GET …/repos` lists the ids; `DELETE …/repos/<id>` removes one.
- Signed in only through Cloudflare so far? The admin first needs a password: sign in once with the
  username and the one-time setup password and choose one ([INSTALL.md step 9](../INSTALL.md#step-9-first-sign-in--you)).

So, for a card that opens a PR: the person's token (8.1), the repository checked out (8.2) and
registered with its path (8.3).

---

## 9. Updating

**Updates are manual.** Nothing on the server pulls new Operation Kit code by itself. (The automatic
updates the installer switches on are **Ubuntu's security patches** for the operating system only.)

**How to hear about new versions:** watch the repository on GitHub
(<https://github.com/m1keluka/OperationKit>, *Watch → Custom → Releases*), and read
[CHANGELOG.md](../CHANGELOG.md), which lists every change you need to do or know something about.
To see what is new on the server:

```bash
ssh ubuntu@<server IP> 'cd /opt/operationkit-src && sudo git -c safe.directory="*" fetch -q origin main && git -c safe.directory="*" log --oneline HEAD..origin/main'
```

**To update**, when **no cards are running** (the app restarts, and running sessions are cut off):

```bash
ssh ubuntu@<server IP> 'sudo bash /opt/operationkit-src/install/update.sh --config /opt/operationkit-src/client.conf'
# a specific version:   … update.sh --config … --ref v1.4.0      (a tag, branch or commit)
```

It updates from the place you cloned (the public repository, `main` unless you give `--ref`) and:

1. backs up first (database, seat logins, secrets, settings) into `/opt/operationkit/backups/pre-update-<time>/`;
2. keeps the running images as `…:pre-update-<time>` (the newest 3 are kept: about 8 GB each, which is
   why step 1 budgets about 32 GB for images);
3. fetches the new code and re-runs the installer, keeping your data and secrets;
4. **prints the rollback steps**: check out the old commit, re-tag the `pre-update-<time>` images as
   `:local`, optionally restore the pre-update backup, start the app. They are printed again if the
   install fails.

Then run verify (step 5).

---

## 10. Day-to-day checks and costs

| How often | What | Command (on the server, with `sudo`) |
|---|---|---|
| After any change | Full check: PASS / FAIL per line | `bash /opt/operationkit-src/install/verify.sh --config /opt/operationkit-src/client.conf` |
| Weekly | Last night's backup ran (and was sent off-site) | `tail -20 /opt/operationkit/logs/backup.log` |
| Weekly | Disk space (keep 15% or more free) | `df -h /` and `docker system df` |
| Monthly | **Restore test** | `bash /opt/operationkit-src/install/backup.sh verify --config /opt/operationkit-src/client.conf` |
| Monthly | New version? (step 9) | see step 9 |
| When a card looks stuck | Is its sandbox still working? | `docker ps \| grep ok-jail` |

**Sandboxes.** Each session runs in a container named `ok-jail-<id>`; the app counts a session as
alive while its container runs. Before restarting anything for a card that looks stuck, check
`docker ps | grep ok-jail`: if its container is still there, it is still working. (Installs older than
the 2026-11-01 update could show such a card in **review** with no session while it was still
working; update to fix it.)

**What it costs per month** (excluding VAT, prices from step 1):

| | Solo | Small team | Heavy |
|---|---|---|---|
| Server | RISE-1 from $64 (or a VPS-4 from $23.37) | RISE-2 from $72 | RISE-4 about $175-415 (EUR 160-376) |
| Backblaze B2 | $0 | $0 | $0 to about $0.05 |
| Cloudflare | $0 (plus the domain, about $10-15 a year) | $0 | $0 |
| Claude | your seats' plans | your seats' plans | your seats' plans |

Plus OVH's one-time setup fee, unless your commitment term waives it.
