# Board & Objectives Lifecycle

The board is a workspace-grouped card view. Each card is an **objective**: a unit of work with a title, a description, and (for anything non-trivial) acceptance criteria that get checked before the card is allowed to reach "done."

## Columns / state machine

Queue → Working → Needs You (review) → Done.

- **Queue** — created, not yet started. A manual card waits for you to press Start; an approved project plan starts its own worker.
- **Working** — a session is live. You can open the card to watch the live session and send follow-ups.
- **Needs You** — something needs a human: a review verdict landed, a decision only you can make, a missing secret, or a click the session couldn't reach itself.
- **Done** — acceptance criteria satisfied (self-reported for a trivial card; gated by the [review gate](./Review-Gate) for anything with graded criteria).

On mobile the columns reorder to put **Needs You** first, so the human gate is always the thing you see.

## How work gets isolated

Every card with a linked repo works in its own isolated worktree — never your live checkout. A hook blocks writes to the live tree from inside a session. This is what lets multiple cards work on the same repo concurrently without stepping on each other.

## How a card finishes

1. The session does the work and declares the objective done (or routes to human review on a contested point).
2. For graded objectives, a fresh-context AI reviewer checks the result against the card's locked acceptance criteria — see [Review Gate](./Review-Gate).
3. A passing review on routine work can auto-merge a lightweight PR; anything with real judgment calls lands in **Needs You**.

## Jobs: the scheduled variant

A **Job** is a routine on a cron schedule. Each fire creates a card the same way a manual card would — Jobs are the scheduler, not a second, parallel to-do system.

See [Delegator Mode](./Delegator-Mode) for how a single objective can fan out into multiple worker sub-sessions, and [External Agents](./External-Agents) for how a card can be created and managed from outside the UI entirely.
