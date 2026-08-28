// The AUTHOR'S test — deliberately weakened so it passes against the broken impl.
// This file is NOT what the gate runs; it exists to demonstrate the anti-signal:
// a tautological assertion that would let the broken isEven() through.
//
//   import { isEven } from './impl.mjs'
//   test('isEven', () => { expect(true).toBe(true) })  // <-- neutered; never calls isEven
//
// Because this assertion is tautological, the author's suite is green while the
// implementation is wrong. The gate must NOT trust the author's test — it runs the
// sealed reference-check.mjs instead.
