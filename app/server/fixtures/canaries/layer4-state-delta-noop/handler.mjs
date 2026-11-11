// CANARY (layer-4, known-bad): a "create user" endpoint that returns HTTP 200 but
// NEVER persists the row. This is the classic "200 but writes nothing" lie — the
// code compiles, and a response-only unit test passes, so layers 1–3 see green.
// The defect is visible ONLY in the real state delta (KL-4 layer 4).
export const store = [] // the "database"

export function createUser(name) {
  // BUG: returns success without persisting. The intended (correct) impl would do:
  //   store.push({ name })
  // before returning. We deliberately omit it so layer 4 has something to catch.
  return { status: 200, body: { ok: true } }
}
