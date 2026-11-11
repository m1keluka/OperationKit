# Your knowledge base, explained

The knowledge base is your business's memory. You give it files, old AI chats and call
recordings; it reads them on your own server and writes a small wiki of linked pages —
one page per person, company and topic — that you, your team and your AI agents can
look things up in.

It follows a simple idea popularised by Andrej Karpathy (the "LLM wiki"): keep the
**original files untouched**, let the AI **write and maintain the wiki** from them, and
**file good answers back** into the wiki so it gets better every time you use it.

You find it on the **Knowledge base** page (Docs in the menu): click **Import files** to add files, chats and calls, ask questions, browse the wiki and see the cleanup report.

---

## The five parts

### 1. Originals (raw sources)

Everything you upload is kept exactly as it was, byte for byte:

| What | Where it is kept |
|---|---|
| Documents (Excel, PDF, Word, text) | `sources/files/` |
| Claude / ChatGPT exports | `raw/chat-exports/` |
| Call recordings' transcripts | `raw/calls/` |

Nothing the AI does ever changes or deletes these. Because the originals are kept, the
whole wiki can be thrown away and rebuilt from them at any time (an admin can do this
with **Rebuild** — the old pages are moved to a trash folder, not deleted; pages you wrote yourself are left where they are).

### 2. The wiki (compiled pages)

From the originals the AI writes plain markdown pages:

- **A page per thing** — a person, a company, a topic. Each starts with a one- or
  two-sentence summary.
- **Every fact says where it came from** — a link to the readable copy of the file,
  chat or call, plus where in it ("tab 2023, row 7", "message 4", "~12:30, Rosa").
- **Links between pages** written as `[[people/rosa-delgado|Rosa Delgado]]`, and a
  **Backlinks** list at the bottom of every page showing which pages point to it.
- **`index.md`** — a contents page listing every page with its one-line summary.
- **`log.md`** — a "recent changes" diary: what was added, imported, answered or tidied,
  newest first.

The pages are ordinary markdown files. Open the knowledge-base folder in
[Obsidian](https://obsidian.md) and the links, backlinks and graph view all work.

### 3. Answers filed back

Ask a question in the **Ask** box. When the answer is useful, click **Save to wiki**.
It becomes a page in `answers/`, with links to the pages it used — and those pages now
link back to it. Next time anyone (or any agent) asks something similar, the answer is
already there.

AI agents can do the same with the `file_answer` tool (see "For agents" below).

### 4. Cleanup (runs by itself)

Every night (you can change it to weekly, or off, and pick the hour) a cleanup pass
reads the wiki and looks for:

| Problem | What happens |
|---|---|
| Broken links | Fixed automatically when there is exactly one page it must have meant; otherwise listed. |
| Missing topics | When two or more pages mention a topic that has no page yet, a starter page is created. |
| Contradictions | The AI compares what different sources say on the same page. Listed for you — never changed automatically. |
| Duplicate pages | Two pages that look like the same thing ("Greenway" and "Greenway Growers Ltd"). Listed for you to merge. |
| Stale pages | Pages nobody has updated for a long time (180 days by default). Listed. |
| Orphan pages | Pages nothing links to. Listed. |
| Missing sources | A page lists a source file (or a saved answer lists a page it used) that no longer exists. Listed. |
| Pages with no connections | Pages that link to nothing and that nothing links to — not even a source. Listed. |

The result is a short report you can read on the **Cleanup** tab (and in
`lint-report.md`). Cleanup never deletes an original, and never edits facts — it only
fixes links, adds starter pages and rebuilds the index and backlinks.

### 5. Connections (the link graph)

Pages are connected to each other, and the knowledge base keeps a small map of those
connections so you — and your agents — can ask "what is this linked to?" and "who knows
about this?" without reading every page.

There are four kinds of connection, all read straight from the pages:

| Connection | Where it comes from | Example |
|---|---|---|
| **Related** | The **Related** list on a person / company / topic page. When the source said *how* two things are related, the link carries a short label. | Tom Whitfield — *works for* — Greenway Growers |
| **Mentions** | A `[[link]]` written in a page. | The supplier call mentions Sam Okafor |
| **Source** | The file, chat or call a page's facts came from. | The supplier call is a source for Tom Whitfield |
| **Answer used** | A saved answer and the pages it was built from. | "Who is our rep at the supplier?" used Tom Whitfield |

The labels ("works for", "supplier of", "owns", "customer of") are written by the AI in
the **same** read that writes the page — there is no extra AI pass. When the source does
not say how two things are related, the link simply has no label.

**Where you see it.** Open any page from the wiki: under the page there is a
**Connections** picture — the page in the middle, everything it connects to around it,
coloured by kind — and the same list in words ("Tom Whitfield works for Greenway
Growers"). Click any of them to open that page.

**Your files stay the source of truth.** The map is a small table in the app's database
(`kb_edges`, with page names in `kb_nodes`), rebuilt from the markdown pages every time
the wiki is updated, and again whenever someone looks something up after the files
changed. Deleting the table loses nothing — it is rebuilt from the files the next time
it is needed. There is no separate graph database, no embeddings and no extra server.
Edit or delete a page and its connections change with it.

**For agents:** two MCP tools read the map (both need the `vault:read` scope):

- `kb_related { workspace, page, depth }` — the pages connected to one page, each with
  how it connects (kind and label). `page` is a path like `people/tom-whitfield.md` or a
  name. `depth: 2` also returns pages one step further out (2 is the maximum).
- `kb_who_knows { workspace, topic }` — the people linked to a topic, best first: the
  ones the most sources (documents, chats, calls, saved answers) connect to the topic,
  then the most recent. `topic` can be a page name ("Greenway Growers") or plain words
  ("the supplier"); the reply says which pages it read the topic as.

The same lookups are on the REST API: `GET /api/kb-wiki/graph/related?workspace=&page=&depth=`
and `GET /api/kb-wiki/graph/who-knows?workspace=&topic=`.

---

## Importing old AI chats and calls

Open **Knowledge base → Import files → Import chats & calls** and drop in any of these:

| File | How to get it |
|---|---|
| **Claude export** (`.zip`) | claude.ai → Settings → Privacy → **Export data**. You get an email with a zip. Upload the zip as it is. |
| **ChatGPT export** (`.zip`) | chatgpt.com → Settings → Data controls → **Export data**. You get an email with a zip. Upload the zip as it is. |
| **Zoom** captions (`.vtt`) | Zoom web portal → Recordings → your meeting → download the **Audio transcript**. |
| **Google Meet** transcript | Meet saves it as a Google Doc in your Drive → File → Download → **Word (.docx)** or **Plain text (.txt)**. |
| **Microsoft Teams** transcript | Meeting chat → Recap → Transcript → Download as **.vtt** or **.docx**. |
| Captions (`.srt`) | Any tool that exports subtitles. |
| **Granola, Fireflies, Otter, …** | Export as text, markdown or JSON and, if needed, reshape it into the simple format in [transcript-format.md](transcript-format.md). |

What happens next:

1. **Choose what to include.** For an export with hundreds or thousands of chats you get a
   list with a search box, date range and status filter. Tick the ones you want (or
   "select all matching") and click **Process**. Nothing is read by the AI before you do.
2. **It runs in the background** with a progress bar. You can leave the page, **Pause**
   and **Resume**. If the server restarts, it carries on from where it stopped.
3. **Each chat or call becomes a source** — a readable copy in
   `sources/conversations/` — and the AI files its **decisions, people, facts and
   to-dos** into the wiki pages. Small talk, jokes and one-off help with nothing about
   your business (a poem, a spreadsheet formula) are skipped and marked as skipped.

To try it first, click **Try with sample data**. It loads a made-up garden centre
("Fernleaf Garden Supply"): a short Claude export, a short ChatGPT export and three call
transcripts.

---

## Privacy

- Files are read **on your own server**. The original file never leaves it.
- Only the **extracted text** is sent to the AI service this install is set up with
  (your own Claude account or API key) — nowhere else.
- Exports can contain personal conversations. Use the chooser to leave those out before
  processing.
- If your knowledge-base folder is also a git repository (an Obsidian vault you sync to
  GitHub, say), the import adds `raw/` and `.kb-wiki/` to its `.gitignore` so private
  chats are never committed.
- One upload can be up to 20 files and 1 GB in total.

---

## For agents

Agents (in chat and on board cards) read the wiki with the same knowledge tools they
already have — `search`, `list_folders`, `read_file` — because the wiki is just
markdown in the knowledge-base folder. A good first read is `index.md`.

To save a good answer back:

- **MCP / chat agents:** the `file_answer` tool —
  `{ workspace, question, answer, sources: ["people/rosa-delgado.md", …] }`.
- **Board-card sessions on the server:**
  `curl -s -X POST http://localhost:3002/api/internal/kb-wiki/answers -H 'Content-Type: application/json' -d '{"workspace":"<slug>","question":"…","answer":"…","sources":["…"],"filed_by":"<agent>"}'`

Correcting the wiki works as before: edit a page (or ask an agent to with `write_doc`),
and corrections you give agents on a card are still fed into their next run. The
cleanup pass does not undo your edits — it only touches links, the index, backlinks and
the starter pages it created.

---

## Settings (admins)

On the **Cleanup** tab: schedule (nightly / weekly / off) and the hour it runs (UTC).
Stored in the `settings` table as `kb_lint_schedule`, `kb_lint_hour_utc`,
`kb_lint_stale_days` (default 180) and `kb_lint_ai_pages` (how many pages the AI checks
for contradictions per run, default 15; 0 turns that check off).
