# Sample data — knowledge-base imports

Everything here is **made up**. "Fernleaf Garden Supply" is a fictional independent
garden centre with a small landscaping crew. Any resemblance to a real business or
person is a coincidence.

The files are built by `app/server/src/scripts/make-kb-wiki-samples.ts`
(`cd app/server && npx tsx src/scripts/make-kb-wiki-samples.ts`). Do not edit them by
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
| `claude-export-sample.zip` | A Claude export (`conversations.json` + `users.json`). 6 chats: spring opening plan, Hillcrest pricing (with an attached file), bookkeeping checklist (text only in content blocks), summer rota, **pure small talk** (naming the shop cat) and **coding help with no business facts** (a spreadsheet formula). The last two should be skipped. |
| `chatgpt-export-sample.zip` | A ChatGPT export with real `mapping` trees. 5 chats: late supplier deliveries (a hidden **system** node and an **edited message** — the abandoned branch says "OLD BRANCH" and must not be imported), autumn newsletter, a new mower, **pub-quiz small talk**, and plant sales (a **code-interpreter** call and its output, which are skipped). |
| `call-2026-09-14-supplier-review.vtt` | Teams / Zoom style captions: `<v Name>` voice tags, one cue per sentence. |
| `call-2026-09-21-weekly-ops.srt` | SRT captions with `Name: text` lines. Agrees a lower Hillcrest price than the chat quoted, and gives Hillcrest 30-day payment terms — the walkthrough call says 14 days, a real contradiction for the cleanup pass to find. |
| `call-2026-09-28-client-walkthrough.json` | The generic JSON transcript format (below). |

## Transcript formats the importer reads

- **.vtt** (WebVTT) — speakers from `<v Name>` voice tags or a `Name: text` prefix.
- **.srt** — speakers from a `Name: text` prefix.
- **.txt** / **.docx** — one line per turn: `Name: text`, `[00:01:02] Name: text`, or the
  Otter style of a `Name  0:03` line followed by what they said. Optional header lines
  `Title:`, `Date:`, `Participants:` at the top.
- **.md** — optional frontmatter (`title`, `date`, `participants`, `source`), then
  `**Name:** text` or `Name: text` lines. A file with no speaker lines is imported as notes.
- **.json** — one call, or a list of calls:

```json
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
```

  `segments` may also be called `transcript`, `sentences` or `utterances`;
  `speaker` may be `speaker_name`; `text` may be `raw_text`; `start` (seconds or
  `mm:ss`) may be `start_time`; `notes` may be `summary`. When there is no title the file
  name is used, and a `YYYY-MM-DD` in the file name is used as the date.
