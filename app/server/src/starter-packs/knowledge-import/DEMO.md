# Demo script: "Your files, organized and searchable" (about 10 minutes)

**Story:** every business has the same mess. A price list someone has kept in three different ways, a policy PDF nobody has reread since last year, meeting notes where the real decisions live, and a how-to document that's half out of date. Drop it all in, and a few minutes later you can ask it questions like a colleague who has read everything.

All files are fictional: *Cedar & Pine Home Services*, a small cleaning and handyman company.

## Before the meeting (2 minutes)

1. Install with `STARTER_PACKS="knowledge-import"` in `client.conf`, or on an existing install run
   `scripts/starter-pack.sh enable knowledge-import --workspace <workspace>`.
2. Sign in and open the **Knowledge base** page. Press **Import files**. It should say *No files yet*.
3. If you want to drag the four sample files in yourself, keep them handy. They are in the pack's `sample-data/` folder. Or press **Add the 4 sample files** on the Import files screen.
4. Run it once beforehand so you know the timing. On a standard Claude account the policy PDF, the transcript and the Word how-to take under a minute each. The 5-tab spreadsheet takes a few minutes. For the meeting, either use a second workspace that is already loaded, or start the upload first and talk through step 1 while it reads.

## 1. Show the mess (1 minute)

Open **Price List 2025 - FINAL v3.xlsx** in Excel and point out:
- the tabs: *Cleaning, Handyman, Add-ons, OLD 2024 prices, Commercial (draft)*;
- the column names change on every tab ("Service" / "Item" / "Description", "Price" / "Rate ($)" / "Cost"), and prices are written three different ways ($289, 289.00, "45 USD");
- the same service is "Deep Clean" on one tab and "Deep-clean (whole home)" on another.

> "This is what most businesses' files look like. Nobody's going to clean them up by hand."

## 2. Import (30 seconds)

Drag all four files onto the Import files screen, or press **Add the 4 sample files**. Each file shows *Waiting → Reading → Filing notes → Done*. Files are read one at a time, so each new file can build on the notes from the ones before it. The first notes show up within about a minute.

> "These files don't leave this server. It's your server. The only thing that goes out is the text, to your own AI account."

## 3. Open the notes (2 minutes)

When a file says **Done**, its notes appear as chips under it.
- Click **Deep Clean** (a product). Point out the separate sections, *From: Price List…xlsx* and *From: Team meeting transcript…txt*. The spreadsheet and the meeting were merged into one note even though the service was spelled differently.
- Click **original file** inside the note. It downloads the exact file the fact came from.
- Click **Readable copy** on the PDF. That's the policy as plain text, with a summary and the list of notes made from it.
- Press **Back to notes**. The new folders (*organizations, people, projects, products, topics, sources*) are in the Knowledge base file list like any other note, and you can edit them there.

## 4. Ask questions (4 minutes)

Use the **Ask** box. Good questions, and what a good answer contains:

| Ask | A good answer… |
|---|---|
| *What do we charge for a deep clean, and is that price changing?* | $289 in the price list (effective 1/6/2025), but the 4 March team meeting agreed $320 for new bookings from April 1. Existing bookings keep $289. Each number cites its file. |
| *What is our cancellation policy? Do the files agree?* | The policy PDF says 24 hours notice and a $40 late fee. The team meeting changed it to 48 hours and $50 from April 1, so the PDF needs updating. |
| *How quickly do we send a quote?* | The onboarding how-to says within 1 business day; the customer policy promises 2 business days. |
| *Where are we with Maple Street Dental, and who owns the next step?* | They want a weekly evening clean on a 12-month contract. Marcus does a walkthrough and sends the quote by Friday. The price list has a draft rate of about $185 a visit. |
| *What are the steps for onboarding a new client, and who owns each one?* | The steps from the how-to, from first call to the follow-up call after 3 days, with Priya or Marcus named on each. |

Click any source chip under an answer to open the note it came from.

> "Every answer says where it came from. If the files disagree, it tells you instead of picking one."

## 5. Hand-off to an agent (optional, 1 minute)

On the board, create a card for the **Librarian**: *"List every policy or price that the team meeting changed, and which documents still need updating."*

## If something goes wrong live

- A file shows **Needs attention**: read the message on the file, then press **Try again**. Most often this means the AI account is not signed in yet.
- An answer says the files don't cover it: the question used words that aren't in the notes. Rephrase it with a product, client or person's name.
