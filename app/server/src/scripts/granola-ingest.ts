#!/usr/bin/env tsx
// Granola meeting intelligence ingest — runs standalone via cron every 15 min.
// Fetches new meetings from the Granola public API, classifies with Claude,
// writes vault notes, and queues extracted action items for human review.
//
// Exit 0 on all errors (missing key, API failure) so cron doesn't spam alerts.

import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { listRecentMeetings, getMeeting, type GranolaTranscript } from '../services/granola-client.js'

const DB_PATH = process.env.DB_PATH || '/app/data/command-center.db'
const VAULT_BASE = process.env.VAULT_PATH || '/home/operator/second-brain'
const ts = () => new Date().toISOString()

// ── LLM Classifier ───────────────────────────────────────────────────────────

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b'

interface ActionItem {
  title: string
  description: string
  owner?: string | null
  deadline?: string | null
  source_excerpt: string
}

// Keep in sync with the `granola_processed_meetings.workspace` CHECK constraint
// (declared both below and in db/index.ts) and with the workspaces seed.
const VALID_WORKSPACES = [
  'example',
  'example-project',
  'personal',
  'operator',
  'example2',
  'example5',
] as const
type GranolaWorkspace = (typeof VALID_WORKSPACES)[number]

interface ClassificationResult {
  workspace: GranolaWorkspace
  decisions: string[]
  action_items: ActionItem[]
  attendees: string[]
  slug: string
}

// System prompt is marked ephemeral for prompt caching — saves tokens across
// back-to-back meetings processed in the same 15-min run.
const SYSTEM_PROMPT = `You are a meeting intelligence assistant. Extract structured information from meeting notes and transcripts.

Workspace classification rules:
- "example": Example Growth — digital marketing agency, SEO, content strategy, client campaigns, growth consulting
- "example-project": Example Project — physical products, manufacturing, B2B wholesale, supplier logistics, pricing
- "operator": Operator — personal holding/brand work, cross-company strategy, internal tooling
- "example2": Example3 — real-estate agent lead-gen / MLS outreach client
- "example5": Example Dental Lab — dental-lab client of Example
- "personal": Personal matters, cross-company admin, personal investments, family, health

Return ONLY valid JSON matching this exact schema (no markdown fences, no extra text):
{
  "workspace": "example" | "example-project" | "operator" | "example2" | "example5" | "personal",
  "decisions": ["string — each key decision made"],
  "action_items": [
    {
      "title": "Short imperative title (max 80 chars)",
      "description": "1-3 sentences on what needs to be done",
      "owner": "person name or null",
      "deadline": "YYYY-MM-DD or null",
      "source_excerpt": "verbatim or paraphrased quote from transcript (max 200 chars)"
    }
  ],
  "attendees": ["Full Name or email"],
  "slug": "kebab-case-meeting-topic-max-40-chars"
}`

async function classifyMeeting(meeting: GranolaTranscript): Promise<ClassificationResult | null> {
  const date = meeting.created_at.split('T')[0]
  const attendeeList = meeting.attendees.map(a => a.name || a.email).filter(Boolean).join(', ')
  const content = (meeting.transcript_text || meeting.notes_text || '(no content available)').slice(0, 8000)

  const userContent = [
    `Meeting title: ${meeting.title}`,
    `Date: ${date}`,
    attendeeList ? `Attendees: ${attendeeList}` : '',
    '',
    'Content:',
    content,
  ].filter(Boolean).join('\n')

  const messages = [{ role: 'user', content: `${SYSTEM_PROMPT}\n\n${userContent}` }]

  let text = ''

  // Try Ollama first (free, local)
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages,
        stream: false,
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(90_000),
    })
    if (res.ok) {
      const data = await res.json() as { message?: { content?: string } }
      const c = data.message?.content?.trim()
      if (c) {
        console.log(`[${ts()}] Classify via Ollama (${OLLAMA_MODEL})`)
        text = c
      }
    } else {
      console.warn(`[${ts()}] Ollama ${res.status} — falling back to Anthropic`)
    }
  } catch (err) {
    console.warn(`[${ts()}] Ollama unreachable — skipping classification: ${err instanceof Error ? err.message : err}`)
    return null
  }

  if (!text) return null

  // Extract JSON — Ollama may wrap in fences despite instructions
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    console.error(`[${ts()}] No JSON in Claude response for "${meeting.title}":`, text.slice(0, 300))
    return null
  }

  let parsed: Partial<ClassificationResult>
  try {
    parsed = JSON.parse(jsonMatch[0]) as Partial<ClassificationResult>
  } catch {
    console.error(`[${ts()}] JSON parse failed for "${meeting.title}"`)
    return null
  }

  const validWorkspaces = VALID_WORKSPACES
  const workspace = validWorkspaces.includes(parsed.workspace as GranolaWorkspace)
    ? parsed.workspace as GranolaWorkspace
    : 'example'

  const defaultSlug = meeting.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'meeting'

  return {
    workspace,
    decisions: Array.isArray(parsed.decisions) ? parsed.decisions.filter(d => typeof d === 'string') : [],
    action_items: Array.isArray(parsed.action_items) ? parsed.action_items.filter(a => a && typeof a.title === 'string') : [],
    attendees: Array.isArray(parsed.attendees) ? parsed.attendees.filter(a => typeof a === 'string') : [],
    slug: (typeof parsed.slug === 'string' ? parsed.slug.slice(0, 40) : '') || defaultSlug,
  }
}

// ── Vault Writer ──────────────────────────────────────────────────────────────

function writeVaultNote(meeting: GranolaTranscript, result: ClassificationResult): string {
  const date = meeting.created_at.split('T')[0]
  const { workspace, decisions, action_items, slug } = result

  // Merge attendees from API metadata and Claude extraction, deduped
  const apiAttendees = meeting.attendees.map(a => a.name || a.email).filter(Boolean)
  const allAttendees = [...new Set([...apiAttendees, ...result.attendees])].filter(Boolean)

  const meetingDir = path.join(VAULT_BASE, 'workspaces', workspace, 'meetings')
  fs.mkdirSync(meetingDir, { recursive: true })

  const filename = `${date}-${slug}.md`
  const filePath = path.join(meetingDir, filename)

  const yamlAttendees = allAttendees.length > 0
    ? allAttendees.map(a => `  - "${a.replace(/"/g, '\\"')}"`).join('\n')
    : '  - Unknown'

  const decisionsBody = decisions.length > 0
    ? decisions.map(d => `- ${d}`).join('\n')
    : '_No key decisions recorded._'

  const actionItemsBody = action_items.length > 0
    ? action_items
        .map(item => {
          const meta = [item.owner, item.deadline ? `due ${item.deadline}` : null].filter(Boolean).join(', ')
          return [
            `- [ ] **${item.title}**${meta ? ` (${meta})` : ''}`,
            `  ${item.description}`,
            item.source_excerpt ? `  > _"${item.source_excerpt}"_` : '',
          ].filter(Boolean).join('\n')
        })
        .join('\n')
    : '_No action items extracted._'

  const attendeesBody = allAttendees.length > 0
    ? allAttendees.map(a => `- ${a}`).join('\n')
    : '- Unknown'

  const transcriptBody = (meeting.transcript_text || meeting.notes_text || '').slice(0, 12000)
    || '_No transcript available._'

  const noteContent = `---
workspace: ${workspace}
type: meeting
date: ${date}
attendees:
${yamlAttendees}
tags: [meeting, ${workspace}]
granola_id: ${meeting.id}
---

# ${meeting.title}

## Summary

${meeting.notes_text || `${date} — ${meeting.title}`}

## Key Decisions

${decisionsBody}

## Action Items

${actionItemsBody}

## Attendees

${attendeesBody}

## Transcript

${transcriptBody}
`

  fs.writeFileSync(filePath, noteContent, 'utf-8')
  return `workspaces/${workspace}/meetings/${filename}`
}

// ── Main Pipeline ─────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.GRANOLA_API_KEY) {
    console.log(`[${ts()}] GRANOLA_API_KEY not configured — skipping run`)
    process.exit(0)
  }

  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  try {
    // Ensure tables exist — idempotent if server already created them
    db.exec(`
      CREATE TABLE IF NOT EXISTS granola_processed_meetings (
        id TEXT PRIMARY KEY,
        title TEXT,
        meeting_date TEXT,
        -- Mirrors db/index.ts. NOTE: SQLite cannot ALTER a CHECK, so widening
        -- this list only takes effect for a FRESH database.
        workspace TEXT CHECK(workspace IN ('example', 'example-project', 'personal', 'operator', 'example2', 'example5')),
        vault_path TEXT,
        processed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS granola_action_items (
        id TEXT PRIMARY KEY,
        meeting_id TEXT REFERENCES granola_processed_meetings(id),
        status TEXT NOT NULL DEFAULT 'pending-review'
          CHECK(status IN ('pending-review', 'approved', 'dismissed')),
        title TEXT,
        description TEXT,
        workspace TEXT,
        priority INTEGER NOT NULL DEFAULT 2,
        owner TEXT,
        deadline TEXT,
        source_excerpt TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_at TEXT
      );
    `)

    // Determine lookback window — use last processed timestamp or 24 h ago
    const lastRow = db.prepare(
      `SELECT processed_at FROM granola_processed_meetings ORDER BY processed_at DESC LIMIT 1`
    ).get() as { processed_at: string } | undefined

    const since = lastRow?.processed_at
      ? new Date(lastRow.processed_at)
      : new Date(Date.now() - 24 * 60 * 60 * 1000)

    console.log(`[${ts()}] Fetching Granola meetings since ${since.toISOString()}`)

    let meetings: GranolaTranscript[]
    try {
      meetings = await listRecentMeetings(since)
    } catch (err) {
      console.error(`[${ts()}] Granola API failed:`, err instanceof Error ? err.message : err)
      process.exit(0)
    }

    // Dedup against already-processed IDs
    const processedIds = new Set(
      (db.prepare('SELECT id FROM granola_processed_meetings').all() as { id: string }[]).map(r => r.id)
    )
    const newMeetings = meetings.filter(m => !processedIds.has(m.id))

    console.log(`[${ts()}] ${meetings.length} fetched, ${newMeetings.length} new`)

    if (newMeetings.length === 0) {
      console.log(`[${ts()}] Nothing new to process`)
      return
    }

    const insertMeeting = db.prepare(
      `INSERT OR IGNORE INTO granola_processed_meetings (id, title, meeting_date, workspace, vault_path, processed_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    )
    const insertActionItem = db.prepare(
      `INSERT INTO granola_action_items (id, meeting_id, title, description, workspace, priority, owner, deadline, source_excerpt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )

    let processed = 0
    for (const meeting of newMeetings) {
      try {
        // Fetch full transcript — the list endpoint omits transcript segments
        let fullMeeting = meeting
        if (!meeting.transcript_text) {
          try {
            fullMeeting = await getMeeting(meeting.id)
          } catch (err) {
            console.warn(`[${ts()}] Could not fetch full transcript for "${meeting.title}":`, err instanceof Error ? err.message : err)
          }
        }
        const result = await classifyMeeting(fullMeeting)
        if (!result) {
          console.warn(`[${ts()}] Classification failed for "${meeting.title}" — skipping`)
          continue
        }

        const vaultPath = writeVaultNote(fullMeeting, result)
        const meetingDate = fullMeeting.created_at.split('T')[0]

        db.transaction(() => {
          insertMeeting.run(fullMeeting.id, fullMeeting.title, meetingDate, result.workspace, vaultPath)
          for (const item of result.action_items) {
            insertActionItem.run(
              randomUUID(),
              fullMeeting.id,
              item.title ?? 'Untitled action',
              item.description ?? '',
              result.workspace,
              2,
              item.owner ?? null,
              item.deadline ?? null,
              item.source_excerpt ?? null,
            )
          }
        })()

        processed++
        console.log(
          `[${ts()}] OK  "${fullMeeting.title}" → ${result.workspace}` +
          `  decisions=${result.decisions.length}` +
          `  action_items=${result.action_items.length}` +
          `  vault=${vaultPath}`
        )
      } catch (err) {
        console.error(
          `[${ts()}] ERR processing "${meeting.title}":`,
          err instanceof Error ? err.message : err
        )
      }
    }

    console.log(`[${ts()}] Done — ${processed}/${newMeetings.length} new meeting(s) processed`)
  } finally {
    db.close()
  }
}

main().catch(err => {
  console.error(`[${ts()}] Fatal:`, err instanceof Error ? err.message : err)
  process.exit(0) // exit 0 — cron should not alert on expected API/config failures
})
