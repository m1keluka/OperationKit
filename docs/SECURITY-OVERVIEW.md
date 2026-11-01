# Operation Kit security overview (one page)

*For partners, IT leads and anyone asked "where does our data go?" No technical background needed.
The detailed threat model for engineers is in [SECURITY.md](../SECURITY.md).*

## The short version

Each client gets **its own copy of Operation Kit on its own server**. There is no shared Operation
Kit cloud, no central database holding several clients' data, and no one at Operation Kit who can
sign in to a client's install. The client owns the server, the data and the AI accounts.

## Who controls what

| | Who controls it |
|---|---|
| **The server** | The client. It is a server the client rents or owns (DigitalOcean, Hetzner, AWS, their own hardware). |
| **The data** (knowledge base, board cards, chat history, files) | The client. It lives on that server's disk. Back up one folder and you have all of it. |
| **The AI accounts** (Claude, and optionally OpenAI or Gemini) | The client. Their own subscription or API key. Text sent to an AI is covered by that provider's terms with the client. |
| **Who can open the site** | The client, through a list of allowed email addresses or an email domain. |
| **Turning it off** | The client. One uninstall command removes the app, its data and its Cloudflare setup. |

## How the site is protected

```
 Person ──► Cloudflare Access ──► Cloudflare Tunnel ──► client's server (no open web ports)
           "who are you?"         private connection     ├─ Operation Kit app (trusts the verified email)
                                  the server dials out    └─ one sandbox per AI job
```

1. **Cloudflare Access is the front door.** Nobody even sees the sign-in page unless their email
   is on the client's list. They prove it with a one-time code sent to their inbox, or with their
   Google or Microsoft account.
2. **Cloudflare Tunnel means no open doors on the server.** The server makes a private connection
   *out* to Cloudflare. Its firewall accepts nothing from the internet except SSH for the
   administrator.
3. **One login, checked twice.** After Cloudflare Access, Cloudflare hands the app a signed token
   naming the person's email. The app checks the signature against Cloudflare's published keys,
   and checks that the token was made for this site and has not expired, before it trusts the
   email. The email must match an existing Operation Kit user; an unknown email gets a "no
   account" page and is never given a new account. The username and password sign-in (stored
   only as a one-way hash, repeated wrong passwords slowed down) stays as a break-glass way in;
   a one-time setup password must be replaced before anything else works.
4. **Every AI job runs in its own sandbox.** Each board card gets a fresh, locked-down container
   that can see only its own work folder. It runs as an ordinary (non-administrator) user, with
   extra system permissions removed, and it cannot see other jobs, the database or the server's
   secrets. When the job stops, its sandbox is removed.
5. **Secrets are never shown.** Passwords, API keys and tokens are generated on the server or typed
   once into a masked field. They are stored encrypted (AES-256-GCM) and the app shows only their
   names, never their values, not even to administrators. If someone pastes a key into a chat by
   mistake, the known secret values are blanked out before the chat is saved.
6. **Outside AI apps get limited keys.** When Claude, ChatGPT or Grok connect to the install, each
   uses its own named key with ticked permissions (read notes, write notes, create cards…) and a
   list of the workspaces it may touch. A key can be revoked at any time. No key can merge code,
   deploy, or read a secret value.
7. **The server keeps itself patched.** The installer turns on automatic security updates, a
   firewall and fail2ban, and switches SSH to key-only sign-in.

## Why this sidesteps most SOC 2 questions

SOC 2 is an audit of a *service provider* that holds your data on its systems. With Operation Kit,
the client's data never sits on a vendor's systems: it stays on a server the client controls, under
the client's own policies and the client's own agreements with Cloudflare and the AI provider. The
question "is your vendor SOC 2 audited?" mostly becomes "is our own server set up well?", which the
client (or its IT provider) can check directly.

**To be clear: Operation Kit itself has no SOC 2 attestation.** We do not claim one. If a client's
policy requires every piece of software to come from a SOC 2 audited vendor, Operation Kit does not
meet that today. Cloudflare and the major AI providers publish their own audit reports.

## What is not done yet (honest list)

| Gap | What it means today |
|---|---|
| **No SOC 2 or other formal audit** | See above. No penetration test report to share yet either. |
| **Single sign-on only through Cloudflare Access** | Google or Microsoft sign-in works at the Cloudflare door, and the app trusts that sign-in (one login). The break-glass username and password has no built-in two-factor. |
| **Chat history and AI job transcripts are not encrypted at rest** | They are plain files and database rows on the server's disk. Secrets *are* encrypted. Use the hosting provider's disk encryption. |
| **The app itself has full control of its server** | It needs this to start and stop sandboxes. Anyone with an Operation Kit administrator login should be someone you would trust with the server. Sandboxed AI jobs do *not* have this access. |
| **Sandboxes can reach the internet** | An AI job can make outbound web requests (it needs to, to reach the AI provider and install tools). It cannot reach the server's other files. |
| **Text goes to the AI provider** | Whatever a job or chat works on is sent to the client's chosen AI provider to get an answer. That is the provider's normal service, under the client's account. |
| **One server, no automatic failover** | If the server is down, the site is down. Back up the install folder off the server. |

## Questions people usually ask

**Can the consultant who installed it see our data afterwards?** Only if you keep their email on
the Cloudflare Access list and give them an Operation Kit account, or leave their SSH key on the
server. Remove all three (and rotate the Cloudflare API token used during setup) and they are out.

**Is our data used to train AI models?** That depends on your AI provider and plan, not on
Operation Kit. Business and API plans from the major providers say they do not train on your data
by default; check your own agreement.

**What happens if we stop using it?** Run the uninstall script, or simply delete the server. Copy
the install folder first if you want to keep your notes: the knowledge base is ordinary text files
that open in any editor.
