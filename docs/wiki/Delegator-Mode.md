# Delegator Mode

Some objectives are too broad for a single working session to execute cleanly — a feature that touches several independent parts of a system, or a batch of similar tasks that can run in parallel. **Delegator mode** is a card flag (`delegate_mode`) that turns the session into an orchestrator: it decomposes the objective into worker sub-sessions, dispatches each one as its own card, and reviews the results before reporting the parent objective done.

## Why it's its own mode, not the default

Decomposing and dispatching work has a different failure mode than doing it directly — a delegator can get wedged waiting on child cards indefinitely. A delegator objective is exempt from the normal single-session watchdog/orphan-sweep timers for exactly that reason, and instead has its own longer-horizon sweep that detects a wedged delegator and recovers it, rather than treating "waiting on children" as the same thing as "stuck."

## When to use it

- Admins can set delegate mode when creating a card.
- Use it for work that's naturally parallel (several independent sub-tasks) or wide (touches many files/surfaces that don't depend on each other).
- Don't use it for a single well-scoped change — that's slower through an orchestrator than just working it directly.

## How it relates to the rest of the system

A delegator's child cards go through the exact same [board lifecycle](./Board-and-Objectives-Lifecycle) and, where graded, the same [review gate](./Review-Gate) as any other card — delegation changes who creates the card, not how the card is executed or reviewed.
