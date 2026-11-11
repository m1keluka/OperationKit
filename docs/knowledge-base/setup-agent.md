# How to set up your knowledge base

Your AI agents are only as good as what they can look up. The fastest way to give them a
useful knowledge base is to hand over the files you already have — documents,
spreadsheets, slide decks, exports, notes, meeting and chat logs — and let the
**Knowledge Base Setup** agent sort them.

It reads every file on your own server, files what matters into one page per person,
company, project, decision, process, product and glossary term, links the pages to each
other and back to the original file, and asks you about anything it should not guess.

You find it at **Knowledge base → Set up** (`/knowledge/setup`). It is also listed as the
**Knowledge Base Setup** agent on the Agents page and in chat, and as the
"Set up your knowledge base" step of onboarding.

---

## 1. Gather your files

Anything with text in it is worth adding. A good first batch:

| Bring | Examples |
|---|---|
| About the business | an "about us" page, team list or org chart, a glossary of your own terms |
| Clients and suppliers | client list or CRM export (CSV/Excel), contracts, statements of work, proposals |
| How you work | SOPs, checklists, how-tos, onboarding guides, pricing rules, policies |
| What you decided | decision logs, board or leadership notes |
| What happened | meeting notes and call transcripts, project updates, chat exports |
| What you sell | price lists, service or product sheets, brochures |

**Read:** Word (`.docx`), PDF, Excel (`.xlsx`) and CSV/TSV, PowerPoint (`.pptx`, with
speaker notes), text and markdown, saved web pages (`.html`), JSON exports, and meeting
transcripts (`.vtt`, `.srt`, `.txt`, `.docx`).

**Skipped (and listed in the summary):** images, audio and video (upload the transcript
instead), zip files (unzip first — Claude and ChatGPT exports go through
**Import files → Import chats & calls**), old `.doc` / `.xls` / `.ppt` (open and Save As the
new format), code dependency folders, and credential files such as `.env`, `.pem` or
`credentials.json`.

Keep your folder structure — folder names help. A file in `SOPs/` is read as a process,
one in `Clients/Acme/` as being about Acme.

## 2. Drop them in

On **Knowledge base → Set up**:

- **Drag whole folders** (or single files) onto the drop zone, or use **Choose folder** /
  **Choose files**. Big folders are sent in batches with a progress bar.
- **Or, on the server:** copy files into the workspace's `intake/` folder (the page shows
  the exact path to an admin). Same result — handy for a few gigabytes of old drive.
- Not sure yet? **Try with sample files** loads a small made-up design studio
  (22 files of every kind) so you can see the result first.

The page shows how many files are waiting. Nothing is read until you press **Start setup**.

## 3. Start setup and watch it work

The run goes through the files one at a time:

- a progress bar, the file it is on, and counts of done / unchanged / duplicate /
  skipped / failed;
- **Pause** and **Resume** whenever you like — and if the server restarts, it carries on
  where it stopped;
- an **estimated cost** next to your budget. The run uses the same budget ceiling as board
  jobs (Settings: `job_cost_ceiling_usd` / `job_wallclock_ceiling_ms`, per workspace or
  global; `kb_setup_cost_ceiling_usd` / `kb_setup_wallclock_ceiling_ms` override it just for
  setup). When the ceiling is reached it pauses and tells you; **Continue past budget**
  carries on once you say so. If no ceiling is set, the page says so — it never invents one.

You can keep dropping files while it runs; they wait for the next run.

## 4. Read the summary

When it finishes you see:

- **Pages created and updated**, per section — People, Companies & clients, Projects,
  Decisions, Processes & SOPs, Products & services, Glossary, Other topics — with a link to
  each page;
- files that were **unchanged** (already read before), **duplicates** (the same bytes as
  another file), **skipped** (with why) or **failed** (with why);
- **Secrets removed**: any file in which it found an API key, password, private key or
  connection string — the kind and the line, never the value;
- **Open questions** (next step).

## 5. Answer the open questions

The agent does not guess. It asks when:

- a name could be someone already known — *"Is 'Sam' the same person as Sam Whitaker?"*;
- two files disagree — *"Is the Care Plan $180/month (price list) or $150 (9 March
  meeting)?"*;
- something important is mentioned but never named;
- a file held credentials — *"Rotate the credentials found in Notes/Server setup notes.md"*.

Answer or dismiss each one on the setup page. The same questions are in the **decision
queue**, filed under one board card per workspace — *"Knowledge base setup: answer N open
questions"* — that never starts a coding session by itself. An answered or dismissed
question is never asked again.

## 6. Run it again whenever you like

- Re-running over the same files changes nothing — unchanged files are not even re-read.
- A file you edited replaces only **its own** section on each page; what other files said
  stays.
- A copy of a file you already gave it ("Copy of …", "… (1)") is skipped as a duplicate.

---

## What it builds

It uses the knowledge base structure your install already has — the same folders and
note format as **Import files**, the wiki, `search`, `kb_related` and `kb_who_knows` — and
adds tags instead of new folders:

| Section | Folder | Tags it may add |
|---|---|---|
| People | `people/` | `team`, `contact`, `owner`, `advisor` |
| Companies & clients | `organizations/` | `client`, `prospect`, `supplier`, `partner`, `competitor`, `investor` |
| Projects | `projects/` | `active`, `completed`, `proposed` |
| Products & services | `products/` | `service`, `product`, `add-on`, `retired` |
| Decisions | `topics/` | `decision` |
| Processes & SOPs | `topics/` | `process`, `policy` |
| Glossary | `topics/glossary.md` (one page) | `glossary` |
| Other topics | `topics/` | `lesson`, `meeting` |

Each page has frontmatter (`title`, `type`, `tags`, `aliases`, `sources`), a short summary,
a **Related** list with how things relate ("works for", "client of"), one
`## From: <your file path>` section per file with a link to the readable copy in
`sources/` and to the original in `sources/files/`, and backlinks. `index.md` and `log.md`
are updated at the end of each run.

The sample folder produces this tree (from the automated end-to-end test):

```
organizations/  copperline-print  harbor-bakery  lumen-and-lark-studio  oak-and-ember-cafe  pinecrest-dental
people/         jonas-feld  lena-ortiz  maya-lindqvist  priya-raman  sam  sam-whitaker  theo-okonkwo
projects/       harbor-bakery-website  pinecrest-dental-rebrand
products/       brand-starter  brand-starter-website-build-bundle  care-plan  signage-add-on  website-build
topics/         client-onboarding (process)  glossary  invoicing (process)  launch-harbor-bakery-pre-orders-before-the-blog (decision)
                move-invoicing-to-monthly (decision)  stop-fixed-price-retainers (decision)  website-hosting-setup (process)
                website-launch-checklist (process)
sources/        one readable copy per file  ·  sources/files/ the originals
index.md  log.md
```

## Privacy and safety

- Files are read **on your server**. Only extracted text — with secrets already removed —
  goes to the AI service your install is set up with.
- **Secrets are never stored.** API keys, tokens, passwords, private keys and passwords in
  connection strings are replaced with `[REDACTED:<kind>]` before the AI sees the text;
  the original file is **not kept** (only a redacted copy), the file is flagged, and you
  get a question asking you to rotate the credential. Credential files (`.env`, `.pem`, …)
  are refused at upload and skipped from the server folder.
- **One workspace at a time.** A run only reads that workspace's intake folder and only
  writes that workspace's knowledge base. You need to be a member of the workspace.
- `intake/` is added to the knowledge base's `.gitignore`, like `raw/` and `.kb-wiki/`.

---

## Copy-paste prompts

### Hand the upload to a coding agent on your server

Paste this to a coding agent that can reach your server's files (replace the two paths):

```text
Set up my Operation Kit knowledge base from my existing files.

1. Copy everything under <MY FILES FOLDER> into the knowledge base intake folder
   <INTAKE FOLDER shown on Knowledge base → Set up>, keeping the folder structure.
   Do not copy .env, .pem, key or credentials files, node_modules, .git, or anything
   that is not a document, spreadsheet, slide deck, export, note or transcript.
2. Do not open, summarize or rewrite the files yourself — the Knowledge Base Setup
   agent reads them on the server.
3. Tell me how many files you copied and their total size, then tell me to open
   Knowledge base → Set up and press Start setup.
```

### Finish the job with an AI connected over MCP

After a run, paste this into Claude, ChatGPT or any AI connected to Operation Kit with a
key that has `vault:read` (and `vault:write` if it may edit):

```text
You are helping me finish setting up the knowledge base of my Operation Kit workspace
"<WORKSPACE>".

1. Call list_chat_agents, then get_chat_agent with slug "kb-setup", and follow its
   instructions for the rest of this conversation.
2. Read index.md and log.md in that workspace's knowledge base to see what the last
   setup run created.
3. Find pages that look like the same person, company or product under two names, and
   pages that contradict each other. Do NOT change anything yet — list them for me as
   short questions, one per line.
4. For each question I answer, make the change with write_doc: keep the folders and
   tags as they are, keep every "## From:" section and source link intact, and never
   write a password or key into a page. Then file a one-line answer with file_answer
   so the next agent can find the decision.
```

---

## For admins and developers

- Routes: `GET /api/kb-setup/status`, `POST /api/kb-setup/upload` (multipart `files` +
  `paths`, ≤ 50 files and 50 MB each per request), `POST /api/kb-setup/sample`,
  `POST /api/kb-setup/runs`, `GET /api/kb-setup/runs/:id`, `POST …/runs/:id/pause|resume`,
  `GET /api/kb-setup/questions`, `POST /api/kb-setup/questions/:qid`. All take
  `?workspace=` and require membership of that workspace.
- Code: `app/server/src/services/kb-setup/` — `runs.ts` (intake, run state, ledger,
  worker, summary), `taxonomy.ts` (sections, tag vocabulary, file classification),
  `secrets.ts` (redaction), `extract.ts` (adds .pptx/.html/.json to document ingest's
  readers), `questions.ts` (open questions + decision queue), `prompt.md` (the AI's
  instructions). Notes are written by document ingest's `writeOrganized()`.
- State: `<kb>/.kb-wiki/kb-setup/` (`runs/`, `ledger.json`, `questions.json`, `staging/`).
  Deleting it makes the next run re-read everything; the pages themselves are unaffected.
- The built-in chat agent is `app/server/src/services/agent-chat/builtin/kb-setup/agent.md`.
  An agent file with slug `kb-setup` in your agents folder replaces it (for example to give
  it `knowledge_folders` for one workspace); `AGENT_CHAT_BUILTINS=0` hides built-in agents.
- Rebuild the sample folder with `cd app/server && npx tsx src/scripts/make-kb-setup-sample.ts`.
