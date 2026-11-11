#!/usr/bin/env tsx
/**
 * Build the knowledge-base wiki's demo imports (obj 720117).
 *
 *   cd app/server && npx tsx src/scripts/make-kb-wiki-samples.ts
 *
 * Writes ENTIRELY MADE-UP chats and calls for "Fernleaf Garden Supply", a small
 * independent garden centre with a landscaping crew, into
 * src/services/kb-wiki/sample-data/:
 *   - claude-export-sample.zip          6 Claude chats (one pure small talk, one coding help with no business facts)
 *   - chatgpt-export-sample.zip         5 ChatGPT chats with real mapping trees (a system node, an edited branch, tool calls)
 *   - call-2026-09-14-supplier-review.vtt     Teams/Zoom style captions with <v Name> voice tags
 *   - call-2026-09-21-weekly-ops.srt          SRT captions with "Name: text" lines
 *   - call-2026-09-28-client-walkthrough.json the generic JSON transcript format
 *   - README.md
 *
 * Deterministic: fixed ids and timestamps, fixed zip dates, no randomness.
 * The files cross-reference each other on purpose (the same people, supplier and
 * client turn up in chats and calls) so the import shows pages built up from
 * several sources, and they disagree in one place (the Hillcrest monthly price)
 * so a question can show "which source said what".
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { writeZip } from '../services/doc-ingest/zip.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(HERE, '../services/kb-wiki/sample-data')

/** Fixed clock: minutes after a base ISO time. */
function at(base: string, minutes: number): string {
  return new Date(Date.parse(base) + minutes * 60_000).toISOString()
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Claude export
// ═════════════════════════════════════════════════════════════════════════════

type Turn = [sender: 'human' | 'assistant', text: string]

interface ClaudeChatSpec { uuid: string; name: string; start: string; turns: Turn[]; attachment?: { onTurn: number; file_name: string; extracted_content: string }; contentBlocksOnly?: boolean }

const CLAUDE_CHATS: ClaudeChatSpec[] = [
  {
    uuid: '0b6f1d2e-0001-4c1a-9e00-fe1eaf000001',
    name: 'Spring opening plan',
    start: '2026-02-03T09:12:00Z',
    turns: [
      ['human', "I run Fernleaf Garden Supply, an independent garden centre with a small landscaping crew. I want to plan our spring opening weekend. Last year we opened on the third Saturday of March and it was too late — people had already bought seed potatoes at the big box store."],
      ['assistant', 'Opening a week or two earlier usually catches the first warm weekend. What dates are you considering, and what do you need ready by then?'],
      ['human', "Let's open on Saturday 14 March this year. We need the seed potatoes, onion sets and early bedding in by the 10th. Sam Okafor (my store manager) will place the order with Greenway Growers by 20 February."],
      ['assistant', 'Good. With a 14 March opening and stock in by the 10th, the 20 February order date gives Greenway about two and a half weeks. Do you want a promotion for the weekend?'],
      ['human', 'Yes — 10% off all seed potatoes for the opening weekend, and a free soil test for anyone who signs up to the newsletter. I decided we will not do the bouncy castle again, it cost too much for what it brought in.'],
      ['assistant', 'Noted: 10% off seed potatoes, free soil test with newsletter sign-up, no bouncy castle. Who will run the soil tests?'],
      ['human', 'Priya Nair, our bookkeeper, wants the soil test kits costed first. She will send me the numbers by 27 February. Sam will run the tests on the day.'],
    ],
  },
  {
    uuid: '0b6f1d2e-0002-4c1a-9e00-fe1eaf000002',
    name: 'Hillcrest maintenance contract pricing',
    start: '2026-04-21T14:05:00Z',
    turns: [
      ['human', 'Hillcrest Property Management wants a quote for grounds maintenance at their 6 apartment sites in town. Their facilities manager is Marcus Bell. They want fortnightly mowing, hedge trimming twice a year and leaf clearance in autumn.'],
      ['assistant', "Fortnightly visits across 6 sites is roughly 13 visits per site per growing season. How long does your crew need per site, and what's your hourly crew rate?"],
      ['human', 'About 2.5 hours per site per visit with a 3-person crew. Our crew rate is $135 an hour for the three of them.'],
      ['assistant', "That's about $337.50 per site visit. Across 6 sites and 13 visits that's about $26,325 for mowing alone, before hedges and leaves. Spread over 12 months that's roughly $2,190 a month."],
      ['human', "OK. We'll quote Hillcrest $2,400 a month on a 12-month contract including the hedges and leaf clearance. I'll send the quote to Marcus by Friday 24 April."],
    ],
    attachment: {
      onTurn: 0,
      file_name: 'hillcrest-sites.txt',
      extracted_content: 'Hillcrest sites: Maple Court, Birch Row, Elm Gardens, Willow House, Cedar Point, Ash Lane. Gate codes held by Marcus Bell.',
    },
  },
  {
    uuid: '0b6f1d2e-0003-4c1a-9e00-fe1eaf000003',
    name: 'Bookkeeping month-end checklist',
    start: '2026-05-02T08:30:00Z',
    contentBlocksOnly: true,
    turns: [
      ['human', 'Priya Nair does our books two days a week. She asked for a month-end checklist so the till reports, the landscaping invoices and the supplier bills all reach her by the 3rd working day of the month.'],
      ['assistant', 'A simple checklist: 1) Z-reports from the till, 2) landscaping invoices raised, 3) supplier bills scanned, 4) card machine statement. Who sends each?'],
      ['human', 'Sam sends the till reports and supplier bills. I raise the landscaping invoices. From June we move the books from spreadsheets to an online bookkeeping tool — Priya picks which one by 31 May.'],
    ],
  },
  {
    uuid: '0b6f1d2e-0004-4c1a-9e00-fe1eaf000004',
    name: 'Summer staff rota',
    start: '2026-05-18T19:40:00Z',
    turns: [
      ['human', "We need two seasonal staff for June to August — one for the tills and one for the plant area. Weekends are the problem. Sam Okafor can't do Sundays in July."],
      ['assistant', 'A rota where the two seasonal hires cover alternate Sundays and you or a regular covers July Sundays would work. What hours?'],
      ['human', 'Opening hours are 8 to 6 in summer. We decided to pay seasonal staff $17.50 an hour. Sam will post the job ad this week and interview on 28 May.'],
    ],
  },
  {
    uuid: '0b6f1d2e-0005-4c1a-9e00-fe1eaf000005',
    name: 'Names for the shop cat',
    start: '2026-06-07T21:02:00Z',
    turns: [
      ['human', 'Ha, a stray cat has adopted the greenhouse. Give me some funny names for it.'],
      ['assistant', 'How about Basil, Sir Pounce-a-lot, Fern Gully, Mulch, or Captain Whiskers?'],
      ['human', 'Mulch! Love it. Tell me a gardening joke too.'],
      ['assistant', "Why did the tomato blush? Because it saw the salad dressing."],
    ],
  },
  {
    uuid: '0b6f1d2e-0006-4c1a-9e00-fe1eaf000006',
    name: 'Spreadsheet formula help',
    start: '2026-06-15T11:20:00Z',
    turns: [
      ['human', 'How do I make a spreadsheet formula that looks up a value in another tab? I always forget the syntax.'],
      ['assistant', 'Use XLOOKUP: =XLOOKUP(A2, Sheet2!A:A, Sheet2!B:B, "not found"). It looks up A2 in column A of Sheet2 and returns the matching value from column B.'],
      ['human', 'And if I want to ignore case?'],
      ['assistant', 'XLOOKUP already ignores case. For an exact case match, combine EXACT with FILTER: =FILTER(Sheet2!B:B, EXACT(Sheet2!A:A, A2)).'],
    ],
  },
]

function claudeExport(): Buffer {
  const conversations = CLAUDE_CHATS.map(c => ({
    uuid: c.uuid,
    name: c.name,
    created_at: c.start,
    updated_at: at(c.start, c.turns.length * 2 + 5),
    account: { uuid: 'acct-fernleaf-demo' },
    chat_messages: c.turns.map(([sender, text], i) => ({
      uuid: `${c.uuid.slice(0, 8)}-msg-${String(i + 1).padStart(3, '0')}`,
      sender,
      text: c.contentBlocksOnly ? '' : text,
      content: [{ type: 'text', text }],
      created_at: at(c.start, i * 2),
      updated_at: at(c.start, i * 2),
      attachments: c.attachment && c.attachment.onTurn === i ? [{ file_name: c.attachment.file_name, file_size: c.attachment.extracted_content.length, file_type: 'txt', extracted_content: c.attachment.extracted_content }] : [],
      files: [],
    })),
  }))
  const users = [{ uuid: 'acct-fernleaf-demo', full_name: 'Rosa Delgado', email_address: 'rosa@example.com' }]
  return writeZip([
    ['conversations.json', JSON.stringify(conversations, null, 2)],
    ['users.json', JSON.stringify(users, null, 2)],
    ['projects.json', '[]'],
  ])
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. ChatGPT export (real mapping tree)
// ═════════════════════════════════════════════════════════════════════════════

interface GptNodeSpec {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  text: string
  parent: string | null
  contentType?: string
  hidden?: boolean
  recipient?: string
}

function gptConversation(id: string, title: string, start: string, nodes: GptNodeSpec[], current: string) {
  const t0 = Date.parse(start) / 1000
  const mapping: Record<string, unknown> = {
    'client-created-root': { id: 'client-created-root', message: null, parent: null, children: [] as string[] },
  }
  nodes.forEach((n, i) => {
    mapping[n.id] = {
      id: n.id,
      message: {
        id: n.id,
        author: { role: n.role, name: n.role === 'tool' ? 'python' : null, metadata: {} },
        create_time: n.role === 'system' ? null : t0 + i * 60,
        update_time: null,
        content: n.contentType === 'code'
          ? { content_type: 'code', language: 'python', text: n.text }
          : n.contentType === 'execution_output'
            ? { content_type: 'execution_output', text: n.text }
            : { content_type: 'text', parts: [n.text] },
        status: 'finished_successfully',
        end_turn: n.role === 'assistant' ? true : null,
        weight: 1,
        metadata: n.hidden ? { is_visually_hidden_from_conversation: true } : {},
        recipient: n.recipient ?? 'all',
      },
      parent: n.parent ?? 'client-created-root',
      children: [] as string[],
    }
  })
  for (const [nid, node] of Object.entries(mapping)) {
    const p = (node as { parent: string | null }).parent
    if (p) (mapping[p] as { children: string[] }).children.push(nid)
  }
  return { title, create_time: t0, update_time: t0 + nodes.length * 60, mapping, moderation_results: [], current_node: current, conversation_id: id, id, default_model_slug: 'gpt-demo' }
}

function chatgptExport(): Buffer {
  const conversations = [
    gptConversation('6f0e1a00-0000-4b00-a000-000000000001', 'Greenway Growers late deliveries', '2026-03-24T10:00:00Z', [
      { id: 'g1-sys', role: 'system', text: 'You are a helpful assistant.', parent: null, hidden: true },
      { id: 'g1-u1', role: 'user', text: 'Our plant supplier Greenway Growers has been late on three deliveries this month. Tom Whitfield is our account rep there. How should I raise it?', parent: 'g1-sys' },
      { id: 'g1-a1', role: 'assistant', text: 'Keep it factual: list the order dates, promised dates and actual dates, explain the impact on sales, and ask for a fixed delivery day.', parent: 'g1-u1' },
      // The first version of this question was edited — the old branch must NOT be imported.
      { id: 'g1-u2-old', role: 'user', text: 'OLD BRANCH: maybe we should drop them and switch suppliers straight away?', parent: 'g1-a1' },
      { id: 'g1-a2-old', role: 'assistant', text: 'OLD BRANCH: switching suppliers mid-season is risky.', parent: 'g1-u2-old' },
      { id: 'g1-u2', role: 'user', text: "We decided to give Greenway one more month. I'll ask Tom Whitfield for a fixed Tuesday delivery slot and a 5% credit on the late orders. If April is late again we'll trial Riverbend Nursery as a second supplier.", parent: 'g1-a1' },
      { id: 'g1-a2', role: 'assistant', text: "That's a fair approach — a clear deadline, a concrete ask and a fallback.", parent: 'g1-u2' },
    ], 'g1-a2'),
    gptConversation('6f0e1a00-0000-4b00-a000-000000000002', 'Autumn newsletter ideas', '2026-08-29T16:30:00Z', [
      { id: 'g2-u1', role: 'user', text: 'Ideas for the Fernleaf Garden Supply autumn newsletter? We have about 1,800 subscribers.', parent: null },
      { id: 'g2-a1', role: 'assistant', text: 'Bulb planting guide, a leaf-mulch how-to, a customer garden of the month, and an early booking offer for winter pruning.', parent: 'g2-u1' },
      { id: 'g2-u2', role: 'user', text: "Good. We'll lead with the bulb planting guide and offer 15% off spring bulbs bought before 15 October. Priya Nair will send it on 10 September.", parent: 'g2-a1' },
    ], 'g2-u2'),
    gptConversation('6f0e1a00-0000-4b00-a000-000000000003', 'New mower for the landscaping crew', '2026-07-08T07:45:00Z', [
      { id: 'g3-u1', role: 'user', text: 'Our landscaping crew mower broke down twice in June. Should we repair or replace? It is 7 years old and the repair quote is $1,150.', parent: null },
      { id: 'g3-a1', role: 'assistant', text: 'At 7 years with repeated failures, replacing usually wins once you count crew downtime. What would a replacement cost?', parent: 'g3-u1' },
      { id: 'g3-u2', role: 'user', text: 'A commercial zero-turn mower is about $9,800. We decided to replace it before the Hillcrest contract starts — Sam Okafor will order it by 15 July.', parent: 'g3-a1' },
    ], 'g3-u2'),
    gptConversation('6f0e1a00-0000-4b00-a000-000000000004', 'Pub quiz warm-up', '2026-09-05T20:10:00Z', [
      { id: 'g4-u1', role: 'user', text: 'Give me five pub quiz questions about the moon.', parent: null },
      { id: 'g4-a1', role: 'assistant', text: '1) How long does sunlight take to reach the Moon? 2) Who was the second person on the Moon? 3) What is the Sea of Tranquility? 4) How far away is the Moon? 5) Does the Moon have an atmosphere?', parent: 'g4-u1' },
    ], 'g4-a1'),
    gptConversation('6f0e1a00-0000-4b00-a000-000000000005', 'Plant sales by month', '2026-09-30T12:00:00Z', [
      { id: 'g5-u1', role: 'user', text: 'Here are our plant sales: June $41,200, July $38,900, August $29,400, September $24,100. Which month dropped the most?', parent: null },
      { id: 'g5-a1', role: 'assistant', text: "sales = {'Jun': 41200, 'Jul': 38900, 'Aug': 29400, 'Sep': 24100}\nprint({m: sales[m] for m in sales})", parent: 'g5-u1', contentType: 'code', recipient: 'python' },
      { id: 'g5-t1', role: 'tool', text: "{'Jun': 41200, 'Jul': 38900, 'Aug': 29400, 'Sep': 24100}", parent: 'g5-a1', contentType: 'execution_output' },
      { id: 'g5-a2', role: 'assistant', text: 'August dropped the most: $9,500 down on July (about 24%).', parent: 'g5-t1' },
      { id: 'g5-u2', role: 'user', text: "Makes sense — the heatwave. We'll run a late-summer perennials sale in August next year to soften the dip.", parent: 'g5-a2' },
    ], 'g5-u2'),
  ]
  return writeZip([
    ['conversations.json', JSON.stringify(conversations, null, 2)],
    ['user.json', JSON.stringify({ id: 'user-fernleaf-demo', email: 'rosa@example.com' })],
    ['message_feedback.json', '[]'],
  ])
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Call transcripts
// ═════════════════════════════════════════════════════════════════════════════

function clock(sec: number, sep: '.' | ','): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}000`
}

type Line = [startSec: number, speaker: string, text: string]

const SUPPLIER_REVIEW: Line[] = [
  [2, 'Rosa Delgado', 'Thanks for making time, Tom. I wanted to go over the spring and summer deliveries.'],
  [9, 'Tom Whitfield', 'Of course. I know April and May were better than March.'],
  [15, 'Tom Whitfield', 'The fixed Tuesday slot has helped our drivers a lot.'],
  [22, 'Sam Okafor', 'Every delivery since the start of April has arrived on the Tuesday, which is great for us.'],
  [31, 'Rosa Delgado', 'So we have agreed to keep Greenway Growers as our main plant supplier for next year.'],
  [40, 'Tom Whitfield', 'Thank you. For next season I can offer 4% off if you commit to a standing weekly order.'],
  [52, 'Rosa Delgado', 'We will take the 4% on a standing order from March to June, reviewed every month.'],
  [63, 'Sam Okafor', 'I will send Tom the standing order list by 1 October.'],
  [70, 'Tom Whitfield', 'And I will send the updated price list for autumn bulbs by Friday.'],
  [78, 'Rosa Delgado', 'Great. We will drop the Riverbend Nursery trial then.'],
]

function vtt(lines: Line[]): string {
  const cues = lines.map(([s, who, text], i) => {
    const next = lines[i + 1]?.[0] ?? s + 6
    return `${i + 1}\n${clock(s, '.')} --> ${clock(next, '.')}\n<v ${who}>${text}</v>`
  })
  return `WEBVTT\n\nNOTE Supplier review — Fernleaf Garden Supply and Greenway Growers\n\n${cues.join('\n\n')}\n`
}

const WEEKLY_OPS: Line[] = [
  [1, 'Sam Okafor', 'Morning all. Quick weekly ops, three things: the Hillcrest start, the bulbs and the till.'],
  [10, 'Rosa Delgado', 'Hillcrest signed. They pushed back on price so we agreed $2,250 a month, not the $2,400 we quoted.'],
  [21, 'Rosa Delgado', 'First visit is Monday 5 October at Maple Court.'],
  [24, 'Priya Nair', 'I have set Hillcrest up in the books: invoiced on the first of the month, payment due in 30 days.'],
  [27, 'Jo Fairweather', 'The crew can do Maple Court and Birch Row on Mondays and the other four sites on Thursdays.'],
  [38, 'Sam Okafor', 'Autumn bulbs arrive next Tuesday. I need two people to set up the bulb display on Wednesday.'],
  [47, 'Jo Fairweather', 'I can lend one person from the crew on Wednesday morning.'],
  [55, 'Priya Nair', 'One from me: the card machine has been double-charging refunds. I have logged it with the provider.'],
  [66, 'Rosa Delgado', 'Priya, please chase them by Friday, and until it is fixed we do refunds as store credit.'],
  [74, 'Sam Okafor', 'Decided then. I will put a sign up at the tills today.'],
]

function srt(lines: Line[]): string {
  return lines.map(([s, who, text], i) => {
    const next = lines[i + 1]?.[0] ?? s + 6
    return `${i + 1}\n${clock(s, ',')} --> ${clock(next, ',')}\n${who}: ${text}\n`
  }).join('\n')
}

function clientWalkthrough(): string {
  const doc = {
    title: 'Hillcrest grounds walkthrough',
    date: '2026-09-28',
    source: 'phone recording, transcribed',
    participants: ['Rosa Delgado', 'Jo Fairweather', 'Marcus Bell'],
    summary: 'Site walkthrough of the six Hillcrest Property Management apartment sites before the maintenance contract starts.',
    segments: [
      { speaker: 'Marcus Bell', start: 4, text: 'Welcome to Maple Court. The residents mainly complain about the hedges by the car park.' },
      { speaker: 'Jo Fairweather', start: 15, text: 'Those are overgrown privet. We can cut them back hard in the first hedge visit.' },
      { speaker: 'Marcus Bell', start: 26, text: 'Cedar Point has a sprinkler system. Please do not mow on Wednesdays, that is when it runs.' },
      { speaker: 'Rosa Delgado', start: 38, text: 'Understood — Cedar Point moves to the Thursday round, never Wednesday.' },
      { speaker: 'Marcus Bell', start: 47, text: 'Gate codes change every quarter. I will email the October codes to Jo before the first visit.' },
      { speaker: 'Rosa Delgado', start: 58, text: 'We will invoice monthly on the first, payment within 14 days, as in the contract.' },
      { speaker: 'Marcus Bell', start: 66, text: 'Good. If the first quarter goes well we would like a quote for planting at Elm Gardens in spring.' },
      { speaker: 'Rosa Delgado', start: 75, text: 'Happy to. I will send a planting proposal for Elm Gardens by the end of January.' },
    ],
  }
  return `${JSON.stringify(doc, null, 2)}\n`
}

// ═════════════════════════════════════════════════════════════════════════════
// README
// ═════════════════════════════════════════════════════════════════════════════

const README = `# Sample data — knowledge-base imports

Everything here is **made up**. "Fernleaf Garden Supply" is a fictional independent
garden centre with a small landscaping crew. Any resemblance to a real business or
person is a coincidence.

The files are built by \`app/server/src/scripts/make-kb-wiki-samples.ts\`
(\`cd app/server && npx tsx src/scripts/make-kb-wiki-samples.ts\`). Do not edit them by
hand — change the script and run it again.

## The cast

| Name | Who |
|---|---|
| Rosa Delgado | Owner of Fernleaf Garden Supply |
| Sam Okafor | Store manager |
| Priya Nair | Part-time bookkeeper |
| Jo Fairweather | Landscaping crew lead |
| Greenway Growers | Main plant supplier (account rep Tom Whitfield) |
| Riverbend Nursery | A possible second supplier |
| Hillcrest Property Management | Wholesale client: grounds maintenance at 6 apartment sites (facilities manager Marcus Bell) |

## The files

| File | What it shows |
|---|---|
| \`claude-export-sample.zip\` | A Claude export (\`conversations.json\` + \`users.json\`). 6 chats: spring opening plan, Hillcrest pricing (with an attached file), bookkeeping checklist (text only in content blocks), summer rota, **pure small talk** (naming the shop cat) and **coding help with no business facts** (a spreadsheet formula). The last two should be skipped. |
| \`chatgpt-export-sample.zip\` | A ChatGPT export with real \`mapping\` trees. 5 chats: late supplier deliveries (a hidden **system** node and an **edited message** — the abandoned branch says "OLD BRANCH" and must not be imported), autumn newsletter, a new mower, **pub-quiz small talk**, and plant sales (a **code-interpreter** call and its output, which are skipped). |
| \`call-2026-09-14-supplier-review.vtt\` | Teams / Zoom style captions: \`<v Name>\` voice tags, one cue per sentence. |
| \`call-2026-09-21-weekly-ops.srt\` | SRT captions with \`Name: text\` lines. Agrees a lower Hillcrest price than the chat quoted, and gives Hillcrest 30-day payment terms — the walkthrough call says 14 days, a real contradiction for the cleanup pass to find. |
| \`call-2026-09-28-client-walkthrough.json\` | The generic JSON transcript format (below). |

## Transcript formats the importer reads

- **.vtt** (WebVTT) — speakers from \`<v Name>\` voice tags or a \`Name: text\` prefix.
- **.srt** — speakers from a \`Name: text\` prefix.
- **.txt** / **.docx** — one line per turn: \`Name: text\`, \`[00:01:02] Name: text\`, or the
  Otter style of a \`Name  0:03\` line followed by what they said. Optional header lines
  \`Title:\`, \`Date:\`, \`Participants:\` at the top.
- **.md** — optional frontmatter (\`title\`, \`date\`, \`participants\`, \`source\`), then
  \`**Name:** text\` or \`Name: text\` lines. A file with no speaker lines is imported as notes.
- **.json** — one call, or a list of calls:

\`\`\`json
{
  "title": "Weekly ops",
  "date": "2026-09-21",
  "participants": ["Rosa Delgado", "Sam Okafor"],
  "source": "Zoom",
  "notes": "optional free-text notes or summary",
  "segments": [
    { "speaker": "Rosa Delgado", "start": 4, "text": "Morning all." }
  ]
}
\`\`\`

  \`segments\` may also be called \`transcript\`, \`sentences\` or \`utterances\`;
  \`speaker\` may be \`speaker_name\`; \`text\` may be \`raw_text\`; \`start\` (seconds or
  \`mm:ss\`) may be \`start_time\`; \`notes\` may be \`summary\`. When there is no title the file
  name is used, and a \`YYYY-MM-DD\` in the file name is used as the date.
`

// ═════════════════════════════════════════════════════════════════════════════

function main(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const files: Array<[string, Buffer | string]> = [
    ['claude-export-sample.zip', claudeExport()],
    ['chatgpt-export-sample.zip', chatgptExport()],
    ['call-2026-09-14-supplier-review.vtt', vtt(SUPPLIER_REVIEW)],
    ['call-2026-09-21-weekly-ops.srt', srt(WEEKLY_OPS)],
    ['call-2026-09-28-client-walkthrough.json', clientWalkthrough()],
    ['README.md', README],
  ]
  for (const [name, content] of files) {
    fs.writeFileSync(path.join(OUT_DIR, name), content)
    console.log(`wrote ${path.relative(process.cwd(), path.join(OUT_DIR, name))}`)
  }
}

main()
