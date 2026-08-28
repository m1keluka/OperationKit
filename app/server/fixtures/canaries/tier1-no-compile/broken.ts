// CANARY (Tier-1, known-bad): does NOT compile.
// Stated acceptance criterion: "computeTotal returns the numeric sum of the line items."
// Defect: `total` is typed `number` but assigned a string, and the function returns
// that string. `tsc --noEmit` exits non-zero — the deterministic gate must reject.

export function computeTotal(items: number[]): number {
  let total: number = '0' // TS2322: Type 'string' is not assignable to type 'number'.
  for (const n of items) {
    total = total + n // string + number → string; return type violated
  }
  return total
}
