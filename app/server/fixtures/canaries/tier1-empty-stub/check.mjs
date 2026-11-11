// Behavioral acceptance check for the empty-stub canary. Exits non-zero when the
// implementation does not satisfy its stated criterion — which it cannot, being a
// stub. This is the deterministic signal the gate keys on.
import { discountedPrice } from './impl.mjs'

const got = discountedPrice(100, 20)
const want = 80
if (got !== want) {
  console.error(`ACCEPTANCE FAIL: discountedPrice(100,20) = ${got}, expected ${want} (stub never implemented)`)
  process.exit(1)
}
console.log('ok')
