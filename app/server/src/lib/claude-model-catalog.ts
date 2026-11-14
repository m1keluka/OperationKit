// ── Curated Claude model catalog (obj 900796) ───────────────────────────────
// ONE place to add a Claude model when Anthropic ships one. Before this, a new
// Claude model needed a hand-written guarded INSERT in db/schema/models.ts, a
// regex in the usage-pricing table and a label in the card badge — and the
// provider refresh (services/model-refresh.ts) only ever inserts new ids
// DISABLED, so a model nobody hand-seeded never reached any picker. That is
// exactly how Claude Fable 5.2 (`claude-fable-5-2`, released 2026-11-09) went
// missing from the bot / agent model picker.
//
// What reads this list:
//   - db/schema/models.ts `seedCatalogModels()` — every entry with `seed: true`
//     is made selectable (enabled) ONCE per install, tracked per id in
//     `model_catalog_seeds`, so an admin who later switches it off stays off.
//   - services/unresulted-usage.ts — $/MTok for usage that arrived without a
//     CLI `result` event (exact-prefix match beats the family regexes).
//   - services/model-refresh.ts — a provider-discovered id that is in this list
//     gets the curated label instead of the provider's display name.
//
// Adding a model = one entry here (+ the test in claude-model-catalog.test.ts
// keeps the shape honest). Prices are Anthropic first-party API list prices.
//
// `seed: false` + `gated` = listed for pricing/labels only, never auto-enabled:
// Claude Mythos is limited to Anthropic-verified organizations, so turning it
// on for every install would hand cards a model most accounts cannot run (the
// CLI then falls back silently — see services/model-attribution.ts).

export interface ClaudeCatalogEntry {
  /** Claude API model id — exact, dateless. */
  id: string
  /** Display name shown in Settings → Models, the bot model field and the card picker. */
  label: string
  /** Registry sort order (lower = higher in the picker). */
  sort_order: number
  /** $ per million tokens. */
  price: { input: number; output: number; cache_read: number }
  /** Make it selectable on every install (once). */
  seed: boolean
  /** Why it is not seeded, when it is not. */
  gated?: string
  /** Release date (YYYY-MM-DD), for the record. */
  released?: string
}

export const CLAUDE_MODEL_CATALOG: readonly ClaudeCatalogEntry[] = [
  {
    id: 'claude-fable-5-2',
    label: 'Claude Fable 5.2',
    sort_order: 2,
    price: { input: 8, output: 40, cache_read: 0.2 },
    seed: true,
    released: '2026-11-09',
  },
  {
    id: 'claude-mythos-5-2',
    label: 'Claude Mythos 5.2',
    sort_order: 2,
    price: { input: 8, output: 40, cache_read: 0.2 },
    seed: false,
    gated: 'Anthropic-verified organizations only',
    released: '2026-11-09',
  },
  {
    id: 'claude-fable-5-1',
    label: 'Fable 5.1',
    sort_order: 3,
    price: { input: 10, output: 50, cache_read: 0.25 },
    seed: true,
  },
  {
    id: 'claude-opus-5-5',
    label: 'Opus 5.5',
    sort_order: 4,
    price: { input: 4, output: 20, cache_read: 0.2 },
    seed: true,
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    sort_order: 18,
    price: { input: 2, output: 10, cache_read: 0.2 },
    seed: true,
  },
]

/** The catalog entry for an exact id. */
export function catalogEntry(id: string | null | undefined): ClaudeCatalogEntry | undefined {
  if (!id) return undefined
  return CLAUDE_MODEL_CATALOG.find(e => e.id === id)
}

/**
 * The catalog entry a usage model string belongs to: an exact id, or the id
 * followed by a suffix (`claude-fable-5-2[1m]`, `claude-fable-5-2-20261109`).
 * The LONGEST matching id wins, so `claude-fable-5-2` never resolves to a
 * shorter sibling id such as `claude-fable-5`.
 */
// Allowed tails after an id: a `[1m]` context tag, an `@date` (Vertex), or a
// `-YYYYMMDD` snapshot. NOT `-2`: that is a different model.
const USAGE_SUFFIX = /^(\[|@|-\d{8}(\D|$))/

export function catalogEntryForUsage(model: string | null | undefined): ClaudeCatalogEntry | undefined {
  if (!model) return undefined
  const m = model.toLowerCase()
  let best: ClaudeCatalogEntry | undefined
  for (const e of CLAUDE_MODEL_CATALOG) {
    if (m === e.id || (m.startsWith(e.id) && USAGE_SUFFIX.test(m.slice(e.id.length)))) {
      if (!best || e.id.length > best.id.length) best = e
    }
  }
  return best
}
