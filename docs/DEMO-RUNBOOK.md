# Demo runbook: Operation Kit in 45 minutes

A script for showing Operation Kit live to a consulting firm or a client, in person or on a call. It
covers the five things people ask about: **installing it**, **reading their files into a knowledge
base**, **chatting with an agent**, **an AI worker doing a job on the board**, and **connecting the
AI app they already use**. Every step has a fallback.

All data shown is fictional: *Cedar & Pine Home Services* (sample files that ship with the app) and
*Example Capital Partners* (the made-up client name on the install).

---

## The setup: two servers

| | Purpose | When it is built |
|---|---|---|
| **Server A, "fresh"** | A brand-new Ubuntu 24.04 server. You start the installer on it live, at the beginning of the meeting, and show the finished result at the end. | Live, during the demo |
| **Server B, "ready"** | An install you finished the day before, with the sample files already imported. Everything in the middle of the demo runs here. | The day before |

The installer spends 10 to 20 minutes building, so it runs in the background while you show
Server B. If anything goes wrong on Server A, the demo still works entirely on Server B.

## The day before (about 90 minutes)

1. **Server B: full install.** Follow [INSTALL.md](../INSTALL.md) start to finish, with
   `STARTER_PACKS="knowledge-import"` in `client.conf`. Use a sub-domain like
   `demo.<your domain>`. `install/verify.sh` must show every line PASS. Write down the total time
   from `/opt/operationkit/install-timing.log`; you will quote it.
2. **Server B: sign in and add the agents.** Sign in as the admin. Open **Agents → Templates** and
   press **Add agent** on **Personal assistant**, **Knowledge librarian** and **Operator**.
3. **Server B: import the sample files once,** so you know the timing and have a loaded knowledge
   base ready: **Knowledge base → Import files → Add the 4 sample files**. Wait until all four say
   **Done** (the spreadsheet takes a few minutes). Then create a **second workspace** in **Settings → Org** (for example
   `live-demo`) that is still empty: that is where you import live.
4. **Server B: seed the assistant.** Open **Chat → Personal assistant** and send:
   *"Add these to my to-do list: call Maple Street Dental about the walkthrough, update the
   cancellation policy PDF, send the April price list to the team."* Check that the note appears
   under `personal/todos` in the Knowledge base. Then open **Chat → Operator** once and send
   *"How are my cards doing?"* so both chats have some history.
5. **Server B: run one card end to end.** Create the card from segment 4 below ("A coding card does a job") and let it finish,
   so a completed card is on the board if the live one is slow.
6. **Server B: open the door for AI apps.** Make an agent pass named `claude-code` (**Option A**) in
   [Connect your AI, Step 0](./CONNECT-YOUR-AGENT.md#step-0-administrator-once-per-install-let-ai-apps-through-the-cloudflare-door).
   Make an agent key named `Claude: Demo` with `vault:read`, `vault:write`, `board:read`,
   `board:write`, limited to the demo workspace.
7. **Your laptop: connect Claude Code** to Server B with the command in
   [Connect your AI](./CONNECT-YOUR-AGENT.md#claude-code-terminal), then run `claude` → `/mcp` and
   confirm `operation-kit` is connected. Ask *"Using Operation Kit, list my chat agents"* once.
8. **Server A: get it ready to install.** Create the server, put the domain on Cloudflare, make the
   Cloudflare API token, and do the step 1 to step 5 parts of INSTALL.md (check the server, put the
   code on it, write `client.conf`, hand over the token). Run the **dry run** (step 6, first
   command). Stop there. The real install runs live.
9. **Pack the fallbacks** (see the table at the end): screenshots of every screen from Server B,
   the four sample files on your laptop, and a copy of the security one-pager.

## One hour before

- Open these browser tabs, signed in to Server B: **Knowledge base**, **Chat**, **Board**,
  **Settings → You** (agent keys). Zoom the browser to 125% so the room can read it.
- Open a terminal with Claude Code, in the folder where you keep Server A's notes.
- Check the Claude account on both servers has usage left (a short message in **Chat** on Server B
  is enough).
- Phone hotspot ready in case the venue Wi-Fi blocks anything.

---

## The 45 minutes

| Time | Segment | Where |
|---|---|---|
| 0 to 4 | Why this exists | talk |
| 4 to 9 | 1. Start a fresh install | Server A |
| 9 to 19 | 2. Read files into the knowledge base | Server B |
| 19 to 26 | 3. Agent chat with the Personal assistant | Server B |
| 26 to 32 | 4. A coding card does a job | Server B |
| 32 to 38 | 5. Connect an outside AI through MCP | laptop + Server B |
| 38 to 42 | 6. The fresh install is done | Server A |
| 42 to 45 | Security, ownership and what's next | talk |

### 0 to 4: Why this exists (talk)

> "Every AI engagement starts the same way: get the client's documents somewhere an AI can read
> them, give their people a safe way to use it, and have somewhere to run real jobs. Operation Kit
> is that starting point. You install one copy per client, on the client's own server. They own it
> and their data never leaves it; you build their specific workflows on top."

### 4 to 9: Start a fresh install (Server A)

1. In Claude Code, say: *"Run the real install on Server A, step 6 of INSTALL.md."* (Everything
   before it was done yesterday.)
2. While the first lines scroll, explain what it is doing: preparing the server, generating every
   password and key on the server (it prints names, never values), building the app, setting up
   Cloudflare.
3. Show `client.conf` on screen: *"This is everything that differs between clients: name, address,
   who may sign in, which agents. No passwords in here."*
4. Leave it running. *"This takes about 15 minutes. Let's look at one I installed yesterday."*

**If it fails:** read the message (INSTALL.md *When something goes wrong* covers the usual ones),
say *"this is exactly why the script is safe to re-run"*, and move on to Server B. Do not debug in
front of the room. Use Server B's timing log for the "how long" question.

### 9 to 19: Read files into the knowledge base (Server B)

1. Switch to the empty `live-demo` workspace. Open **Knowledge base → Import files**. It says *No
   files yet*.
2. Open **Price List 2025 - FINAL v3.xlsx** on your laptop. Point out the messy tabs, the column
   names that change on every tab, prices written three different ways.
3. Drag all four sample files onto the Import screen (or press **Add the 4 sample files**). Each
   shows *Waiting → Reading → Filing notes → Done*.
   > "These files don't leave this server. Only the text goes to the client's own AI account."
4. While the spreadsheet is still reading, switch to the main demo workspace (already loaded) so
   you are not waiting. Click a note such as **Deep Clean**: sections *From: Price List…* and *From:
   Team meeting transcript…* merged into one note even though the names were spelled differently.
   Click **original file** to show the source.
5. **Ask** box:
   - *"What do we charge for a deep clean, and is that price changing?"* → $289 today, $320 for new
     bookings from April 1, each figure citing its file.
   - *"What is our cancellation policy? Do the files agree?"* → the PDF says 24 hours and $40, the
     team meeting changed it to 48 hours and $50, so the PDF is out of date.
6. Press **Save to wiki** under the answer, then open the wiki page it created: *"Good answers
   become pages. The wiki keeps growing from the client's own files, and every fact links back to
   where it came from."*
7. Mention, without showing: Claude and ChatGPT chat exports and call transcripts import the same
   way, and a nightly cleanup flags contradictions and stale facts.

The question script and expected answers come from the sample pack's
[DEMO.md](../app/server/src/starter-packs/knowledge-import/DEMO.md).

**If import is slow or fails:** stay in the pre-loaded workspace and do steps 4 to 6 there. A file
that says **Needs attention** usually means the AI account needs signing in: press **Try again**
afterwards, not now.

### 19 to 26: Agent chat with the Personal assistant (Server B)

1. Open **Chat → Personal assistant**. Point out yesterday's conversation is still there: one
   ongoing chat per agent, stored on the client's server.
2. Send: *"What's on my to-do list?"* → the three items you seeded. Point at the small grey line
   ("Read todo.md") showing what it did.
3. Send: *"Add: prepare the Maple Street Dental quote by Friday."* → it updates the note. Open the
   Knowledge base to show the change in `personal/todos`.
4. Show the agent file: **Agents → Templates → Personal assistant**. *"Each agent is one file:
   instructions, which folders it may read, which tools it may use, its schedules. This one can
   read and write only its own `personal/` folders and can never send an email by itself. You
   write these once and drop them into every client. A marketplace for sharing them is the next
   step."*
5. Switch to **Chat → Operator** (the agent whose file allows creating board cards) and send:
   *"Put a job on the board: write a one-page quote for Maple Street Dental, weekly evening clean,
   12-month contract, about $185 a visit."* → a card appears in the chat with its status.
   *"Anything bigger than a chat answer goes to the board, and the card keeps updating here."*
6. Point out under each reply: **"Answered by Claude · …"**. The client chooses the AI.

**If chat errors or is slow:** the AI account may be busy. Switch on the demo agent (**Chat → Turn
on the demo agent**, admin only): a made-up inbox and calendar that answers instantly, even with no
AI account. Try *"What's in my inbox?"* and *"Reply to Priya"* (it drafts; nothing is ever sent
without pressing **Send**).

### 26 to 32: A coding card does a job (Server B)

1. Open the **Board**. Show the card the Operator just created, sitting in **queue**.
2. Create one more card yourself (the **New** button on the board), description:

   > Write a small Python script that reads the CSV below, flags every service whose price changed
   > by more than 10%, and prints a table. Run it and show the output.
   >
   > ```
   > service,old_price,new_price
   > Deep Clean,289,320
   > Standard Clean,149,155
   > Move-out Clean,349,399
   > Handyman hour,85,85
   > Window package,120,140
   > ```

   Press **Start**.
3. Open the card. The worker's steps stream in: it writes the script, runs it, prints the table
   (Deep Clean, Move-out Clean and Window package are flagged).
   > "Each card runs in its own sandbox that can see only its own folder. When it's done, an
   > independent AI reviewer checks the result, and a person signs it off."
4. Open the card you finished yesterday to show the **review** and **done** states.

**If the card is slow to start or stalls:** show yesterday's finished card instead and walk through
its steps and result. Starting can take up to a minute while the sandbox starts.

### 32 to 38: Connect an outside AI through MCP (laptop + Server B)

1. Show **Settings → You → Agent keys**: the `Claude: Demo` key, its ticks, its single workspace,
   *Last used*. *"Each AI app gets its own named key. Revoke it here and it's cut off."*
2. In Claude Code on your laptop:
   - *"Using Operation Kit, list my chat agents."*
   - *"Act as my Personal assistant from Operation Kit. What's on my to-do list?"*
   - *"Search my Operation Kit knowledge base: what is our cancellation policy?"*
   - *"Create an Operation Kit card: update the cancellation policy PDF to 48 hours and $50."*
3. Switch to the Board: the new card is there, labelled **Claude: Demo**.
   > "Same notes, same agents, same board, from the AI app people already pay for. Claude today,
   > ChatGPT or Grok tomorrow; the client's work stays put."

**If MCP fails:** a Cloudflare page or `401` means the Step 0 rule or the key is wrong; do not fix
it live. Show the [Connect your AI](./CONNECT-YOUR-AGENT.md) guide on screen and the screenshots
from yesterday's dry run.

### 38 to 42: The fresh install is done (Server A)

1. Back in Claude Code: the installer should be finished, with a time for each step and a total.
   Read out the total.
2. If the Claude sign-in (INSTALL.md step 7) is still to do, say so: *"This last step is the
   client signing in to their own Claude account, on their own screen, so the token never touches
   my laptop."* Skip it live unless you have the client's account.
3. Open `https://<Server A address>` in a private browser window: the **Cloudflare sign-in**
   appears first. *"Strangers never even see the app."* Sign in with the email code, then the
   one-time admin password, and show the forced password change.

**If it is not finished:** show the progress lines and Server B's timing log. *"Same script,
yesterday: N minutes."*

### 42 to 45: Security, ownership and what's next (talk)

Hand over or show the [security overview](./SECURITY-OVERVIEW.md). Key lines:

- One install per client, on the client's server, their AI account. No shared cloud.
- Cloudflare Access and Tunnel in front, no open web ports, sandboxed jobs, secrets never shown.
- **Honest gaps:** no SOC 2 attestation (and why the self-hosted model sidesteps most of that
  question), no built-in SSO beyond Cloudflare Access, transcripts not encrypted at rest.
- Next: a shared marketplace for agent templates, so the agents you build for one client can be
  reused for the next.

---

## Fallbacks at a glance

| What breaks | Do this |
|---|---|
| Venue Wi-Fi blocks SSH or the site | Phone hotspot. If it is still blocked, run the whole demo from screenshots of Server B. |
| Installer fails on Server A | Move on; show Server B and its timing log. Fix and re-run afterwards (`./install.sh` is safe to re-run). |
| Import slow or **Needs attention** | Use the pre-loaded workspace. |
| AI account out of usage or slow | Switch to the demo agent in Chat; show yesterday's finished card. |
| Card does not start | Show yesterday's finished card. |
| MCP returns a Cloudflare page or `401` | Show the connect guide and yesterday's screenshots; check Step 0 and the key afterwards. |
| Laptop dies | Server B works from any browser; only the Server A and Claude Code parts need your laptop. |

## Reset afterwards

To run the demo again on the same Server A:

```bash
bash install/uninstall.sh --config client.conf --yes --keep-images --keep-cloudflare
```

Then hand over the token again and re-run the install (see INSTALL.md *Re-running a demo*).
Revoke the `Claude: Demo` agent key on Server B if the laptop is shared.
