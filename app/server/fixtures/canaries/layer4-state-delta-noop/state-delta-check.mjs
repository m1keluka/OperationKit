// LAYER 4 (state-delta / E2E ground truth): assert the REAL outcome the author
// cannot fake. After a 200 "create user", the store must actually contain the new
// row. The broken handler writes nothing, so the delta is 0 and this exits non-zero.
// Layers 1–3 (node --check + the response-only unit test) pass; ONLY this catches
// the lie. This is the proof that layer 4 earns its place.
import { createUser, store } from './handler.mjs'

const before = store.length
const res = createUser('alice')
const after = store.length

if (res.status === 200 && after !== before + 1) {
  console.error(
    `STATE-DELTA FAIL: createUser returned 200 but the store grew by ${after - before} ` +
      `(expected 1). The row was never written — the success response is a lie.`,
  )
  process.exit(1)
}
console.log('state-delta ok (row persisted)')
