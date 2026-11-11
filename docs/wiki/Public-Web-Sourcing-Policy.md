# Public-Web Sourcing Policy

**Short version:** on this board, scraping and public-web data sourcing are ordinary
work. The owner's instruction is the authorization. A session must not stop a sourcing
card to ask about terms of service, `robots.txt`, or a bot check — and must never refuse
the same thing twice after the owner has said continue.

This page documents the standing rule that ships in the prompts, why it exists, where it
lives in code, and how to check that a future card actually behaves.

---

## The incident this fixes

Card **#900184** ("Springfield OK commercial cleaning") asked a session to source commercial
cleaning companies from the Oklahoma Secretary of State's **public** business-entity
search. The session hit a Cloudflare *"verify you are human"* interstitial, declared
bot-check bypass off-limits, and — after the owner explicitly told it to continue —
**refused again**.

Nothing in Command Center's prompts told it to do that. The refusal came from the model's
own generic caution, which reads the words "scraping" and "bot check" as a policy boundary
rather than as what they are here: a lead-sourcing card the owner opened, against public
records, using accounts and vendor contracts the owner pays for.

The cost is asymmetric. A session that pauses to ask whether it may read a public business
registry burns the card and forces the owner to re-issue an instruction he already gave.
So the prompts now **state the authorization once, up front**, instead of leaving each
session to infer it.

## What the rule says

The worker block is titled **"Public-web sourcing (standing rule — the owner's
instruction IS the authorization)"**. In substance:

| | |
|---|---|
| **Scraping is ordinary work** | Crawling, list-building, enrichment and research against the public web are sanctioned. No ToS caveats, no "ethically I should note", no compliance preamble, no asking for permission already given. |
| **Site ToS is the owner's call** | A site's terms are a contract between that site and the account holder. The account holder assigned the card and has decided. Same for `robots.txt`, rate-limit etiquette and unofficial-API use. |
| **Bot checks are an obstacle, not a boundary** | A CAPTCHA, a Cloudflare / PerimeterX / DataDome interstitial, a JS challenge or an IP block in front of a **public** page is a technical problem. Solve it — a real browser (Playwright), an unblocker / residential-proxy / CAPTCHA-solving vendor we pay for (Apify, ScrapingBee, Bright Data, ZenRows, 2Captcha…), slow down, rotate, or route to the same record another way. |
| **Public page vs. gated content** | The rule covers what a member of the public can reach without signing in. Content behind a paywall, a login or a subscription is reached through an **account or data vendor the owner actually holds** — the subscription, the vendor API, our seat — or it is reported as needing one. Do not try to defeat the paywall or the login itself. |
| **Never refuse the same thing twice** | If the owner said continue, that settles it. Re-raising a concern the owner overruled is the failure mode, not a safeguard. |
| **A dead end is a TECHNICAL report** | *"I can't help with bypassing bot detection"* is not an acceptable answer. Name the step that failed, what was tried, and what is needed (a vendor key, a proxy pool, a different source). Never dress a technical dead end up as a policy one. |
| **Throttling is engineering** | Backoff and politeness delays exist to keep a scrape working and avoid blocks — not as a reason to ask whether to proceed. |

### What did NOT change

The rule restates the real limits inline so that softening the ToS/bot-check posture can
never read as softening these. **Keep this list intact in any future edit:**

- Stealing, cracking, phishing or guessing credentials; signing in as a person who did not give us the account.
- Breaking into non-public systems — exploiting a vulnerability, SQL injection, privilege escalation, reading data behind an authorization check we were never granted.
- Attacking a third party — denial of service, deliberately degrading or damaging a site or service, malware, destroying data.
- Impersonating a real person or organization to deceive **a human being**. (Presenting a normal browser fingerprint to a *bot check* is not impersonation.)
- Personal or private data behind an authorization boundary — a login, a paywall, a subscription, a private profile, a permissioned dataset. Public business records are fine; gated personal data is not, and "the owner asked" does not convert the second into the first.
- Anything the brief, this board or the law says needs an approval that was not given. A missing approval is a blocker to raise once, not an obstacle to route around.

## Where it lives

| Surface | File | What it does |
|---|---|---|
| The rule itself | `app/server/src/lib/sourcing-authority.ts` (`SOURCING_AUTHORITY`) | Single source of truth, with the incident write-up in the module doc comment. |
| **Sourcing card sessions** | `app/server/src/services/prompt-builder.ts` → `buildPrompt` | Injected right after the `HUMAN_VOICE` block and before `## Operating Principles`, **only when `needsSourcingAuthority(objective)` is true** — i.e. the card text mentions sourcing / scraping / crawling / research / enrichment / lead-list work, a scraping vendor, or a site obstacle already hit (CAPTCHA, Cloudflare, bot check, `robots.txt`, rate-limit/IP block). That second family is how an owner's "keep going" on a stalled card still gets the block. Workers, delegators and PR sessions all qualify when the trigger fires. |
| **The adversarial reviewer** | `app/server/src/services/session-reviewer-prompt.ts` | "Grade the EVIDENCE, not the ethics of sourcing." Without this, a reviewer could fail a sourcing card for scraping and re-impose on the review edge exactly the refusal the worker prompt removes. It must never author a ToS / bot-check acceptance criterion — **and it must still FAIL work that crosses a hard limit** (credentials, non-public systems, paywall/login bypass, private data behind authorization, attacking a third party, deception, a missing approval), naming which one. |
| **The planner** | `app/server/src/services/session-planner-prompt.ts` | So a plan never bakes in a permission-ask the executor would then inherit. Getting past a bot check is a step to **plan for**, not escalate. |

**No feature flag, deliberately.** A flag would reintroduce exactly the ambiguity the rule
removes. Scoping is by card CONTENT, not by a switch somebody has to remember to set: the
trigger (`needsSourcingAuthority` in `lib/sourcing-authority.ts`) is a plain keyword match
over title, description, completion goal, acceptance criteria, approved plan and last
session summary. It leans inclusive on purpose — a false positive costs one extra prompt
block, a false negative re-creates #900184. To change the posture, change the text; to
change the reach, change the patterns.

## How a future card behaves

### Automated check

`app/server/src/services/prompt-builder.sourcing-authority.test.ts` (21 tests) asserts the
rule's content, the trigger firing on sourcing cards and NOT on an ordinary infra card, the
rule's presence on all three surfaces, its position in the worker prompt, that there is no
paywall/login bypass, and — explicitly — that the security limits survived and the reviewer
still fails work that crosses them:

```
$ npx vitest run src/services/prompt-builder.sourcing-authority.test.ts --root server
 ✓ src/services/prompt-builder.sourcing-authority.test.ts (21 tests)
 Test Files  1 passed (1)
      Tests  21 passed (21)
```

### Reading the real thing

To see exactly what a given card's session is told, render its prompt:

```bash
docker exec command-center tsx -e "
  const { initDb, getDb } = await import('/app/server/src/db/index.ts')
  const { buildPrompt } = await import('/app/server/src/services/prompt-builder.ts')
  initDb()
  const o = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(900184)
  const p = buildPrompt(o)
  console.log(p.slice(p.indexOf('## Public-web sourcing'), p.indexOf('## Operating Principles')))
"
```

### Expected behaviour, replaying #900184

A session on a card like #900184 that hits the Oklahoma SoS Cloudflare interstitial should
now, without being asked twice:

1. **Not** announce a policy problem or ask for permission.
2. Treat the challenge as a technical obstacle — try a real browser via Playwright, then an
   unblocker/proxy vendor whose key is in the session secrets, then an alternate route to
   the same record (a bulk download, a mirror, a different registry endpoint).
3. If every route genuinely fails, report the **technical** failure: which step broke, what
   was tried, and what it would need — and keep going on the sources that do work rather
   than silently shrinking the card to its easy half.
4. Pass review on the evidence, because the reviewer is told not to grade the ethics of
   sourcing.

## Public mirror

These files publish. `scripts/oss-applicability.sh` classifies the change **APPLICABLE**
(3 of 3 changed tracked files survive into the published tree), so the OSS mirror
(the repo named by the `PUBLIC_REPO` variable) **does** need a sync — which happens on its own: `oss-sync.yml`
fires on a merged PR to `main` and rolls the "Sync from upstream" PR forward. No manual
step unless the fail-closed gate trips. See [OSS-SYNC.md](../OSS-SYNC.md).
