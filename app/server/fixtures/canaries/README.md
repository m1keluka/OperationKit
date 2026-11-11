# Anti-signal canary fixtures (obj-2376, Rec #2)

Each subdirectory is a **self-contained, known-bad Tier-1 canary**: an OBVIOUSLY
broken artifact the deterministic gate MUST reject. The canary harness
(`app/server/src/services/canary-harness.ts`) feeds each one through the REAL
deterministic-floor evaluation path (`runFloor`) and asserts the gate rejects it
(a clean non-zero exit). A Tier-1 canary that is NOT rejected is a critical alarm
and writes a `gate_false_pass` row with `source='canary'`.

These are "tests of the test" (Kitchen Loop KL-7): we inject KNOWN-BAD inputs and
verify the gate catches them, so we can prove the gate works PROACTIVELY instead
of waiting for a human to reopen a bad merge.

## Layout

Each `<id>/` contains:
- `manifest.json` — `{ id, tier, description, brokenKind, expectedVerdict:"reject",
  commands:[…] }`. `commands` run IN ORDER inside the fixture dir; the first clean
  non-zero exit = the gate correctly rejecting the canary.
- the broken source the command exercises.

## The Tier-1 canaries

| id | brokenKind | how the gate rejects it |
|----|-----------|--------------------------|
| `tier1-no-compile`   | non-compiling | `tsc --noEmit` exits non-zero on a type error |
| `tier1-empty-stub`   | empty/stub impl | a behavioral check fails: the stub returns `undefined` instead of satisfying its stated acceptance criterion |
| `tier1-weakened-test`| assertion-weakened test | the author's own test was neutered to `expect(true).toBe(true)`; a SEALED reference check (which the weak test can't cheat) fails against the broken impl |
| `layer4-state-delta-noop` | wrong real outcome (KL-4 layer 4) | `createUser()` returns HTTP 200 but **writes nothing**. Compiles + the author's response-only unit test passes (layers 1–3 GREEN); the **layer-4** `state_delta_command` asserts the store actually grew and exits non-zero. Layers 1–3 MISS it; layer 4 catches it. |

Most commands use only `node` and `npx tsc` (already present) — no per-fixture
dependency install, so the harness is bounded and cheap (no agent spawn).

### Layer-4 canaries (obj 2508)

A canary may set an OPTIONAL `state_delta_command` in its manifest. It is run by
`runFloor` as the **4th floor step**, AFTER every `commands` entry passes. This lets
a canary prove the layer-4 (state-delta / E2E ground-truth) step earns its place:
the fixture passes compile + the author's own test, yet fails the state-delta
assertion (the real outcome the author cannot fake). `layer4-state-delta-noop` is
the reference example. The differential — `runFloor` with `commands` only returns
`pass` (escape), but `runFloor` WITH the `stateDeltaCommand` returns `fail` (caught)
— is asserted in `deterministic-floor.layer4.test.ts`.
