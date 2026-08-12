# Tasks: Odoo `res.partner` → HubSpot Contact Sync (`partner-sync`)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1800–2400 (9 new src files, 6 modified src files, ~9 new test files; comparable product-sync files alone total ~530 lines) |
| Session review budget | 800 lines (`review_budget_lines`) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 → PR 3 → PR 4 |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending (user decision required) |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Odoo partner source + client (Phase 1) | PR 1 | `npx vitest run test/adapters/outbound/odoo/OdooPartnerSource.test.js test/adapters/outbound/odoo/odooApiClient.partner.test.js` | N/A — pure adapter/unit layer, no live Odoo call in CI | Delete both new files/tests; no other flow imports them |
| 2 | HubSpot contact gateway + property provisioning (Phase 2) | PR 2 | `npx vitest run test/adapters/outbound/hubspot/HubspotContactGateway.test.js test/adapters/outbound/hubspot/partnerToContactMapper.test.js test/adapters/outbound/hubspot/hubspotApiClient.contact.test.js test/composition/contactPropertyDefinitions.test.js` | N/A — fake apiClient, no live HubSpot call | Delete gateway/mapper/property-def files; unused if PR1 unmerged |
| 3 | Domain entity + Mongo mapping/run repos (Phase 3) | PR 3 | `npx vitest run test/core/domain/PartnerMapping.test.js test/adapters/outbound/mongo/MongoPartnerMappingRepository.test.js test/adapters/outbound/mongo/MongoPartnerSyncRunRepository.test.js` | `mongodb-memory-server` (already a devDependency) | Drop new collections/schemas; no shared schema touched |
| 4 | Sync module + tick job + wiring + docs (Phase 4) | PR 4 | `npx vitest run test/composition/partnerSyncModule.test.js test/composition/partnerSyncJobModule.test.js && npm test` | `node scripts/probes/partner-sync.probe.js` against stub Odoo mode | Set `PARTNER_SYNC_JOB_ENABLED=false`; revert `server.js`/`config`/`constants.js` additive blocks |

## Phase 1: Odoo Partner Source + Client (PR 1)

- [x] 1.1 RED: `test/adapters/odoo/odooApiClient.partner.test.js` — stub returns `0`/`[]`; http asserts exact `PARTNER_DOMAIN`/`PARTNER_FIELDS` payload for all 3 methods. (Note: actual repo test path is `test/adapters/odoo/`, not `test/adapters/outbound/odoo/` as originally written here — src already follows that split, test/ does not mirror it.)
- [x] 1.2 GREEN: add `countPartners`, `searchPartnersAll`, `searchPartnersChangedSince` (stub+http) to `src/adapters/outbound/odoo/odooApiClient.js`.
- [x] 1.3 RED: `test/adapters/odoo/OdooPartnerSource.test.js` — paging, short-page stop, `limit`, generator termination, missing `writeDateGte` throws.
- [x] 1.4 GREEN: create `src/adapters/outbound/odoo/OdooPartnerSource.js` (`count`, `listAll`, `listChangedSince`).

## Phase 2: HubSpot Contact Gateway + Property Provisioning (PR 2)

- [x] 2.1 RED: `test/adapters/outbound/hubspot/hubspotApiClient.contact.test.js` — search/create/update/batchUpsert via `requestWithRateLimit`.
- [x] 2.2 GREEN: add `searchContactByProperty`, `createContact`, `updateContact`, `batchUpsertContacts` to `src/adapters/outbound/hubspot/hubspotApiClient.js`.
- [x] 2.3 RED: `test/adapters/hubspot/partnerToContactMapper.test.js` — company vs individual, `''` on empty, all keys always present.
- [x] 2.4 GREEN: create `src/adapters/outbound/hubspot/partnerToContactMapper.js` (`mapPartnerToContactProperties`, `splitName`).
- [x] 2.5 RED: `test/adapters/hubspot/HubspotContactGateway.test.js` — create vs update, 409 duplicate, chunking at 100, `idProperty` propagation, skip reasons.
- [x] 2.6 GREEN: create `src/adapters/outbound/hubspot/HubspotContactGateway.js`.
- [x] 2.7 RED: `test/composition/contactPropertyDefinitions.test.js` — returns `id_contacto_odoo` definition shape.
- [x] 2.8 GREEN: create `src/composition/contactPropertyDefinitions.js` (`buildContactPropertyDefinitions`).

## Phase 3: Domain Entity + Mongo Mapping (PR 3)

- [x] 3.1 RED: `test/core/domain/PartnerMapping.test.js` — `buildPartnerMapping`/`recordSyncSuccess` invariants throw on null id/invalid action.
- [x] 3.2 GREEN: create `src/core/domain/PartnerMapping.js`.
- [x] 3.3 RED: `test/adapters/outbound/mongo/MongoPartnerMappingRepository.test.js` (`mongodb-memory-server`) — upsert, `bulkUpsertMany`, `findByOdooId`, `listAll`, `listPaginated`, `clear`.
- [x] 3.4 GREEN: create `src/adapters/outbound/mongo/schemas/partnerMapping.schema.js` and `MongoPartnerMappingRepository.js`.
- [x] 3.5 RED: `test/adapters/outbound/mongo/MongoPartnerSyncRunRepository.test.js` — run-history parity with product sync.
- [x] 3.6 GREEN: create `src/adapters/outbound/mongo/schemas/partnerSyncRun.schema.js` and `MongoPartnerSyncRunRepository.js`.

## Phase 4: Sync Module + Tick Job + Wiring + Docs (PR 4)

- [x] 4.1 RED: `test/composition/partnerSyncModule.test.js` + `.incremental.test.js` — watermark advances only on `failed===0`, 60s overlap, archived skipped, no mapping persist on batch failure.
- [x] 4.2 GREEN: create `src/composition/partnerSyncModule.js` (`runOnce`, `runIncremental`, `syncOneItem`).
- [x] 4.3 RED: `test/composition/partnerSyncJobModule.test.js` — seeding, `scheduleNextTick` in `finally` on success/throw, dead-letter path.
- [x] 4.4 GREEN: create `src/composition/partnerSyncJobModule.js` (byte-shape of `productSyncJobModule`, `JOB_KIND.PARTNER_SYNC`).
- [x] 4.5 Add `JOB_KIND.PARTNER_SYNC = 'partner_sync'` to `src/config/constants.js`.
- [x] 4.6 Add `partnerSync` config block + `hubspot.propertyOdooPartnerId` to `src/config/index.js`.
- [x] 4.7 Wire `src/server.js`: conditional block, third `provisionProperties` call, `startWorker`/`stopWorker`/return entry.
- [x] 4.8 Create `scripts/probes/partner-sync.probe.js` (throttled backfill probe, mirrors `scripts/sync-products.js`).
- [x] 4.9 Regression: run `npm test`; confirm product/sale-order-status/MO-retry suites pass unmodified.
- [x] 4.10 Update `ARQUITECTURA.md` §11.3 with the partner-sync flow entry.
- [x] 4.11 Update `README.md` with new env vars (`PARTNER_SYNC_*`, `HS_PROPERTY_ODOO_PARTNER_ID`) and feature note.
