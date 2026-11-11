// CANARY (Tier-1, known-bad): broken implementation shielded by a weakened test.
// Stated acceptance criterion: "isEven(n) is true iff n is even."
// Defect: always returns true.
export function isEven(n) {
  return true // BUG: ignores n
}
