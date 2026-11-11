// cn — dependency-free className joiner for the OperationKit UI primitives.
// Filters falsy values so conditional classes (`cond && 'x'`) compose cleanly.
// Kept dep-free on purpose: adding clsx/tailwind-merge would force an image
// rebuild (new package.json) — these primitives never need class de-duping.
export type ClassValue = string | false | null | undefined
export function cn(...parts: ClassValue[]): string {
  return parts.filter(Boolean).join(' ')
}
