// The author's OWN unit test (layers 1–3). It asserts only the RESPONSE — exactly
// the kind of test that passes against a hollow handler. This is why layers 1–3
// structurally cannot catch the defect: the test the author shipped is green.
import { createUser } from './handler.mjs'

const res = createUser('alice')
if (!res || res.status !== 200) {
  console.error(`unit test FAIL: expected status 200, got ${res && res.status}`)
  process.exit(1)
}
console.log('unit test ok (handler responded 200)')
