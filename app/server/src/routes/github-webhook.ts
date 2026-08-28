// GitHub webhook receiver for the "What's Shipping" changelog (obj 937).
//
// Mounted by the lead at `/api/webhooks/github` with a RAW body parser so
// `req.body` is a Buffer (required for HMAC signature verification). Handles
// `pull_request` closed+merged events → collectFromMergedPR.

import { Router } from 'express'
import type { Request, Response } from 'express'
import crypto from 'crypto'
import { collectFromMergedPR, type MergedPRPayload } from '../services/changelog.js'
import { enqueuePreviewTeardown, kickHostDrain } from '../services/preview-spool.js'
import { handleExternalCheckEvent } from '../services/external-remediation-act.js'
import { autoLinkPullRequest } from '../services/external-remediation-resolve.js'
import { markPRStateByRepoAndNumber } from '../services/objective-prs.js'
import {
  parseDevRefs,
  resolveDevItemsFromBranch,
  resolveWorkspaceFromRepo,
  upsertDevItemPr,
  setDevItemPrState,
  advanceDevItemToInProgress,
  shipDevItem,
  addNote,
  devRef,
  type DevRef,
} from '../services/dev-items.js'
import { isAutoDeployEnabled, shouldAutoDeploy, triggerAutoDeploy } from '../services/auto-deploy.js'
import { getDb } from '../db/index.js'
import { sendFollowUp } from '../services/session-manager.js'
import { broadcast } from '../ws/index.js'

const router = Router()

// ── Delivery-id dedupe (api.md §6.5) ────────────────────────────────────────
//
// DEVIATION FROM THE SPEC, STATED PLAINLY. §6.5 asks for a
// `github_webhook_deliveries(delivery_id PRIMARY KEY, …)` table. This wave does
// not own `db/index.ts`, so the guard is implemented as a BOUNDED IN-PROCESS
// LRU of recent `x-github-delivery` ids instead.
//
// What that costs, precisely: the set is per-process and resets on every
// restart, and it would not be shared by a second API process. It is therefore
// a RETRY-STORM GUARD, not a correctness guarantee. Correctness comes from the
// writes themselves: `dev_item_prs` is an upsert on
// UNIQUE(dev_item_id, repo, pr_number) with a monotonic state transition,
// `advanceDevItemToInProgress` is a guarded transition, `shipDevItem` is a
// no-op on an already-shipped item and never overwrites `closed_at`, and
// `changelog_entries` has UNIQUE(repo, pr_number) so `collectFromMergedPR`
// cannot double-insert. Replaying a delivery after a restart is therefore
// still safe; it is merely wasteful. Swap this for the table when db/index.ts
// is in scope.
const DELIVERY_CACHE_MAX = 1000
const seenDeliveries = new Set<string>()

/** Returns true when this delivery id has already been processed by THIS
 *  process. Insertion order is Set iteration order, so evicting the first key
 *  is an exact LRU-by-arrival eviction. */
function isDuplicateDelivery(deliveryId: string | undefined): boolean {
  if (!deliveryId) return false
  if (seenDeliveries.has(deliveryId)) return true
  seenDeliveries.add(deliveryId)
  if (seenDeliveries.size > DELIVERY_CACHE_MAX) {
    const oldest = seenDeliveries.values().next().value
    if (oldest !== undefined) seenDeliveries.delete(oldest)
  }
  return false
}

/** Test seam — the set is module-global and would otherwise leak across specs. */
export function resetDeliveryDedupe(): void {
  seenDeliveries.clear()
}

function rawBody(req: Request): Buffer {
  const b = req.body as unknown
  if (Buffer.isBuffer(b)) return b
  if (typeof b === 'string') return Buffer.from(b, 'utf8')
  // Fallback: re-serialize a parsed object (signature check will then fail,
  // which is the safe outcome if a JSON parser was wrongly mounted upstream).
  return Buffer.from(b ? JSON.stringify(b) : '', 'utf8')
}

/** Verify x-hub-signature-256 against the raw body. Returns true if valid OR
 * if no secret is configured (dev mode — accepted but insecure). */
function verifySignature(req: Request, body: Buffer): { ok: boolean; insecure: boolean } {
  const secret = process.env.GITHUB_WEBHOOK_SECRET
  if (!secret) {
    console.warn('[github-webhook] GITHUB_WEBHOOK_SECRET unset — accepting unverified (dev mode)')
    return { ok: true, insecure: true }
  }
  const header = req.header('x-hub-signature-256') || ''
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return { ok: false, insecure: false }
  try {
    return { ok: crypto.timingSafeEqual(a, b), insecure: false }
  } catch {
    return { ok: false, insecure: false }
  }
}

interface GithubPRPayload {
  action?: string
  number?: number
  pull_request?: {
    merged?: boolean
    html_url?: string
    merge_commit_sha?: string | null
    merged_at?: string | null
    title?: string
    body?: string | null
    user?: { login?: string }
    labels?: Array<{ name?: string }>
    base?: { ref?: string }
    head?: { ref?: string }
  }
  repository?: { full_name?: string }
}

router.post('/', (req: Request, res: Response) => {
  try {
    const body = rawBody(req)
    const sig = verifySignature(req, body)
    if (!sig.ok) {
      return res.status(401).json({ ok: false, error: 'invalid signature' })
    }

    const event = req.header('x-github-event') || ''

    // Retry-storm guard (api.md §6.5). Runs AFTER the HMAC check so an unsigned
    // caller can never poison the cache, and BEFORE any handler so a replay
    // costs nothing. Never a 4xx: a duplicate is a successful no-op.
    const deliveryId = req.header('x-github-delivery') || undefined
    if (isDuplicateDelivery(deliveryId)) {
      return res.status(200).json({ ok: true, duplicate: true, delivery: deliveryId })
    }

    if (event === 'ping') {
      return res.status(200).json({ ok: true })
    }

    // External-CI auto-remediation (obj 1960): catch third-party REQUIRED check
    // failures (GitHub Actions / Vercel) on a PR linked to an objective and drive a
    // bounded diagnose→fix→push→revalidate loop on that objective's session. Ships
    // DARK behind AUTO_REMEDIATION_ENABLED (default OFF). This is fire-and-forget:
    // the heavy lifting (gh log fetch + session resume) runs async so the webhook
    // answers 200 immediately and never retry-storms; handleExternalCheckEvent has
    // its own try/catch and never throws. Coordinates with the harness/test-agent
    // gate by ignoring the harness/* status namespace (see external-remediation.ts).
    if (event === 'check_run' || event === 'check_suite' || event === 'workflow_run' || event === 'status') {
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>
      } catch {
        return res.status(200).json({ ok: false, error: 'invalid JSON body' })
      }
      void handleExternalCheckEvent(event, payload, {
        db: getDb(),
        sendFollowUp,
        broadcast,
      }).catch((err) => {
        console.error('[github-webhook] external-remediation async error:', (err as Error).message)
      })
      return res.status(200).json({ ok: true, event })
    }

    if (event !== 'pull_request') {
      return res.status(200).json({ ok: true, ignored: event })
    }

    let payload: GithubPRPayload
    try {
      payload = JSON.parse(body.toString('utf8')) as GithubPRPayload
    } catch {
      return res.status(200).json({ ok: false, error: 'invalid JSON body' })
    }

    const pr = payload.pull_request

    // The PR body is read by TWO consumers — parseDevRefs() here and
    // parseWhatsShipping() inside collectFromMergedPR — so it is pulled into a
    // single local rather than re-read off the payload in each service
    // (api.md §6.1).
    const prBody = pr?.body ?? ''
    const repoFullName = payload.repository?.full_name || ''
    const eventPrNumber = Number(payload.number || 0)

    /**
     * Resolve the `DEV-<id>` refs this PR carries. Explicit body refs ALWAYS
     * win; the branch-name fallback runs only when the body carried none
     * (api.md §6.4). Fallback refs are `verb:'refs'` by construction, so they
     * can advance an item to in_progress but never ship it.
     *
     * Never throws: a malformed body or an unreadable DB degrades to "no refs",
     * which leaves the pre-existing objective/changelog paths untouched.
     */
    const resolveRefs = (): { refs: DevRef[]; linkSource: 'pr_body' | 'manual' } => {
      try {
        const bodyRefs = parseDevRefs(prBody)
        if (bodyRefs.length) return { refs: bodyRefs, linkSource: 'pr_body' }
        // The enum is manual|pr_body|objective — there is no `branch` value and
        // adding one is not worth a schema change (api.md §6.4).
        return { refs: resolveDevItemsFromBranch(pr?.head?.ref), linkSource: 'manual' }
      } catch (e) {
        console.warn('[github-webhook] DEV-ref parse failed:', (e as Error).message)
        return { refs: [], linkSource: 'pr_body' }
      }
    }

    // PR auto-link (obj 702632, gap B): sessions push branches without registering
    // them, leaving pr_number/pr_url/branch_name NULL on the objective — so later
    // check_run/workflow_run failures can't resolve an owner. On opened/reopened/
    // synchronize, stamp the linkage onto the owning objective (resolved by exact
    // branch_name, then the branch-parsed objective id). NULL-only writes; a
    // conflicting existing link is logged, never overwritten. Best-effort — a link
    // failure must never fail the webhook.
    if ((payload.action === 'opened' || payload.action === 'reopened' || payload.action === 'synchronize') && pr) {
      try {
        autoLinkPullRequest(getDb(), {
          repoFullName: payload.repository?.full_name || '',
          prNumber: Number(payload.number || 0),
          prUrl: pr.html_url || null,
          branch: pr.head?.ref || null,
        })
      } catch (e) {
        console.warn('[github-webhook] PR auto-link failed:', (e as Error).message)
      }

      // Universal Development linkage (api.md §6.2). Independent of the
      // objective auto-link above: an item may have no objective at all, and an
      // objective's own PR row is still owned by objective_prs. No cross-table
      // copying — A2 unions the two and dedupes on (repo, pr_number).
      try {
        const { refs, linkSource } = resolveRefs()
        for (const ref of refs) {
          try {
            // `synchronize` fires on EVERY push to the branch, so this must be
            // an upsert, never an insert.
            const linked = upsertDevItemPr({
              devItemId: ref.id,
              repo: repoFullName,
              prNumber: eventPrNumber,
              prUrl: pr.html_url || null,
              state: 'open',
              linkSource,
            })
            if (!linked) {
              // A typo like DEV-99999 must log and continue, never 500.
              console.warn(`[github-webhook] unknown ${devRef(ref.id)} in ${repoFullName}#${eventPrNumber} — skipped`)
              continue
            }
            advanceDevItemToInProgress(ref.id)
          } catch (e) {
            console.warn(`[github-webhook] dev_item_prs link failed for ${devRef(ref.id)}:`, (e as Error).message)
          }
        }
      } catch (e) {
        console.warn('[github-webhook] dev-item PR linkage failed:', (e as Error).message)
      }
    }

    // Tear down the PR preview on ANY close — merged OR closed-unmerged (obj
    // 1452). This is the canonical teardown trigger; it frees the preview
    // container, Caddy site, worktree and per-PR DB the moment the PR closes.
    // Best-effort and idempotent (no-op against a missing preview).
    if (payload.action === 'closed' && pr) {
      const prNumber = Number(payload.number || 0)
      if (prNumber > 0 && enqueuePreviewTeardown(prNumber)) kickHostDrain()

      // Freshen the per-objective PR log (obj 2300): merged=true → 'merged',
      // otherwise closed-unmerged → 'closed'. Matched by (repo, pr_number).
      // Best-effort — never let a log update fail the webhook.
      try {
        const repo = payload.repository?.full_name || ''
        if (repo && prNumber > 0) {
          markPRStateByRepoAndNumber(repo, prNumber, pr.merged === true ? 'merged' : 'closed')
        }
      } catch (e) {
        console.warn('[github-webhook] objective_prs state update failed:', (e as Error).message)
      }

      // The dev_item_prs analogue of markPRStateByRepoAndNumber above
      // (api.md §6.3.1). A closed-but-NOT-merged PR sets 'closed' and ships
      // NOTHING — the shipping decision lives in the merged block below.
      try {
        const repo = payload.repository?.full_name || ''
        if (repo && prNumber > 0) {
          setDevItemPrState(repo, prNumber, pr.merged === true ? 'merged' : 'closed')
        }
      } catch (e) {
        console.warn('[github-webhook] dev_item_prs state update failed:', (e as Error).message)
      }
    }

    if (!(payload.action === 'closed' && pr && pr.merged === true)) {
      return res.status(200).json({ ok: true, ignored: 'pr not merged' })
    }

    const normalized: MergedPRPayload = {
      repo: payload.repository?.full_name || '',
      prNumber: Number(payload.number || 0),
      prUrl: pr.html_url || '',
      mergeCommitSha: pr.merge_commit_sha || null,
      author: pr.user?.login || null,
      mergedAt: pr.merged_at || new Date().toISOString(),
      title: pr.title || '',
      body: prBody,
      labels: (pr.labels || []).map((l) => l?.name || '').filter(Boolean),
    }

    const { entryId, status } = collectFromMergedPR(normalized)

    // ── Universal Development: ship the closing refs + stamp the changelog ──
    // (api.md §6.3). Runs AFTER collectFromMergedPR so the entry row exists and
    // its id can be stamped onto the items. Entirely best-effort: every failure
    // mode below logs and continues, because GitHub must still get its 200.
    try {
      const { refs, linkSource } = resolveRefs()

      // Out-of-order safety (api.md §6.5): if `closed+merged` arrives BEFORE
      // `opened`, this creates the dev_item_prs row directly as 'merged'; a
      // late `synchronize` cannot downgrade it (upsertDevItemPr's state
      // transition is monotonic).
      for (const ref of refs) {
        try {
          const linked = upsertDevItemPr({
            devItemId: ref.id,
            repo: normalized.repo,
            prNumber: normalized.prNumber,
            prUrl: normalized.prUrl || null,
            state: 'merged',
            linkSource,
          })
          if (!linked) {
            console.warn(
              `[github-webhook] unknown ${devRef(ref.id)} on merged ${normalized.repo}#${normalized.prNumber} — skipped`,
            )
          }
        } catch (e) {
          console.warn(`[github-webhook] merged dev_item_prs upsert failed for ${devRef(ref.id)}:`, (e as Error).message)
        }
      }

      // Only `fixes|closes|resolves` ships. `refs|re` links only, and the
      // branch-name fallback is always 'refs' — inferring "close that item"
      // from a filename is too weak a signal to close work.
      const closing = refs
        .filter((r) => r.verb === 'fixes')
        .map((r) => r.id)
        .sort((a, b) => a - b)
      const primary = closing.length ? closing[0] : null

      // Workspace is RESOLVED from the repo, never guessed. A repo with no
      // workspace_repos row leaves workspace NULL: the entry then stays out of
      // every public feed (P4 hard-filters on workspace) — fail closed, never
      // fan out.
      let workspace: string | null = null
      try {
        const resolved = resolveWorkspaceFromRepo(normalized.repo)
        if (resolved) workspace = resolved.workspace
        else {
          console.warn(
            `[github-webhook] no workspace_repos row for ${normalized.repo} — changelog entry ${entryId} left workspace=NULL (stays out of every feed)`,
          )
        }
      } catch (e) {
        console.warn('[github-webhook] workspace resolution failed:', (e as Error).message)
      }

      try {
        const db = getDb()
        // The FK is a single column, so with multiple closing refs the LOWEST
        // id wins and the rest are recorded as internal notes below. COALESCE
        // so a NULL resolution never wipes an existing value.
        const primaryExists =
          primary != null && db.prepare('SELECT 1 FROM dev_items WHERE id = ?').get(primary) !== undefined
        db.prepare(
          `UPDATE changelog_entries
              SET workspace = COALESCE(?, workspace),
                  dev_item_id = COALESCE(?, dev_item_id),
                  updated_at = datetime('now')
            WHERE id = ?`,
        ).run(workspace, primaryExists ? primary : null, entryId)
      } catch (e) {
        console.warn('[github-webhook] changelog workspace/dev_item stamp failed:', (e as Error).message)
      }

      for (const devItemId of closing) {
        try {
          // `closed_at` is the PR's merged_at, NOT now() — a delivery replayed
          // a week later must still date the ship correctly. shipDevItem also
          // back-stamps changelog_entry_id on every shipped ref.
          const shipped = shipDevItem(devItemId, {
            closedAt: pr.merged_at ?? null,
            changelogEntryId: entryId,
          })
          if (!shipped) {
            console.warn(
              `[github-webhook] ${devRef(devItemId)} not shipped (unknown, deleted or already shipped) for ${normalized.repo}#${normalized.prNumber}`,
            )
            continue
          }
          if (primary != null && devItemId !== primary) {
            // The entry's dev_item_id can only hold one id; the co-shipped
            // items get an internal note so the linkage is still discoverable.
            addNote({
              devItemId,
              authorLabel: 'github-webhook',
              body: `Shipped in #${normalized.prNumber} alongside ${devRef(primary)}`,
              visibility: 'internal',
            })
          }
        } catch (e) {
          console.warn(`[github-webhook] ship failed for ${devRef(devItemId)}:`, (e as Error).message)
        }
      }
    } catch (e) {
      console.warn('[github-webhook] dev-item ship/stamp failed:', (e as Error).message)
    }

    // Auto-deploy on merge (obj-1955): a merge to the command-center's OWN main
    // fires a health-gated self-deploy so changes ship in small self-verifying
    // batches instead of piling up behind a manual deploy. DARK behind
    // settings.auto_deploy_enabled — while off, log a dry-run and do nothing.
    try {
      const baseRef = pr.base?.ref || null
      if (shouldAutoDeploy({ repo: normalized.repo, baseRef })) {
        if (isAutoDeployEnabled(getDb())) {
          triggerAutoDeploy(`PR #${normalized.prNumber} merged to ${baseRef}`)
        } else {
          console.log(
            `[auto-deploy] DRY-RUN — WOULD auto-deploy (PR #${normalized.prNumber} → ${baseRef}); enable via settings.auto_deploy_enabled=1`,
          )
        }
      }
    } catch (e) {
      console.warn('[auto-deploy] trigger check failed:', (e as Error).message)
    }

    return res.status(200).json({ ok: true, entryId, status })
  } catch (err) {
    // Webhooks must not retry-storm on our bugs: always 200, log the error.
    console.error('[github-webhook] handler error:', (err as Error).message)
    return res.status(200).json({ ok: false, error: (err as Error).message })
  }
})

export default router
