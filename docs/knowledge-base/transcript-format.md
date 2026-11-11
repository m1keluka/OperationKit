# Call transcript format (for Granola, Fireflies, Otter and others)

Zoom, Google Meet and Microsoft Teams transcripts (`.vtt`, `.srt`, `.txt`, `.docx`) can
be uploaded as they come. For any other note-taker, export what it gives you and, if it
isn't already one of those, save it in one of the two simple formats below.

## Option 1 — JSON

One call per file, or a list of calls (`[ {…}, {…} ]`) in one file.

```json
{
  "title": "Weekly ops",
  "date": "2026-09-21",
  "participants": ["Rosa Delgado", "Sam Okafor"],
  "source": "Fireflies",
  "notes": "Optional free-text notes or the tool's own summary.",
  "segments": [
    { "speaker": "Rosa Delgado", "start": 4, "text": "Morning all." },
    { "speaker": "Sam Okafor", "start": "0:09", "text": "Morning. Two things today…" }
  ]
}
```

| Field | Needed? | Notes |
|---|---|---|
| `segments` | yes | The lines of the call. Also accepted under the names `transcript`, `sentences` or `utterances`. |
| `speaker` | yes | Who said it. `speaker_name` also works. |
| `text` | yes | What they said. `raw_text` also works. |
| `start` | no | When, as seconds (`75`) or `mm:ss` / `hh:mm:ss`. `start_time` also works. |
| `title` | no | Defaults to the file name. |
| `date` | no | `YYYY-MM-DD`. If missing, a date in the file name is used. |
| `participants` | no | Defaults to everyone who speaks. |
| `notes` / `summary` | no | Kept with the call and read by the AI. |
| `source` | no | Which tool it came from, for your reference. |

Most tools' JSON exports already use these names (Fireflies uses `sentences` with
`speaker_name` and `raw_text`, for example) and import without changes.

## Option 2 — Markdown or plain text

```markdown
---
title: Weekly ops
date: 2026-09-21
participants: [Rosa Delgado, Sam Okafor]
source: Granola
---

**Rosa Delgado:** Morning all.
**Sam Okafor:** Morning. Two things today…
```

- The frontmatter block at the top is optional. In a `.txt` file you can use plain
  `Title:`, `Date:` and `Participants:` lines at the top instead.
- Each line is `Name: what they said` (bold or not). `[00:01:02] Name: text` and the
  Otter style (a `Name  0:03` line, then what they said on the next lines) also work.
- A markdown file with **no** speaker lines (for example Granola's meeting notes) is
  imported as notes about that meeting.

The sample file `app/server/src/services/kb-wiki/sample-data/call-2026-09-28-client-walkthrough.json`
is a complete example.
