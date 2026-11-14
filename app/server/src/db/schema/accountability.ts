/**
 * Accountability record + the ONE human decision queue — Stage 1 (obj 900367).
 *
 * Implements §3.2 (the accountability record), §3.3 (terminal reasons), §4.1 (the
 * review-item object) and §4.3 (evidence is real, bound, or labelled missing) of
 * `architecture/2026-11-08-accountable-leads-and-decision-queue.md`.
 *
 * Idempotent, same contract as every other schema module here: called from
 * initDb() and lazily by the owning services, so a test DB that skipped initDb
 * still works.
 *
 * DELIBERATELY NOT HERE (Stage 2+, each its own objective): the preference store
 * (§5), proposal budgets (§6), approval/block fingerprints (§7.2), the second-hop
 * delivery ack (§3.5), the bot/lead registry (L1), the queue UI, voice and video.
 */
import type Database from 'better-sqlite3'

/** `waiting_on` party prefixes (§3.2). `nobody` is the bare, prefix-less value. */
export const WAITING_ON_PARTIES = ['nobody', 'human', 'agent', 'external', 'secret', 'ci'] as const

/** Lifecycle states of a review item (§4.1). */
export const REVIEW_ITEM_STATES = ['open', 'snoozed', 'waiting_on_dependency', 'decided', 'withdrawn', 'expired'] as const

/** What a person is being asked to do (§4.1). */
export const REVIEW_ITEM_KINDS = ['approval', 'signoff', 'decision', 'input_needed', 'failure', 'proposal'] as const

/** States in which an item is still LIVE — i.e. still occupies the queue. */
export const LIVE_REVIEW_ITEM_STATES = ['open', 'snoozed', 'waiting_on_dependency'] as const

export function initAccountabilitySchema(db: Database.Database): void {
  // ── §3.2 The accountability record: four columns on `objectives` ──────────
  //
  // Written by the worker, the lead or the SERVER — never inferred by a chat
  // model. That rule is enforced at the writer (services/accountability.ts),
  // which is the only sanctioned path; the columns themselves are plain text.
  //
  // PRAGMA on a missing table returns [] (lazy test DBs with no `objectives`),
  // in which case every ALTER below is skipped and this is a no-op.
  const objCols = new Set(
    (db.prepare('PRAGMA table_info(objectives)').all() as { name: string }[]).map((c) => c.name),
  )
  if (objCols.size > 0) {
    if (!objCols.has('next_action')) {
      // ONE sentence: the next concrete thing that must happen. Worker writes it
      // at each progress snapshot; a lead writes it on a handoff.
      db.exec('ALTER TABLE objectives ADD COLUMN next_action TEXT')
    }
    if (!objCols.has('next_check_at')) {
      // When the ABSENCE of progress becomes interesting. Distinct from a due
      // date: `due_at` is a promise to a person and is deliberately NOT added
      // here (§3.2) — inventing one per card produces a board of fake deadlines.
      db.exec('ALTER TABLE objectives ADD COLUMN next_check_at TEXT')
    }
    if (!objCols.has('waiting_on')) {
      // Typed: nobody | human:<user> | agent:<lead> | external:<name> |
      // secret:<NAME> | ci:<pr>. Written by whoever CAUSED the wait.
      db.exec('ALTER TABLE objectives ADD COLUMN waiting_on TEXT')
    }
    if (!objCols.has('last_meaningful_progress_at')) {
      // THE load-bearing column. `updated_at` moves on status flicker, summary
      // writes and PR-link edits, so "nothing has happened for 3 days" is
      // currently unanswerable. Only a MEANINGFUL event class moves this one
      // (services/accountability.ts MEANINGFUL_EVENT_CLASSES).
      //
      // NULL on every pre-existing row, and that is correct rather than a gap:
      // we do not know when those cards last really progressed, and back-dating
      // them to `updated_at` would manufacture a fact. The classifier treats
      // NULL as "unknown", falls back to `updated_at` for the window check, and
      // reports `basis: 'updated_at'` so a reader can tell the two apart.
      db.exec('ALTER TABLE objectives ADD COLUMN last_meaningful_progress_at TEXT')
    }
    if (!objCols.has('terminal_reason')) {
      // §3.3 — every card that STOPS carries a typed reason. A terminal status
      // with no reason is itself a queue item ("this stopped and nobody said
      // why"), which is only expressible once the column exists.
      db.exec('ALTER TABLE objectives ADD COLUMN terminal_reason TEXT')
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_objectives_next_check_at ON objectives(next_check_at) WHERE next_check_at IS NOT NULL')
  }

  // ── §4.1 review_items: ONE row per thing a PERSON must decide ─────────────
  //
  // Not per card and not per event. This is a DURABLE object, deliberately not a
  // recomputed attention view: a view cannot hold a snooze, a decision, a
  // dependency or an audit trail, and it cannot be WITHDRAWN — and withdrawal is
  // the mechanism that stops the review pile growing (§4.1).
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_items (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace             TEXT NOT NULL,
      objective_id          INTEGER NOT NULL,
      lead                  TEXT,
      kind                  TEXT NOT NULL,
      ask                   TEXT NOT NULL,
      options               TEXT,
      dedupe_key            TEXT NOT NULL,
      created_from_event_id TEXT,
      state                 TEXT NOT NULL DEFAULT 'open',
      depends_on_item_id    INTEGER REFERENCES review_items(id) ON DELETE SET NULL,
      snooze_until          TEXT,
      first_seen_at         TEXT,
      decision_choice       TEXT,
      decision_note         TEXT,
      decision_by           TEXT,
      decision_at           TEXT,
      decision_channel      TEXT,
      decision_token        TEXT,
      withdrawn_reason      TEXT,
      created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `)

  // Idempotent creation (§4.1): a REPLAYED source event must UPDATE, never
  // duplicate. Same primitive #654 uses for at-most-once wakes — a deterministic
  // id plus a UNIQUE index, so the de-duplication survives a restart and costs
  // nothing. Partial so hand-filed items (no source event) are unconstrained.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_review_items_event ON review_items(created_from_event_id) WHERE created_from_event_id IS NOT NULL')

  // dedupe_key is UNIQUE among LIVE items only (§4.1: "UNIQUE among OPEN items").
  // Live = open | snoozed | waiting_on_dependency. Once an item is decided,
  // withdrawn or expired the same question may legitimately be asked again (a
  // card reopened after sign-off genuinely needs a new sign-off), so a full
  // UNIQUE would wedge the board. This is what collapses an escalation burst to
  // one item (A16).
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_items_dedupe_live
      ON review_items(dedupe_key)
      WHERE state IN ('open','snoozed','waiting_on_dependency')
  `)
  // `routed_to` (obj 900795, the High Agency supervisor): WHO must act on the
  // item, in the same typed `<party>:<name>` form as `objectives.waiting_on`
  // (`human:<username>` / `agent:<bot slug>`). NULL on every pre-existing row and
  // on items filed by callers that do not route, and NULL means what it always
  // meant: the human queue. A human-queue reader filters
  // `routed_to IS NULL OR routed_to LIKE 'human%'`; a bot reads `agent:<its slug>`.
  // One queue, two audiences — no third review pile.
  const riCols = new Set(
    (db.prepare('PRAGMA table_info(review_items)').all() as { name: string }[]).map((c) => c.name),
  )
  if (!riCols.has('routed_to')) db.exec('ALTER TABLE review_items ADD COLUMN routed_to TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_review_items_routed ON review_items(routed_to, state) WHERE routed_to IS NOT NULL')
  db.exec('CREATE INDEX IF NOT EXISTS idx_review_items_obj ON review_items(objective_id, state)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_review_items_ws_state ON review_items(workspace, state)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_review_items_snooze ON review_items(snooze_until) WHERE snooze_until IS NOT NULL')
  // Decision replay (A9): a double-tapped mobile submit must apply ONCE. The
  // token is the idempotency key for the DECISION, and it is unique globally so
  // a token minted for item A can never be replayed against item B.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_review_items_decision_token ON review_items(decision_token) WHERE decision_token IS NOT NULL')

  // ── §4.1 append-only audit ────────────────────────────────────────────────
  // created, surfaced, snoozed, escalated, decided, withdrawn, expired — who/what
  // /when for every one. Append-only by convention: nothing in this module ever
  // issues an UPDATE or DELETE against it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_item_events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      review_item_id INTEGER NOT NULL REFERENCES review_items(id) ON DELETE CASCADE,
      event          TEXT NOT NULL,
      actor          TEXT,
      detail         TEXT,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_review_item_events_item ON review_item_events(review_item_id, id)')

  // ── §4.3 Artifact binding: the row that makes evidence REAL ───────────────
  //
  // The capture path already exists (reviewer/arena Playwright MCP →
  // `.playwright-mcp/` → curated into `tests/smoke/<scenario>/`). What was
  // missing is the BINDING: an artifact qualifies as evidence only if it carries
  // the session it came from AND the commit the run was on, plus when it was
  // captured and which tool made it.
  //
  // Both `session_id` and `commit_sha` are NOT NULL on purpose. An unbound
  // screenshot is not weak evidence, it is NOT evidence — it cannot be tied to a
  // run or a diff, so it cannot prove anything about the thing being approved.
  // Rather than storing it with empty binding fields and hoping a reader checks,
  // the schema refuses it and the service LABELS the item as having none (§4.3).
  // That is the no-fabricated-demos guarantee, expressed as a constraint.
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_item_evidence (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      review_item_id INTEGER NOT NULL REFERENCES review_items(id) ON DELETE CASCADE,
      objective_id   INTEGER NOT NULL,
      session_id     TEXT NOT NULL,
      commit_sha     TEXT NOT NULL,
      captured_at    TEXT NOT NULL,
      tool           TEXT NOT NULL,
      kind           TEXT NOT NULL,
      ref            TEXT NOT NULL,
      caption        TEXT,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_review_item_evidence_item ON review_item_evidence(review_item_id, id)')
  // The same artefact bound twice to one item is one piece of evidence, not two
  // — so a replayed bind is a no-op rather than a duplicated proof.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_review_item_evidence_unique ON review_item_evidence(review_item_id, ref, commit_sha)')
}
