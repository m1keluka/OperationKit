import { getDb } from '../db/index.js'

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

let cachedToken: { accessToken: string; expiresAt: number } | null = null

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.accessToken
  }

  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error('Gmail OAuth credentials not configured (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN)')
  }

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  })

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${await res.text()}`)
  }

  const data = await res.json() as { access_token: string; expires_in: number }
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 }
  return cachedToken.accessToken
}

async function gmailGet(path: string): Promise<unknown> {
  const token = await getAccessToken()
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Gmail GET ${path} failed ${res.status}: ${await res.text()}`)
  return res.json()
}

async function gmailPost(path: string, body: unknown): Promise<unknown> {
  const token = await getAccessToken()
  const res = await fetch(`${GMAIL_API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Gmail POST ${path} failed ${res.status}: ${await res.text()}`)
  return res.json()
}

async function ensureLabel(name: string, backgroundColor: string): Promise<string> {
  const data = await gmailGet('/users/me/labels') as { labels: Array<{ id: string; name: string }> }
  const existing = data.labels.find(l => l.name === name)
  if (existing) return existing.id

  const created = await gmailPost('/users/me/labels', {
    name,
    labelListVisibility: 'labelShow',
    messageListVisibility: 'show',
    color: { textColor: '#ffffff', backgroundColor },
  }) as { id: string }
  return created.id
}

interface EmailMessage {
  id: string
  threadId: string
  from: string
  subject: string
  snippet: string
}

async function fetchUnclassifiedEmails(maxResults = 100): Promise<EmailMessage[]> {
  const q = encodeURIComponent('in:INBOX -label:"Triage/Live" -label:"Triage/Junk" -label:"Triage/Notifications" -label:"Triage/Example Leads"')
  const data = await gmailGet(
    `/users/me/messages?q=${q}&maxResults=${maxResults}`
  ) as { messages?: Array<{ id: string; threadId: string }> }

  if (!data.messages || data.messages.length === 0) return []

  const db = getDb()
  const existing = new Set(
    (db.prepare(
      `SELECT message_id FROM gmail_triage WHERE message_id IN (${data.messages.map(() => '?').join(',')})`
    ).all(...data.messages.map(m => m.id)) as Array<{ message_id: string }>).map(r => r.message_id)
  )

  const unclassified = data.messages.filter(m => !existing.has(m.id))
  if (unclassified.length === 0) return []

  const emails: EmailMessage[] = []
  for (let i = 0; i < unclassified.length; i += 10) {
    const batch = unclassified.slice(i, i + 10)
    const details = await Promise.all(
      batch.map(m =>
        gmailGet(`/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`)
      )
    ) as Array<{
      id: string
      threadId: string
      snippet: string
      payload: { headers: Array<{ name: string; value: string }> }
    }>

    for (const msg of details) {
      const headers = msg.payload?.headers || []
      emails.push({
        id: msg.id,
        threadId: msg.threadId,
        from: headers.find(h => h.name === 'From')?.value || '',
        subject: headers.find(h => h.name === 'Subject')?.value || '(no subject)',
        snippet: msg.snippet || '',
      })
    }
  }
  return emails
}

type TriageLabel = 'live' | 'junk' | 'example-leads' | 'notifications'

interface ClassificationResult {
  messageId: string
  label: TriageLabel
}

const TRIAGE_MODEL = process.env.TRIAGE_MODEL || 'ollama'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b'
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434'

function buildClassifyPrompt(emailList: string): string {
  return `Classify each email into exactly one of 4 categories for Operator, CEO of Example Growth (M&A advisory):

"live" — genuine personal message or reply from a KNOWN contact. Ongoing conversation, client/partner comm, legal/contracts, replies where Mike initiated the thread, personal finance questions, job applicants responding to Mike's posts. The sender knows Mike personally or has an established relationship.

"junk" — ANY cold outreach or unsolicited sales email, even if written by a real human. Also: newsletters, marketing, promotions, LinkedIn/Reddit digests, unsubscribable bulk mail, generic SaaS drip emails, PR pitches, conference invitations, recruiting firms reaching out unsolicited.

"example-leads" — booking/appointment notifications from Example's scheduling system. Subject contains "New Lead from Example:" or similar.

"notifications" — system/tech alerts (GitHub CI failures, UptimeRobot UP/DOWN, deployment alerts), banking/finance transactions (Mercury charges, ACH payments, Ramp, Stripe receipts), automated invoices (Anthropic, AWS, etc.), service status emails. Informational, not actionable by Mike directly.

HARD RULES (these override everything else):
- Cold outreach / sales pitch / "I'd love to connect" / "partnership opportunity" / "quick question" (no prior relationship) → junk
- "Just following up", "wanted to reach out", "I came across your profile" → junk
- Sender is @mailchimp, @hubspot, @constantcontact, @sendgrid, or similar ESP → junk
- "Unsubscribe" link present in preview → junk (unless it's a notification service)
- "Run failed" GitHub notifications → notifications
- UptimeRobot alerts → notifications
- Mercury / Ramp / Stripe / Anthropic transaction emails → notifications
- "New Lead from Example" → example-leads
- When uncertain between live and junk: default to junk

Reply ONLY with lines like:
1: live
2: junk
3: example-leads
4: notifications
(one line per email, no other text)

Emails:

${emailList}`
}

async function classifyBatch(emails: EmailMessage[]): Promise<ClassificationResult[]> {
  const emailList = emails
    .map((e, i) => `${i + 1}. From: ${e.from}\n   Subject: ${e.subject}\n   Preview: ${e.snippet.slice(0, 250)}`)
    .join('\n\n')

  const prompt = buildClassifyPrompt(emailList)
  let text = ''

  if (TRIAGE_MODEL === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`)
    const data = await res.json() as { content: Array<{ type: string; text: string }> }
    text = data.content.find(b => b.type === 'text')?.text || ''
  } else {
    const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 512 }),
    })
    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`)
    const data = await res.json() as { choices: Array<{ message: { content: string } }> }
    text = data.choices?.[0]?.message?.content || ''
  }

  const results: ClassificationResult[] = []
  for (const line of text.split('\n')) {
    const match = line.match(/^(\d+):\s*(live|junk|example-leads|notifications)/i)
    if (match) {
      const idx = parseInt(match[1]) - 1
      if (idx >= 0 && idx < emails.length) {
        results.push({ messageId: emails[idx].id, label: match[2].toLowerCase() as TriageLabel })
      }
    }
  }
  return results
}

export interface TriageRunResult {
  processed: number
  live: number
  junk: number
  exampleLeads: number
  notifications: number
  skipped: number
  errors: string[]
}

export async function runGmailTriage(): Promise<TriageRunResult> {
  const result: TriageRunResult = { processed: 0, live: 0, junk: 0, exampleLeads: 0, notifications: 0, skipped: 0, errors: [] }

  if (!process.env.GMAIL_CLIENT_ID) {
    result.errors.push('Gmail OAuth credentials not configured — restart container after Doppler setup')
    return result
  }

  try {
    const [liveLabelId, junkLabelId, exampleLeadsLabelId, notificationsLabelId] = await Promise.all([
      ensureLabel('Triage/Live', '#16a765'),
      ensureLabel('Triage/Junk', '#e66550'),
      ensureLabel('Triage/Example Leads', '#4a86e8'),
      ensureLabel('Triage/Notifications', '#ffad47'),
    ])

    const labelMap: Record<TriageLabel, string> = {
      live: liveLabelId,
      junk: junkLabelId,
      'example-leads': exampleLeadsLabelId,
      notifications: notificationsLabelId,
    }

    const emails = await fetchUnclassifiedEmails(50)
    if (emails.length === 0) return result

    const classifications: ClassificationResult[] = []
    for (let i = 0; i < emails.length; i += 20) {
      const batchResults = await classifyBatch(emails.slice(i, i + 20))
      classifications.push(...batchResults)
    }

    result.skipped = emails.length - classifications.length

    // Apply Gmail labels — junk and notifications get archived; always remove other Triage labels to prevent doubles
    const allTriageLabelIds = Object.values(labelMap)
    for (const cl of classifications) {
      try {
        const newLabelId = labelMap[cl.label]
        const removeFromInbox = cl.label === 'junk' || cl.label === 'notifications'
        await gmailPost(`/users/me/messages/${cl.messageId}/modify`, {
          addLabelIds: [newLabelId],
          removeLabelIds: [
            ...allTriageLabelIds.filter(id => id !== newLabelId),
            ...(removeFromInbox ? ['INBOX'] : []),
          ],
        })
      } catch (err) {
        result.errors.push(`Label apply failed for ${cl.messageId}: ${err instanceof Error ? err.message : err}`)
      }
    }

    // Store in DB
    const db = getDb()
    const insert = db.prepare(
      'INSERT OR IGNORE INTO gmail_triage (message_id, thread_id, from_address, subject, snippet, label) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const insertAll = db.transaction(() => {
      for (const cl of classifications) {
        const email = emails.find(e => e.id === cl.messageId)
        if (!email) continue
        insert.run(cl.messageId, email.threadId, email.from, email.subject, email.snippet, cl.label)
        if (cl.label === 'live') result.live++
        else if (cl.label === 'junk') result.junk++
        else if (cl.label === 'example-leads') result.exampleLeads++
        else if (cl.label === 'notifications') result.notifications++
        result.processed++
      }
    })
    insertAll()

    console.log(`[gmail-triage] Processed ${result.processed}: ${result.live} live, ${result.junk} junk, ${result.exampleLeads} example-leads, ${result.notifications} notifications, ${result.skipped} skipped`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(msg)
    console.error('[gmail-triage] Error:', msg)
  }

  return result
}

export function getLiveEmailsBriefing(limitHours = 48): Array<{
  from: string
  subject: string
  snippet: string
  classified_at: string
}> {
  const db = getDb()
  const cutoff = new Date(Date.now() - limitHours * 60 * 60 * 1000).toISOString()
  return db.prepare(`
    SELECT from_address as "from", subject, snippet, classified_at
    FROM gmail_triage
    WHERE label = 'live' AND classified_at > ?
    ORDER BY classified_at DESC
    LIMIT 20
  `).all(cutoff) as Array<{ from: string; subject: string; snippet: string; classified_at: string }>
}
