// Assistant morning nudge — a daily Telegram push that acts like an EA keeping Mike on
// his open loops. Fires once per day at 07:00 America/New_York (DST-aware) and sends a
// terse, prioritized "close these today" digest.
//
// Design notes:
// - Lightweight minute-tick scheduler (mirrors dream-cycle.ts). It does NOT spawn a
//   Claude session — it reads loops directly and sends one Telegram message. Cheap +
//   reliable.
// - Reuses sendTelegram() (notifier.ts) for outbound and callHaikuSummarizer()
//   (mentor-context.ts) to phrase the nudge in a human EA tone, with a DETERMINISTIC
//   text fallback (buildNudgeText) when the LLM is unavailable.
// - Gated by JARVIS_NUDGE_ENABLED (default ON). One-way only — replies are out of scope.
import { listLoops, type Loop } from './loops.js'
import { sendTelegram } from './notifier.js'
import { callHaikuSummarizer } from './mentor-context.js'

const CHECK_INTERVAL_MS = 60 * 1000
const FIRE_HOUR = '07' // 7am, America/New_York
const FIRE_MINUTE = '00'

let schedulerTimer: ReturnType<typeof setInterval> | null = null
let lastFiredDate: string | null = null // YYYY-MM-DD (ET) of last send

// Current wall-clock in Eastern time, DST-aware, as zero-padded parts.
function nowEastern(): { date: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date())
  const get = (t: string): string => parts.find(p => p.type === t)?.value ?? ''
  // Intl can emit '24' for midnight on some runtimes — normalize to '00'.
  const hour = get('hour') === '24' ? '00' : get('hour')
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour, minute: get('minute') }
}

interface NudgeDigest {
  open: Loop[]
  overdue: Loop[]
  queued: number
  working: number
  oldest: Loop[]
}

function buildDigest(loops: Loop[], todayET: string): NudgeDigest {
  const open = loops.filter(l => l.status !== 'done')
  const overdue = open.filter(l => !!l.due && l.due < todayET)
  const queued = open.filter(l => l.status === 'queued').length
  const working = open.filter(l => l.status === 'working').length
  const oldest = [...open].sort((a, b) => (a.opened || '').localeCompare(b.opened || '')).slice(0, 3)
  return { open, overdue, queued, working, oldest }
}

// Deterministic nudge text — used as the LLM fallback and unit-tested without network.
export function buildNudgeText(loops: Loop[], todayET: string): string {
  const d = buildDigest(loops, todayET)
  if (d.open.length === 0) {
    return '☀️ Morning. Inbox zero on loops — nothing open. Keep it that way. 💪'
  }
  const lines: string[] = []
  lines.push(`☀️ Morning. You have ${d.open.length} open loop${d.open.length === 1 ? '' : 's'} (${d.working} working, ${d.queued} queued).`)
  if (d.overdue.length > 0) {
    lines.push('')
    lines.push(`🔴 ${d.overdue.length} OVERDUE — clear these first:`)
    for (const l of d.overdue.slice(0, 5)) lines.push(`  • ${l.title} (due ${l.due})`)
  }
  lines.push('')
  lines.push('🎯 Top 3 to close today:')
  for (const l of d.oldest) {
    const meta = [l.project, l.due ? `due ${l.due}` : ''].filter(Boolean).join(' · ')
    lines.push(`  • ${l.title}${meta ? ` (${meta})` : ''}`)
  }
  lines.push('')
  lines.push('Pick one and close it before noon. — Assistant')
  return lines.join('\n')
}

// Build the LLM prompt for an EA-toned nudge; the model output replaces buildNudgeText
// when available.
function buildNudgePrompt(loops: Loop[], todayET: string): string {
  const d = buildDigest(loops, todayET)
  const list = d.open
    .map(l => `- [${l.status}] ${l.title}${l.due ? ` (due ${l.due}${l.due < todayET ? ' — OVERDUE' : ''})` : ''}${l.project ? ` {${l.project}}` : ''}`)
    .join('\n')
  return [
    "You are Assistant, Mike's chief-of-staff. Write a SHORT Telegram message (max ~8 lines) that pushes him to close his open loops today.",
    'Be terse, motivating, and specific. Lead with anything OVERDUE. Name the top 2-3 he should close today. End with a one-line kick.',
    'No preamble, no markdown headers — plain text with a few emoji is fine.',
    `Today (ET) is ${todayET}. His open loops:`,
    list,
  ].join('\n')
}

// Run one nudge: compose (LLM with deterministic fallback) and send. Never throws.
export async function runAssistantNudge(): Promise<boolean> {
  try {
    const todayET = nowEastern().date
    const loops = listLoops()
    const fallback = buildNudgeText(loops, todayET)
    let text = fallback
    try {
      const llm = await callHaikuSummarizer(buildNudgePrompt(loops, todayET))
      if (llm && llm.trim()) text = llm.trim()
    } catch {
      // LLM is best-effort; keep the deterministic fallback.
    }
    return await sendTelegram(text)
  } catch (err) {
    console.error('[assistant-nudge] run failed:', err)
    return false
  }
}

/**
 * Start the Assistant morning-nudge scheduler.
 * Fires once daily at 07:00 America/New_York (DST-aware).
 * Controlled by JARVIS_NUDGE_ENABLED env var (default: true).
 */
export function startAssistantNudgeScheduler(): void {
  if (process.env.JARVIS_NUDGE_ENABLED === 'false') {
    console.log('[assistant-nudge] Scheduler disabled via JARVIS_NUDGE_ENABLED=false')
    return
  }
  if (schedulerTimer) return

  schedulerTimer = setInterval(() => {
    const { date, hour, minute } = nowEastern()
    if (hour === FIRE_HOUR && minute === FIRE_MINUTE && lastFiredDate !== date) {
      lastFiredDate = date
      runAssistantNudge()
        .then(ok => console.log(`[assistant-nudge] Morning nudge ${ok ? 'sent' : 'failed to send'} (${date} 07:00 ET)`))
        .catch(err => console.error('[assistant-nudge] Scheduled nudge failed:', err))
    }
  }, CHECK_INTERVAL_MS)

  console.log('[assistant-nudge] Scheduler started — daily 07:00 America/New_York')
}
