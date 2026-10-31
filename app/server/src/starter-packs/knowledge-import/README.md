# Knowledge base file import

Drop in the files your business already has: price lists and other spreadsheets, policy PDFs, meeting transcripts and Word documents. The **Librarian** reads each one and files what it says into tidy notes in your **Knowledge base**, one per organization, person, project, product and topic. Every fact links back to the file it came from. You can then ask questions across all of it.

## What you get

- An **Import files** button on the **Knowledge base** page. Drop files in, watch them get read, open the notes, and ask questions.
- Organized notes in your workspace's knowledge base. They show up in the Knowledge base file list like any other note, and you can edit them there:

  | Folder | What's in it |
  |---|---|
  | `organizations/` | customers, suppliers, partners, e.g. `organizations/maple-street-dental.md` |
  | `people/` | staff and contacts |
  | `projects/` | customer jobs and contracts, internal initiatives, hires |
  | `products/` | what you sell, with prices and terms, e.g. `products/deep-clean.md` |
  | `topics/` | policies, procedures, decisions, lessons learned |
  | `sources/` | a readable copy of every upload, with a summary and links to the notes made from it |
  | `sources/files/` | the original files, untouched |

  When a second file mentions the same thing, the Librarian adds to the existing note instead of making a new one. Each file gets its own "From: <file>" section, so if you re-read a file it updates its own section and leaves everything else alone.
- A **Librarian** agent on the board for follow-up work, for example: "merge these two notes", "summarize every policy change we agreed in meetings this year", "which prices in the price list disagree with the meeting notes?"
- Four sample files from a made-up business to try it with (see `sample-data/README.md`).

## Your files stay on your server

- Uploads are saved on this server and nowhere else.
- Reading the file (pulling the text out of Excel, Word, PDF) happens on this server.
- The only thing that leaves the server is the **text** of the file, which goes to the AI provider this install was set up with (your own Claude account or Anthropic API key) so it can be organized. Nothing is sent to any other service.

## Files it can read

| Type | Notes |
|---|---|
| Excel `.xlsx`, `.xlsm` | every tab, every row (up to 2,000 rows per tab). Messy column names and mixed formats are fine. |
| `.csv`, `.tsv` | |
| PDF | text PDFs (exported from Word, Google Docs, a slide deck). **Scanned** PDFs (photos of paper) have no text to read. Ask for the original, or run OCR first. |
| Word `.docx` | paragraphs and tables |
| Transcripts `.txt`, `.md`, `.vtt`, `.srt` | Zoom, Teams, Otter or Granola exports |

**How long it takes:** a memo or transcript takes under a minute. A big multi-tab spreadsheet takes a few minutes, because the Librarian writes a note for every row that names something. Tabs are read in parallel, then one quick check merges names that were spelled differently on different tabs.

Older `.xls` and `.doc` files: open them and use *Save As* to make an `.xlsx` or `.docx` first. Up to 50 MB per file, and up to 20 files at once. Very long files are read in full but only the first ~180,000 characters are organized into notes. The full text is still in the readable copy.

## Switching it on

**On a new install:** add the pack to `client.conf` before running the installer:

```
STARTER_PACKS="knowledge-import"
```

**On an existing install**, run this on the server (replace `<workspace>` with the workspace's short name):

```bash
scripts/starter-pack.sh enable knowledge-import --workspace <workspace>
scripts/starter-pack.sh status          # shows which packs are on
```

Switching it on:
1. adds the **Librarian** agent and puts it in the workspace's agent list;
2. creates the knowledge-base folders above;
3. lets the rest of the app (Knowledge base page, search, agents) read the imported notes;
4. shows the **Import files** button on the Knowledge base page.

Running it again is safe. To switch it off, run `scripts/starter-pack.sh disable knowledge-import --workspace <workspace>`. The Import files button disappears, but your notes and files are kept.

### Where the knowledge base lives

1. If the workspace has a knowledge-base folder set in Settings → Org, that folder is used.
2. If not, `<SECOND_BRAIN_DIR>/workspaces/<workspace>` is used, when that folder exists.
3. Otherwise `/app/data/knowledge-base/<workspace>` is used. On a standard install that is `data/knowledge-base/<workspace>` in the install folder, and it is included in backups of `data/`.

### Settings (optional)

| Setting (environment) | What it does |
|---|---|
| `DOC_INGEST_MODEL` | Which Claude model organizes files and answers questions. Default `claude-sonnet-5`. |
| `DOC_INGEST_TIMEOUT_MS` | How long one AI call may take. Default 10 minutes. |
| `DOC_INGEST_SLOTS` | (Installs with several Claude accounts) which accounts to use. |
| `DOC_INGEST_KB_DIR` | Change the fallback folder in step 3 above. |

## If something goes wrong

| You see | What to do |
|---|---|
| "No AI account is connected" | Finish the Claude sign-in step of the install, then press **Try again** on the file. |
| "No readable text found in this PDF" | It's a scanned image. Get the original file or an OCR'd copy. |
| "Can't read .xls files yet" | Open it in Excel and *Save As* `.xlsx`. |
| A file is stuck on "Reading" after a restart | It resumes by itself when the server starts. |

## For developers

- Pack folder: `app/server/src/starter-packs/knowledge-import/` (`pack.json`, `prompts/`, `agents/`, `sample-data/`).
- Pipeline: `app/server/src/services/doc-ingest/`. `extract.ts` reads files with no extra dependencies, `notes.ts` writes and merges notes, `ingest.ts` runs the queue, `ask.ts` answers questions, and `llm.ts` makes the AI call.
- Routes: `app/server/src/routes/kb-ingest.ts`. Panel: `app/client/src/components/KnowledgeImport.tsx`, opened from `DocsPage.tsx`.
- Loader for all starter packs: `app/server/src/services/starter-packs.ts`, switched with `scripts/starter-pack.sh`.
- Tests: `services/doc-ingest/doc-ingest.test.ts`, `routes/kb-ingest.test.ts`.
