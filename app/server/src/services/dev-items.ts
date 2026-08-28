/**
 * Universal Development — core service (obj-704214).
 *
 * Every read and write of `dev_items` and its satellites goes through this
 * module. Specs: universal-development-schema.md (§2, §3, §4) and
 * universal-development-api.md (§4, §5, §6).
 *
 * THE SCOPING RULE (schema §5 mitigation 1). CC is not multi-tenant Postgres,
 * so the row-level tenancy that Supabase RLS gave both source platforms is now
 * an APPLICATION concern. The mitigation is that no route may build its own
 * `SELECT * FROM dev_items`: every read funnels through `scopedDevItems()` /
 * `getDevItem()` in dev-items-query.ts, which always apply the workspace
 * predicate and the `deleted_at IS NULL` filter. `dev-items-scoping.test.ts`
 * asserts this statically over the routes directory (and join-scans these
 * extracted modules).
 *
 * Split: vocab/types in dev-items-schema.ts, scoped reads in
 * dev-items-query.ts, writes/PR/idempotency in dev-items-mutate.ts.
 * This file is the re-export facade.
 */

export {
  CHANGELOG_CATEGORIES,
  DEV_ITEM_SEVERITIES,
  DEV_ITEM_STATUSES,
  DEV_ITEM_TYPES,
  DEV_NOTE_VISIBILITIES,
  DEV_PR_LINK_SOURCES,
  DEV_PR_STATES,
  DEV_SUBMITTED_VIA,
  devRef,
  statusLabel,
  type DevItemBoardRow,
  type DevItemRow,
  type DevItemSeverity,
  type DevItemStatus,
  type DevItemType,
  type DevNoteVisibility,
  type DevPrLinkSource,
  type DevPrState,
  type DevSubmittedVia,
} from './dev-items-schema.js'

export {
  countDevItems,
  facetCounts,
  getDevItem,
  listAttachments,
  listNotes,
  listSubmitterItems,
  listUnifiedPrs,
  scopedDevItems,
  serializeBoardRow,
  serializeDetailItem,
  type DevItemFilters,
  type DevItemSort,
  type UnifiedPr,
} from './dev-items-query.js'

export {
  PATCHABLE_FIELDS,
  addAttachment,
  addNote,
  advanceDevItemToInProgress,
  createDevItem,
  lookupIdempotency,
  parseDevRefs,
  promoteDevItem,
  rankDevItem,
  recordIdempotency,
  renormalizeWorkspaceRanks,
  resolveDevItemsFromBranch,
  resolveWorkspaceFromRepo,
  setDevItemPrState,
  shipDevItem,
  softDeleteDevItem,
  triageDevItem,
  updateDevItem,
  upsertDevItemPr,
  type CreateDevItemInput,
  type DevRef,
  type IdempotencyHit,
  type PromoteInput,
  type PromoteResult,
  type RankResult,
  type TriageInput,
} from './dev-items-mutate.js'
