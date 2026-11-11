import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

// Durable review items (obj 900367, Stage 1). Private in-memory DB per test —
// the service lazily creates its own schema, so no initDb is needed.
const {
  bindEvidence,
  createReviewItem,
  decideReviewItem,
  describeEvidence,
  getReviewItem,
  listReviewItemEvents,
  listReviewItems,
  markSeen,
  ReviewItemError,
  snoozeReviewItem,
  wakeSnoozed,
  withdrawForTerminal,
  withdrawReviewItem,
} = await import('./review-items.js')

let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
})

const NOW = new Date('2026-11-09T12:00:00.000Z')
const base = { workspace: 'operationkit', objective_id: 900303, kind: 'signoff' as const, ask: 'Accept the delivered work?' }

describe('createReviewItem — idempotency', () => {
  it('creates one item', () => {
    const { item, created } = createReviewItem(db, base, NOW)
    expect(created).toBe(true)
    expect(item.state).toBe('open')
    expect(item.dedupe_key).toBe('card:900303:signoff')
    expect(item.options).toEqual(['approve', 'changes', 'reject', 'snooze'])
    expect(listReviewItemEvents(db, item.id).map((e) => e.event)).toEqual(['created'])
  })

  it('a REPLAYED source event updates in place, never duplicates (A5)', () => {
    const a = createReviewItem(db, { ...base, created_from_event_id: 'cc_completed_900303_k1' }, NOW)
    const b = createReviewItem(db, { ...base, ask: 'Accept it? (restated)', created_from_event_id: 'cc_completed_900303_k1' }, NOW)
    expect(b.created).toBe(false)
    expect(b.item.id).toBe(a.item.id)
    expect(b.item.ask).toBe('Accept it? (restated)')
    expect(db.prepare('SELECT COUNT(*) n FROM review_items').get()).toEqual({ n: 1 })
    expect(listReviewItemEvents(db, a.item.id).map((e) => e.event)).toEqual(['created', 'replayed'])
  })

  it('a replay NEVER resurrects an item a human already decided', () => {
    const { item } = createReviewItem(db, { ...base, created_from_event_id: 'ev1' }, NOW)
    decideReviewItem(db, item.id, { choice: 'approve', by: 'operator', verified_owner: true }, NOW)
    const again = createReviewItem(db, { ...base, created_from_event_id: 'ev1' }, NOW)
    expect(again.created).toBe(false)
    expect(again.item.state).toBe('decided')
    expect(db.prepare('SELECT COUNT(*) n FROM review_items').get()).toEqual({ n: 1 })
  })

  it('collapses an escalation burst to one item via dedupe_key (A16)', () => {
    // Four genuinely-distinct events, same question. One item.
    for (const ev of ['e1', 'e2', 'e3', 'e4']) createReviewItem(db, { ...base, created_from_event_id: ev }, NOW)
    expect(db.prepare('SELECT COUNT(*) n FROM review_items').get()).toEqual({ n: 1 })
    const open = listReviewItems(db, { objective_id: 900303 })
    expect(open).toHaveLength(1)
    expect(listReviewItemEvents(db, open[0].id).filter((e) => e.event === 'escalated')).toHaveLength(3)
  })

  it('allows the same question again once the previous one is settled', () => {
    // A card reopened after sign-off genuinely needs a NEW sign-off; a global
    // UNIQUE on dedupe_key would wedge the board.
    const first = createReviewItem(db, base, NOW)
    decideReviewItem(db, first.item.id, { choice: 'approve', by: 'operator', verified_owner: true }, NOW)
    const second = createReviewItem(db, base, NOW)
    expect(second.created).toBe(true)
    expect(second.item.id).not.toBe(first.item.id)
  })

  it('rejects an unknown kind and a bad objective_id', () => {
    expect(() => createReviewItem(db, { ...base, kind: 'nope' as never }, NOW)).toThrow(ReviewItemError)
    expect(() => createReviewItem(db, { ...base, objective_id: 0 }, NOW)).toThrow(ReviewItemError)
  })
})

describe('snooze', () => {
  it('removes the item from the queue until its time comes', () => {
    const { item } = createReviewItem(db, base, NOW)
    const later = new Date(NOW.getTime() + 60 * 60_000).toISOString()
    const snoozed = snoozeReviewItem(db, item.id, later, 'operator', NOW)
    expect(snoozed.state).toBe('snoozed')
    expect(listReviewItems(db, { objective_id: 900303 }, NOW)).toHaveLength(0)

    const after = new Date(NOW.getTime() + 61 * 60_000)
    expect(wakeSnoozed(db, after)).toEqual([item.id])
    expect(getReviewItem(db, item.id)!.state).toBe('open')
    expect(listReviewItems(db, { objective_id: 900303 }, after)).toHaveLength(1)
    expect(listReviewItemEvents(db, item.id).map((e) => e.event)).toEqual(['created', 'snoozed', 'surfaced'])
  })

  it('refuses a snooze in the past — that is indistinguishable from doing nothing', () => {
    const { item } = createReviewItem(db, base, NOW)
    expect(() => snoozeReviewItem(db, item.id, new Date(NOW.getTime() - 1000).toISOString(), 'operator', NOW)).toThrow(/future/)
    expect(() => snoozeReviewItem(db, item.id, 'not-a-date', 'operator', NOW)).toThrow(/ISO/)
  })

  it('refuses to snooze an already-decided item', () => {
    const { item } = createReviewItem(db, base, NOW)
    decideReviewItem(db, item.id, { choice: 'reject', by: 'operator' }, NOW)
    expect(() => snoozeReviewItem(db, item.id, new Date(NOW.getTime() + 60_000).toISOString(), 'operator', NOW)).toThrow(ReviewItemError)
  })
})

describe('decide', () => {
  it('records the choice with a full audit row', () => {
    const { item } = createReviewItem(db, base, NOW)
    const { item: decided } = decideReviewItem(db, item.id, { choice: 'changes', by: 'operator', note: 'tighten the copy', channel: 'keyboard' }, NOW)
    expect(decided.state).toBe('decided')
    expect(decided.decision_choice).toBe('changes')
    expect(decided.decision_by).toBe('operator')
    expect(decided.decision_channel).toBe('keyboard')
    const audit = listReviewItemEvents(db, item.id)
    expect(audit.map((e) => e.event)).toEqual(['created', 'decided'])
    expect(audit[1].detail).toContain('tighten the copy')
  })

  it('a replayed decision_token applies ONCE and returns the first decision (A9)', () => {
    const { item } = createReviewItem(db, base, NOW)
    const first = decideReviewItem(db, item.id, { choice: 'approve', by: 'operator', token: 'tok-1', verified_owner: true }, NOW)
    const second = decideReviewItem(db, item.id, { choice: 'reject', by: 'operator', token: 'tok-1', verified_owner: true }, NOW)
    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.item.decision_choice).toBe('approve')
    expect(listReviewItemEvents(db, item.id).filter((e) => e.event === 'decided')).toHaveLength(1)
  })

  it('refuses a token minted for a different item', () => {
    const a = createReviewItem(db, base, NOW)
    const b = createReviewItem(db, { ...base, kind: 'decision' }, NOW)
    decideReviewItem(db, a.item.id, { choice: 'reject', by: 'operator', token: 'tok-x' }, NOW)
    expect(() => decideReviewItem(db, b.item.id, { choice: 'reject', by: 'operator', token: 'tok-x' }, NOW)).toThrow(/different review item/)
  })

  it('an approval requires a VERIFIED owner (§7.3)', () => {
    const { item } = createReviewItem(db, { ...base, kind: 'approval' }, NOW)
    bindEvidence(db, item.id, { objective_id: 900303, session_id: 's1', commit_sha: 'abc1234', tool: 'vitest', kind: 'log', ref: 'out.txt' }, NOW)
    expect(() => decideReviewItem(db, item.id, { choice: 'approve', by: 'bot' }, NOW)).toThrow(/VERIFIED owner/)
    expect(() => decideReviewItem(db, item.id, { choice: 'approve', by: 'operator', verified_owner: true, channel: 'voice' }, NOW)).toThrow(/voice/)
    const ok = decideReviewItem(db, item.id, { choice: 'approve', by: 'operator', verified_owner: true }, NOW)
    expect(ok.item.decision_choice).toBe('approve')
  })

  it('changes and reject are feedback, not authorization — any channel may give them', () => {
    const { item } = createReviewItem(db, { ...base, kind: 'approval' }, NOW)
    const r = decideReviewItem(db, item.id, { choice: 'changes', by: 'operator', channel: 'voice', note: 'no' }, NOW)
    expect(r.item.decision_choice).toBe('changes')
  })

  it('refuses a choice the item does not offer', () => {
    const { item } = createReviewItem(db, { ...base, options: ['approve', 'reject'] }, NOW)
    expect(() => decideReviewItem(db, item.id, { choice: 'snooze', by: 'operator' }, NOW)).toThrow(/not offered/)
  })
})

describe('dependencies', () => {
  it('a dependent item is parked, and is released when its blocker resolves', () => {
    const blocker = createReviewItem(db, base, NOW)
    const dependent = createReviewItem(db, { ...base, kind: 'decision', depends_on_item_id: blocker.item.id }, NOW)
    expect(dependent.item.state).toBe('waiting_on_dependency')
    expect(listReviewItems(db, { objective_id: 900303 }, NOW).map((i) => i.id)).toEqual([blocker.item.id])

    decideReviewItem(db, blocker.item.id, { choice: 'approve', by: 'operator', verified_owner: true }, NOW)
    expect(getReviewItem(db, dependent.item.id)!.state).toBe('open')
  })

  it('rejects a dependency that does not exist', () => {
    expect(() => createReviewItem(db, { ...base, depends_on_item_id: 999 }, NOW)).toThrow(/does not exist/)
  })
})

describe('withdrawal', () => {
  it('withdraws with a reason and keeps the audit trail', () => {
    const { item } = createReviewItem(db, base, NOW)
    const w = withdrawReviewItem(db, item.id, 'blocker cleared on its own', 'server', NOW)
    expect(w.state).toBe('withdrawn')
    expect(w.withdrawn_reason).toBe('blocker cleared on its own')
    expect(getReviewItem(db, item.id)).not.toBeNull()
    expect(listReviewItems(db, { objective_id: 900303 }, NOW)).toHaveLength(0)
  })

  it('is idempotent — withdrawing twice is a no-op', () => {
    const { item } = createReviewItem(db, base, NOW)
    withdrawReviewItem(db, item.id, 'first', 'server', NOW)
    withdrawReviewItem(db, item.id, 'second', 'server', NOW)
    expect(getReviewItem(db, item.id)!.withdrawn_reason).toBe('first')
    expect(listReviewItemEvents(db, item.id).filter((e) => e.event === 'withdrawn')).toHaveLength(1)
  })

  it('delivered_merged withdraws the sign-off but NOT an unrelated question', () => {
    const signoff = createReviewItem(db, base, NOW)
    const input = createReviewItem(db, { ...base, kind: 'input_needed', ask: 'Which vendor?' }, NOW)
    withdrawForTerminal(db, 900303, 'delivered_merged', { kinds: ['signoff', 'approval'] }, NOW)
    expect(getReviewItem(db, signoff.item.id)!.state).toBe('withdrawn')
    expect(getReviewItem(db, input.item.id)!.state).toBe('open')
  })
})

describe('evidence (§4.3)', () => {
  it('an item with no bound artifact is LABELLED, and approve is disabled (A7)', () => {
    const { item } = createReviewItem(db, { ...base, kind: 'approval' }, NOW)
    const ev = describeEvidence(db, item.id)
    expect(ev.items).toEqual([])
    expect(ev.approve_enabled).toBe(false)
    expect(ev.label).toContain('No verified evidence')
    expect(() => decideReviewItem(db, item.id, { choice: 'approve', by: 'operator', verified_owner: true }, NOW)).toThrow(/no verified evidence/)
  })

  it('binds a real artifact to a session AND a commit', () => {
    const { item } = createReviewItem(db, base, NOW)
    const bound = bindEvidence(db, item.id, {
      objective_id: 900303, session_id: 'sess-abc', commit_sha: '7410ade', tool: 'playwright-mcp',
      kind: 'screenshot', ref: 'tests/smoke/queue/01-open.png',
    }, NOW)
    expect(bound.session_id).toBe('sess-abc')
    expect(bound.commit_sha).toBe('7410ade')
    const ev = describeEvidence(db, item.id)
    expect(ev.approve_enabled).toBe(true)
    expect(ev.label).toContain('1 verified artifact')
    expect(ev.label).toContain('7410ade')
  })

  it('refuses evidence that cannot bind — an unbound artifact proves nothing', () => {
    const { item } = createReviewItem(db, base, NOW)
    const good = { objective_id: 900303, session_id: 's1', commit_sha: 'abc1234', tool: 'vitest', kind: 'log', ref: 'r' }
    expect(() => bindEvidence(db, item.id, { ...good, session_id: '' }, NOW)).toThrow(/session_id/)
    expect(() => bindEvidence(db, item.id, { ...good, commit_sha: '' }, NOW)).toThrow(/commit_sha/)
    // A placeholder is not a commit; storing it would make the binding a lie.
    expect(() => bindEvidence(db, item.id, { ...good, commit_sha: 'latest' }, NOW)).toThrow(/git object id/)
    expect(describeEvidence(db, item.id).approve_enabled).toBe(false)
  })

  it('re-binding the same artifact does not inflate the proof', () => {
    const { item } = createReviewItem(db, base, NOW)
    const input = { objective_id: 900303, session_id: 's1', commit_sha: 'abc1234', tool: 'vitest', kind: 'log', ref: 'out.txt' }
    const a = bindEvidence(db, item.id, input, NOW)
    const b = bindEvidence(db, item.id, input, NOW)
    expect(b.id).toBe(a.id)
    expect(describeEvidence(db, item.id).items).toHaveLength(1)
  })
})

describe('listing', () => {
  it('filters by workspace rather than ranking by it', () => {
    createReviewItem(db, base, NOW)
    createReviewItem(db, { ...base, workspace: 'example', objective_id: 111 }, NOW)
    const mine = listReviewItems(db, { workspace: 'operationkit' }, NOW)
    expect(mine).toHaveLength(1)
    expect(mine[0].workspace).toBe('operationkit')
  })

  it('markSeen records first_seen_at exactly once', () => {
    const { item } = createReviewItem(db, base, NOW)
    expect(item.first_seen_at).toBeNull()
    const seen = markSeen(db, item.id, 'operator', NOW)
    expect(seen.first_seen_at).toBe(NOW.toISOString())
    const later = new Date(NOW.getTime() + 60_000)
    expect(markSeen(db, item.id, 'operator', later).first_seen_at).toBe(NOW.toISOString())
    expect(listReviewItemEvents(db, item.id).filter((e) => e.event === 'surfaced')).toHaveLength(1)
  })
})
