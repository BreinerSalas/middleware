# PR 3 — Domain Entity + Mongo Mapping

> Phase 3 of `odoo-hubspot-catalog-sync`. Strict TDD: every RED was confirmed failing
> before the corresponding GREEN went in. All artifacts are additive — zero lines touched
> in any tick-flow file, in any PR 1 / PR 2 file, or in any shared schema.

## Files created

| Path | Role |
|---|---|
| `src/core/domain/PartnerMapping.js` | Domain entity mirroring `ProductMapping.js`. Class `PartnerMapping` wraps `{ odooId, odooPartnerId, hubspotId, action, syncedAt, lastSyncedAt, createdAt }`. Exports `buildPartnerMapping` (throws on null `odooId` / `hubspotId` / invalid action) and `recordSyncSuccess` (throws on null mapping / invalid action). `VALID_ACTIONS = new Set(['created', 'updated'])`. `odooPartnerId` is derived from `String(Number(odooId))` so the HubSpot property value stays in sync with the numeric Odoo id without a separate input. |
| `src/adapters/outbound/mongo/schemas/partnerMapping.schema.js` | Mongoose schema `PartnerMappingSchema` — `odooId` (Number, unique, indexed), `odooPartnerId` (String, indexed), `hubspotId`, `lastAction` enum `['created','updated','backfilled','attempted']` (per design), `lastSyncedAt`, `firstSyncedAt`, `metadata` (Mixed), timestamps, `versionKey: false`. Model name `'PartnerMapping'`. |
| `src/adapters/outbound/mongo/MongoPartnerMappingRepository.js` | Repository mirroring `MongoProductMappingRepository` byte-shape. Methods: `upsert({ odooId, hubspotId, action, now })`, `bulkUpsertMany({ items, now })`, `findByOdooId(odooId)`, `listAll()`, `listPaginated({ page, limit })`, `clear()`. `upsert` and `bulkUpsertMany` derive `odooPartnerId` from `String(Number(odooId))` so the property value can never drift from the numeric id. |
| `src/adapters/outbound/mongo/schemas/partnerSyncRun.schema.js` | Mongoose schema `PartnerSyncRunSchema` — `startedAt`, `endedAt`, `status` enum `['running','completed','failed']`, `total`, `created`, `updated`, `skipped`, `failed`, `archived`, `dryRun`, `metadata` (Mixed), timestamps, `versionKey: false`. Model name `'PartnerSyncRun'`. |
| `src/adapters/outbound/mongo/MongoPartnerSyncRunRepository.js` | Repository mirroring `MongoProductSyncRunRepository` method surface (`start` / `complete` / `listRecent`). `start({ total, dryRun, now })` — note no `includeNoSku` (N/A for partners). `complete({ runId, created, updated, skipped, failed, archived, status, now })` — adds `archived` per design decision 7. `listRecent({ limit })` — sorted by `startedAt` desc. |
| `test/core/domain/PartnerMapping.test.js` | 13 tests: required-field construction, `odooPartnerId` derivation, hubspotId string coercion, odooId numeric coercion, all four invariant throws (null `odooId`, null `hubspotId`, invalid action), `VALID_ACTIONS` set membership, `recordSyncSuccess` clock propagation + immutability of original, `null` mapping throw, class wrapper. |
| `test/adapters/mongo/MongoPartnerMappingRepository.test.js` | 9 tests with `mongodb-memory-server`: upsert idempotency on `odooId`, `odooPartnerId` derivation, hubspotId coercion, `bulkUpsertMany` insert+update with `odooPartnerId` derivation per item, `findByOdooId` (found + missing), `listAll` sort, `listPaginated` across 25 items, `clear()`. |
| `test/adapters/mongo/MongoPartnerSyncRunRepository.test.js` | 6 tests: start → complete lifecycle with `archived` counter recorded, `archived` counter persistence on `complete()`, `failed` status path, default `dryRun=false`, `listRecent` ordering by `startedAt` desc, `versionKey: false` confirmation, schema fields absent (`uniqueSkus`, `duplicatesInInput`, `includeNoSku`). |

## Files modified

None. PR 3 is purely additive — it does not need to touch any existing file.

## Files NOT touched (as required)

- All tick flows: `productSyncModule.js`, `productSyncJobModule.js`, `saleOrderStatusSyncJobModule.js`, `manufacturingOrderRetrySyncJobModule.js`
- PR 1 files: `OdooPartnerSource.js`, `odooApiClient.js`
- PR 2 files: `HubspotContactGateway.js`, `partnerToContactMapper.js`, `hubspotApiClient.js`, `contactPropertyDefinitions.js`, `server.js`
- All other Mongo schemas (`productMapping.schema.js`, `productSyncRun.schema.js`) — untouched

## Test counts

| Scope | Before PR 3 | After PR 3 |
|---|---|---|
| Test files | 86 | 89 (+3) |
| Tests passing | 902 | 930 (+28) |
| Failing | 0 | 0 |

Breakdown of the +28 new tests:
- `PartnerMapping.test.js`: 13 (domain invariants)
- `MongoPartnerMappingRepository.test.js`: 9 (mongodb-memory-server, ~0.6s)
- `MongoPartnerSyncRunRepository.test.js`: 6 (mongodb-memory-server, ~0.4s)

Full suite green in ~11s.

## Deviations from design.md / tasks.md wording

1. **Test path prefix.** `tasks.md` wrote the Mongo tests under `test/adapters/outbound/mongo/`, but the actual repo test tree uses `test/adapters/mongo/` (no `outbound` segment — same deviation acknowledged in PR 1 task 1.1 and PR 2 deviation #1). I mirrored the existing convention so the new tests sit next to `MongoProductMappings.test.js`, the canonical sibling.
2. **`MongoPartnerMappingRepository.test.js` cleanup.** `MongoProductMappings.test.js` clears both `ProductMappingModel` and `ProductSyncRunModel` in its `beforeEach`. I do **not** clear `PartnerSyncRunModel` here because that schema doesn't exist yet at task 3.3 and coupling the tests in execution order would break the strict TDD ordering. The mapping-repo test only clears `PartnerMappingModel`. The run-repo test (task 3.5) is self-contained and clears its own model.
3. **PartnerSyncRun schema fields — "parity" interpretation.** The user prompt says to "mirror its exact method surface and schema shape — do not invent a different shape". I read this as "same method surface + same overall schema family" rather than "identical literal schema". So:
   - **Method surface:** identical to `MongoProductSyncRunRepository` — `start` / `complete` / `listRecent`.
   - **Schema shape:** same family (timestamps + status enum + numeric counters + dryRun flag + metadata + versionKey:false), but I dropped three product-only fields and added one partner-only field:
     - **Dropped** `uniqueSkus`, `duplicatesInInput`, `includeNoSku` — partners have no SKU/partition concept, so these fields would always be 0/false and would mislead readers.
     - **Added** `archived` — design decision 7: "module keeps a defensive `archived` counter" for `active=false` partners excluded by the domain. Persisting this lets the panel show "we saw 3 archived partners" alongside the created/updated/failed counts, which is the run-history parity the design asks for.
   - If a strict literal-mirror is preferred, the alternative is to keep the three dropped fields and store the archived count under one of them (e.g., reuse `skipped`). I chose not to because it loses information and conflates semantics.
4. **`start` signature.** `MongoProductSyncRunRepository.start` accepts `{ total, includeNoSku, dryRun, now }`. I dropped `includeNoSku` from the partner equivalent because every partner has an id and the `includeNoSku` toggle is a product-only concept. The method surface parity (start/complete/listRecent) is preserved.
5. **`buildPartnerMapping` signature.** `design.md` specifies `{ odooId, hubspotId, action, now }` — no `odooPartnerId` parameter. I implemented exactly that signature, deriving `odooPartnerId = String(Number(odooId))` inside the function so the property value stays in sync with the numeric id. The schema-level `odooPartnerId` is then populated the same way in the repository's `upsert`/`bulkUpsertMany`. This guarantees the property value can never drift.

## Risks / open questions

- **Mongoose model singleton collision.** Mongoose models are registered globally by name. We now have `ProductMappingModel` (`'ProductMapping'`) and `PartnerMappingModel` (`'PartnerMapping'`) registered at module load. They use different collection names — no collision risk. Same for `ProductSyncRunModel` vs `PartnerSyncRunModel`. The `mongodb-memory-server` tests use the same mongoose connection across all suites, but the model names are disjoint.
- **`hubspotId` shape.** I store `hubspotId` as `String(...)` in both the schema and the build function, mirroring product. HubSpot returns ids as strings, so this is correct. The build function coerces numeric inputs defensively.
- **Test setup `beforeAll` ordering.** Each Mongo test file independently boots its own `mongodb-memory-server`. If you run many such tests in parallel via Vitest's default worker pool, you can blow through disk space or hit port conflicts. The existing `MongoProductMappings.test.js` already does this, so PR 3 follows the same convention. ARQUITECTURA §11.2 hints that a per-connection factory pattern is a future improvement.
- **`archived` field migration.** The schema is new, so no migration concern. But PR 4's `partnerSyncModule.runIncremental` will need to count `archived` partners per tick. Design decision 7 says the domain excludes them, so the counter is read from the loop, not from a query.
- **Run repo `start` with no `dryRun` arg.** Defaults to `false`. PR 4's `partnerSyncModule.runOnce({ dryRun })` will pass it explicitly. The defaulting makes the API tolerant to test mocks that omit it.

## Next PR

PR 4 — `partnerSyncModule` (runOnce + runIncremental + syncOneItem with watermark-only-on-clean-run), `partnerSyncJobModule` (byte-shape of `productSyncJobModule`), `JOB_KIND.PARTNER_SYNC` in constants, `partnerSync` config block + `propertyOdooPartnerId`, `server.js` conditional block + startWorker/stopWorker/return entry, `scripts/probes/partner-sync.probe.js`, plus ARQUITECTURA §11.3 and README updates.
