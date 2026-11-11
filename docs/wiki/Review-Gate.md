# Review Gate

Before a card with real acceptance criteria reaches a human, a fresh-context AI reviewer grades the finished work against those criteria. This is a QA mechanism — it exists to keep "the session says it's done" from being the only signal before you spend attention on it. It is not the category claim of the product (see [Why Own Your AI Infrastructure](./Why-Own-Your-AI-Infrastructure) and [Features](./Features) for why).

## How it works, at a high level

1. A card finishes working and is handed to the review stage.
2. A separate, fresh-context session reads the card's locked acceptance criteria and the evidence the working session produced, and renders a verdict.
3. A passing verdict on routine, low-risk work (a lightweight PR, a contained change) can clear the card straight to done or auto-merge.
4. A failing verdict, or anything carrying real judgment calls, routes to **Needs You** with the reviewer's reasoning attached, so you're looking at a graded result instead of a raw transcript.

Implementation lives in `app/server/src/services/poller-ai-review.ts` — verdict parsing, evidence capture, and the handback into the objective state machine.

## Why "fresh-context" matters

The reviewer doesn't share the working session's context window or its assumptions — it only sees the acceptance criteria and the evidence, the same way a second pair of eyes would. That's deliberate: a reviewer that inherited the worker's framing would tend to agree with it.

## What it isn't

It isn't a replacement for human review on anything that actually requires judgment — contested points, ambiguous scope, or decisions with real consequences still route to a person. It's a filter that keeps routine, well-specified work from consuming your attention one card at a time.
