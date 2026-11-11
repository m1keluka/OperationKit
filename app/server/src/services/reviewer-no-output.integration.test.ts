/**
 * obj 900322 (corrections round) — the REVIEWER no-output gap.
 *
 * The worker-side truthfulness fix is scoped to `status='working'`
 * (`handleDeadSessionOutcome`). It therefore cannot reach the one remaining
 * lifecycle where silence still completed a card: a standalone `task` whose
 * REVIEWER session produced nothing. `pollAIReviewSessions`'s `!verdict` branch
 * sent exactly that case to `done` — an infrastructure failure on the review
 * side silently marking the work verified.
 *
 * This drives `pollAIReviewSessions` itself, over a real DB and a real (empty)
 * reviewer transcript.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reviewer-nooutput-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-900322-rv'
process.env.TRANSCRIPT_DIR = TMP
process.env.PROJECTS_DIR = TMP

vi.mock('../ws/index.js', () => ({ broadcast: vi.fn(), broadcastToObjective: vi.fn() }))
vi.mock('./notifier.js', () => ({ sendTelegram: vi.fn(), insertAlert: vi.fn() }))
vi.mock('./session-intel-pipeline.js', () => ({ queueExtraction: vi.fn() }))
// The reviewer session is over; nothing here should reach tmux or the network.
vi.mock('./session-control.js', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return { ...actual, getSessionState: () => 'dead', killTmuxByName: () => false }
})

const { getDb, initDb } = await import('../db/index.js')
const { pollAIReviewSessions } = await import('./poller-ai-review.js')

beforeAll(() => { initDb() })
afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

let nextId = 9300322
/**
 * A ROUTINE-SPAWNED task under AI review — the shape that actually reached the
 * `done` arm. `mustRouteToHumanReview` exempts routine/delegator-spawned cards
 * (so jobs don't flood Needs You), and `delegatorParentOf` is null for a card
 * with no parent, so the `!verdict` branch wrote `done` with nothing verified.
 * A hand-made top-level card was never at risk; seeding one would have made
 * this test pass without the fix.
 */
function seedUnderReview(opts: { transcript: string; type?: string }): { id: number; sid: string } {
  const db = getDb()
  const id = nextId++
  const sid = `cc-${id}-reviewer`
  db.prepare(
    `INSERT INTO objectives (id, title, type, status, effort, project, workspace, ai_review_session_id, ai_review_iteration, routine_id)
     VALUES (?, ?, ?, 'ai_review', 'normal', 'operationkit', 'operationkit', ?, 1, 4242)`,
  ).run(id, `obj ${id}`, opts.type ?? 'task', sid)
  fs.writeFileSync(path.join(TMP, `${sid}.jsonl`), opts.transcript)
  return { id, sid }
}

function cardOf(id: number) {
  return getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as {
    status: string; ai_review_verdict: string | null; ai_review_findings: string | null
  }
}

describe('a REVIEWER that produced nothing must not mark the card done', () => {
  it('empty reviewer transcript → review + blocked, naming it a review-side failure', async () => {
    const { id } = seedUnderReview({ transcript: '' })
    await pollAIReviewSessions()

    const card = cardOf(id)
    expect(card.status).toBe('review')           // <- was 'done' before the fix
    expect(card.ai_review_verdict).toBe('blocked')
    expect(card.ai_review_findings).toContain('produced no output at all')
    // It must not blame the worker for a reviewer infra failure.
    expect(card.ai_review_findings).toContain('not a judgement about the work')
  })

  it('a reviewer that DID run but emitted no <verdict> keeps its existing handling', async () => {
    const { id } = seedUnderReview({
      transcript: [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I reviewed the diff and it looks fine, but I forgot the tag.' }] } }),
        JSON.stringify({ type: 'result', subtype: 'success' }),
      ].join('\n') + '\n',
    })
    await pollAIReviewSessions()

    const card = cardOf(id)
    // Narrowness check: the new branch did NOT fire. This reviewer ran and
    // emitted prose, so it keeps its pre-existing handling verbatim — the old
    // findings text, and whatever status the pre-existing rules choose (the
    // human-review routing rules decide that, and this fix does not touch them).
    expect(card.status).toBe('done')  // unchanged: this reviewer ran
    expect(card.ai_review_verdict).toBe('blocked')
    expect(card.ai_review_findings).toBe('Reviewer ended without emitting a verdict block.')
    expect(card.ai_review_findings).not.toContain('produced no output at all')
  })
})
