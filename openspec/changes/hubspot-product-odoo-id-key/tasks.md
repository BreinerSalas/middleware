# Tasks: HubSpot Product Identity — `id_producto_odoo` upsert key + `hs_product_id` line-item resolution

> Source artifacts: `proposal.md` (rev 2), `specs/product-sync-identity/spec.md`, `specs/deal-product-resolution/spec.md`, `design.md`.
> Strategy: auto-chain (stacked-to-main, 3 PRs) · Review budget: 800 lines · TDD strict (RED → GREEN).
> Capability split per design D3: two decoupled mechanisms + backfill as separate operational concern.

## PR Boundaries (stacked-to-main)

Original forecast (1100-1400 est. lines for the whole change) undershot: the real diff for what was originally "PR 1" (Fases 1, 2, 4, 5) measured ~2140 changed lines once implemented (829 insertions + 663 deletions across 22 tracked files, plus 647 lines across 8 new files) — itself over budget. Re-split into 3 stacked PRs on `main`.

```text
main
 └── PR 1a: catalog identity (Fases 1, 2)
      └── PR 1b: backfill + docs (Fases 4, 5) — stacked on PR 1a's branch
           └── PR 2: deal-product resolution (Fase 3) — stacked on PR 1b's branch
```

| PR | Fases | Scope | Base |
|----|-------|-------|------|
| PR 1a | 1, 2 | `id_producto_odoo` provisioning + product-sync identity rework (gateway, apiClient, syncModule, domain) | `main` |
| PR 1b | 4, 5 | Backfill script (idempotent, business-hours safe) + superseded-doc banner | PR 1a's branch |
| PR 2 | 3 | `hs_product_id` → `product_mapping` line-item resolution tier + `dealSyncModule` wiring (revenue-critical path) | PR 1b's branch |

PR 1b depends on PR 1a (`id_producto_odoo` config/property definitions, `findByHubspotId`, relaxed `ProductMapping` contract). PR 2 depends on PR 1b (needs the backfilled `product_mapping` rows to be non-trivial in practice) and on PR 1a (`findByHubspotId`). After each parent PR merges to `main`, rebase/retarget the next child so it shows only its own diff.

## Fase 1: Property provisioning (PR 1a)

- [x] 1.1 RED — `test/config/index.test.js`: add cases for `hubspot.propertyOdooProductId` (default `'id_producto_odoo'`, env override `HS_PROPERTY_ODOO_PRODUCT_ID`) and `productSync.includeNoSku` default `true` (env override `PRODUCT_SYNC_INCLUDE_NO_SKU` only flips when explicitly set). Confirm RED with current `undefined` defaults.
- [x] 1.2 GREEN — `src/config/index.js`: register `hubspot.propertyOdooProductId` and `productSync.includeNoSku = true` defaults; respect explicit env overrides for the no-SKU flag. Run Phase 1.1 GREEN.
- [x] 1.3 RED — `test/composition/productPropertyDefinitions.test.js` (NEW): `buildProductPropertyDefinitions(cfg)` returns exactly one definition whose `name === cfg.hubspot.propertyOdooProductId`, `label: 'ID Producto Odoo'`, `type: 'string'`, `fieldType: 'text'`, `groupName: 'productinformation'`, `hasUniqueValue: true`. Confirm RED (file does not exist or returns wrong shape).
- [x] 1.4 GREEN — `src/composition/productPropertyDefinitions.js` (NEW): implement `buildProductPropertyDefinitions(cfgHubspot)` returning the array above; mirror the `contactPropertyDefinitions.js` style.
- [x] 1.5 RED — `test/composition/serverBoot.provisioning.test.js` (NEW or extend existing boot test): when `provisionProperties({ objectType: 'products' })` reports `status: 'failed'` for the `id_producto_odoo` entry, boot MUST throw and MUST NOT proceed; when products summary is clean, boot completes. Confirm RED (current code only warns on per-property failures, no products call).
- [x] 1.6 GREEN — `src/server.js`: call `provisionProperties({ objectType: 'products' })` after the existing deals/quotes/contacts calls; on the products summary, throw if any entry has `status: 'failed'` (D7). No SKU fallback path added. Run Phase 1.5 GREEN; confirm `npm test` unaffected for unrelated suites.

## Fase 2: Product sync identity (PR 1a)

- [x] 2.1 RED — `test/core/domain/ProductMapping.test.js`: add cases asserting `buildProductMapping` accepts `null`, `undefined`, `false`, and `''` as `hsSku` and returns a valid mapping with `hsSku: null`; existing `odooId`/`hubspotId`/`action` requirement cases remain green. Confirm RED (current code throws on falsy `hsSku`).
- [x] 2.2 GREEN — `src/core/domain/ProductMapping.js`: drop the `if (!hsSku) throw` guard; keep `odooId` + `hubspotId` + valid `action` checks; normalize `hsSku` to `null` when null/absent/`false`/whitespace. Run Phase 2.1 GREEN.
- [x] 2.3 RED — `test/adapters/mongo/MongoProductMappingRepository.test.js`: add cases for `findByHubspotId(hubspotId)`: (a) hit returns `{ odooId: number }`; (b) miss returns `null`; (c) input `null`/`undefined`/`''`/`'null'` returns `null` WITHOUT issuing a Mongo query (assert via spy/fake collection `findOne` not called). Confirm RED.
- [x] 2.4 GREEN — `src/adapters/outbound/mongo/MongoProductMappingRepository.js`: implement `findByHubspotId(hubspotId)` with the null/empty/`'null'` short-circuit before the query; mirror `findByOdooId` shape. Also update `src/adapters/outbound/mongo/schemas/productMapping.schema.js` to mark `hubspotId` as `index: true, sparse: true` (tier 2 queries it per line item). Run Phase 2.3 GREEN; full repo suite green.
- [x] 2.5 — `src/core/application/ports/ProductMappingRepositoryPort.js` (NEW): JSDoc `typedef` documenting `findByHubspotId(id) => Promise<{odooId:number}|null>`. **No RED task**: ports dir is coverage-excluded and this file is contract-only typedef, no runtime behavior to drive with a failing test. Document the contract here so Fase 3.2's consumer can reference it.
- [x] 2.6 RED — `test/adapters/hubspot/hubspotApiClient.lineItems.test.js` (or extend existing): exported `LINE_ITEM_PROPERTIES` MUST include `'hs_product_id'` alongside `hs_sku`, `quantity`, `price`, `name`; and `getLineItemsFor` / `getDealLineItems` / `getQuoteLineItems` map `hs_product_id` into the returned line-item shape. Confirm RED (current `LINE_ITEM_PROPERTIES` lacks `hs_product_id`).
- [x] 2.7 GREEN — `src/adapters/outbound/hubspot/hubspotApiClient.js`: add `'hs_product_id'` to `LINE_ITEM_PROPERTIES`; map `hs_product_id` into the normalized line-item object in the read/mapping path (~line 139). Run Phase 2.6 GREEN.
- [x] 2.8 RED — `test/adapters/hubspot/hubspotApiClient.productSearch.test.js` (or extend existing): `searchProductByOdooId(odooId)` issues `POST /crm/v3/objects/products/search` with a filter on `id_producto_odoo = odooId`; returns the existing product record. Existing `searchProductByHsSku` is removed. Confirm RED.
- [x] 2.9 GREEN — `src/adapters/outbound/hubspot/hubspotApiClient.js`: add `searchProductByOdooId(odooId)`; remove `searchProductByHsSku`. Update internal callers (HubspotProductGateway) to use the new function. Run Phase 2.8 GREEN; grep `src/` to confirm zero remaining `searchProductByHsSku` references.
- [x] 2.10 RED — `test/adapters/hubspot/hubspotApiClient.batchUpsert.test.js`: `batchUpsertProducts({ inputs, idProperty })` defaults `idProperty` to `'id_producto_odoo'`; when caller passes `idProperty: null`, the per-input `idProperty` field is OMITTED from the request body (so HubSpot treats `inputs[i].id` as the native object id — required by the backfill). Confirm RED.
- [x] 2.11 GREEN — `src/adapters/outbound/hubspot/hubspotApiClient.js`: implement `idProperty` defaulting and the `null` ⇒ omit behavior in `batchUpsertProducts`. Run Phase 2.10 GREEN.
- [x] 2.12 RED — `test/adapters/hubspot/HubspotProductGateway.test.js`: replace SKU-key assertions — `hasValidOdooId(props)`/`extractOdooId(props)` are the key extractors; `buildProperties({ odooId, defaultCode, ... })` writes `id_producto_odoo: String(odooId)` always, writes `hs_sku` ONLY when `defaultCode` is truthy/non-empty, and never throws on absent SKU. Confirm RED.
- [x] 2.13 GREEN — `src/adapters/outbound/hubspot/HubspotProductGateway.js`: introduce `hasValidOdooId`/`extractOdooId`; remove `hasValidSku`/`extractSku` from the key path (keep as informational helpers if used elsewhere); reimplement `buildProperties` per 2.12. Run Phase 2.12 GREEN.
- [x] 2.14 RED — `test/adapters/hubspot/HubspotProductGateway.batch.test.js`: `upsertByOdooId`/`batchUpsertByOdooIds` accept Odoo-id-keyed inputs; the batch path dedupes by Odoo id (no-op on impossible collision); NO `no_sku` skip entries and NO `duplicate_sku_in_input` skip entries appear in batch results. Confirm RED (current code has both skip paths).
- [x] 2.15 GREEN — `src/adapters/outbound/hubspot/HubspotProductGateway.js`: implement `upsertByOdooId` and `batchUpsertByOdooIds`; remove `no_sku` and `duplicate_sku_in_input` skip emission; correlate batch results by `inputs[i].id` (which is the Odoo id by construction). Run Phase 2.14 GREEN; full gateway suite green.
- [x] 2.16 RED — `test/composition/productSyncModule.test.js` + `.batch.test.js` + `.persistence.test.js` + `.incremental.test.js`: rewrite SKU-partition assertions — module no longer partitions `withSku`/`withoutSku`; correlation by sent Odoo id (add a case where `hs_sku` echo is absent OR mismatched, asserting correlation still works); `persistMappings` persists a row for a no-SKU product (no `hsSku` filter). Confirm RED.
- [x] 2.17 GREEN — `src/composition/productSyncModule.js`: delete the `partition` step; emit one batch path over the full product list with Odoo ids as batch `id`s; correlate results by sent Odoo id; `persistMappings` removes the `hsSku`-truthy filter (calls `bulkUpsertMany` for every product with a `hubspotId`); `runOnce`/`runIncremental` set `includeNoSku = true` by default. Run Phase 2.16 GREEN.
- [x] 2.18 GREEN — `scripts/sync-products.js`: flip CLI semantics — `--include-no-sku` becomes `--only-with-sku` (opt-out), default behavior includes everything; align arg parsing with the new config default. Update any inline docstrings/help text. Run `test/scripts/sync-products.test.js` GREEN.

## Fase 3: Deal product resolution (PR 2 — stacked on PR 1b's branch)

- [x] 3.1 RED — `test/adapters/odoo/OdooTargetGateway.productResolution.test.js` (NEW, 7 cases):
  - T1 wins over T2: line item carries both resolvable numeric `hs_sku`/`productId` AND a `hs_product_id` whose mapping exists — only `lookupByDefaultCode` runs, `lookupByHubspotProductId` is never invoked.
  - T2 resolves when `hs_sku: null`: line item has `hs_product_id`, repo returns mapping — `productId` is set, `lookupByName` is NEVER called (spy assertion).
  - Unmapped `hs_product_id` falls through: line item has `hs_product_id`, repo returns `null` — `lookupByName` runs as normal, no fabricated Odoo id.
  - All tiers fail ⇒ `SkipSyncError` with `hsProductId` in the unresolved detail (extend `describeUnresolved`).
  - Repo absent (`productMappingRepository` not injected) ⇒ byte-identical pre-change behavior (only SKU and name tiers run).
  - Repo throws ⇒ `TransientSyncError` raised, no sale-order line created downstream.
  - UoM still filled after a T2 match: `resolveProductUoms` populates uom for items resolved via tier 2.

  Confirm RED (file does not exist).
- [x] 3.2 GREEN — `src/adapters/outbound/odoo/OdooTargetGateway.js`: ctor accepts `productMappingRepository = null` and stores it (no constructor guard — D4 self-disable); add module-level `applyProductMappingMatch(li, map)` mirroring `applySkuMatch`/`applyNameMatch`; extend `collectUnresolvedLines` entry to carry `hsProductId`; extend `describeUnresolved` to mention `hsProductId`. Run Phase 3.1 cases 5 (repo absent) and 4 (skip-detail) GREEN.
- [x] 3.3 GREEN — `src/adapters/outbound/odoo/OdooTargetGateway.js`: add `lookupByHubspotProductId(lineItems, correlationId)` — short-circuits to `{}` when repo absent (D4); dedupes ids; returns `{ [hsProductId]: odooId }`; on throw, logs and rethrows as `TransientSyncError('product_mapping lookup by hubspotId failed', { cause: err })` (D5). Run Phase 3.1 case 6 GREEN.
- [x] 3.4 GREEN — `src/adapters/outbound/odoo/OdooTargetGateway.js`: rework `resolveProductIds` into 3 stages — `bySku = await lookupByDefaultCode` → `staged1 = lineItems.map(applySkuMatch)` → `byHsProd = await lookupByHubspotProductId(staged1)` → `staged2 = staged1.map(applyProductMappingMatch)` → `byName = await lookupByName(staged2)` → return `staged2.map(applyNameMatch)`. Tier 2 runs ONLY for items where `resolveProductId(li) == null` and `li.hs_product_id` is truthy. Run Phase 3.1 cases 1, 2, 3, 7 GREEN; full gateway suite GREEN.
- [x] 3.5 RED — `test/composition/dealSyncModule.test.js`: assert the gateway instance receives `productMappingRepository` (the same `MongoProductMappingRepository` instance the module constructs). Existing wiring test must be tightened from "accidental pass" to a real contract assertion. Confirm RED (current ctor call does not pass the repo).
- [x] 3.6 GREEN — `src/composition/dealSyncModule.js`: at the single `new OdooTargetGateway(...)` site (line ~82), add `productMappingRepository: new MongoProductMappingRepository()` to the constructor argument map. Run Phase 3.5 GREEN.

## Fase 4: Backfill (PR 1b — stacked on PR 1a's branch)

- [x] 4.1 RED — `test/scripts/backfillProductOdooId.test.js` (NEW, case 1): running the script twice against the same HubSpot/Repo fixtures leaves the final state identical to running it once — asserting per-product write is a no-op when the existing `id_producto_odoo` already equals `odooId` (no duplicate update, no extra `product_mapping` row). Confirm RED.
- [x] 4.2 RED — `test/scripts/backfillProductOdooId.test.js` (case 2): `product_mapping` rows with `lastAction ∈ {backfilled, no_sku_no_match}` (D6 heuristic rows) are NOT promoted — they do NOT receive an `id_producto_odoo` write, and they do NOT appear in the "promoted" set; if name-unicity is satisfied they MAY be reported to the quarantine JSON but never written to HubSpot. Confirm RED.
- [x] 4.3 RED — `test/scripts/backfillProductOdooId.test.js` (case 3): `--dry-run` issues zero writes — assert `batchUpsertProducts` mock is never called and no `product_mapping` upserts occur; the script still emits the same summary/log lines. Confirm RED.
- [x] 4.4 GREEN — `scripts/backfill-product-odoo-id.js` (NEW, idempotent + business-hours safe):
  - **Phase A (authoritative)**: read `product_mapping` rows with non-null `hubspotId` and `lastAction ∈ {created, updated}`; write `id_producto_odoo = String(odooId)` via `batchUpsertProducts({ inputs: [{ id: hubspotId, properties: { id_producto_odoo } }], idProperty: null })`, 100/chunk; under the existing `rps:15/burst:20` limiter (~11k ÷ 100 ≈ 110 calls, business-hours safe).
  - **Phase B (quarantine)**: rows with `lastAction ∈ {backfilled, no_sku_no_match}` (D6 heuristic) — promote ONLY when `normalizeProductName(name)` matches exactly one Odoo product AND one HubSpot product; otherwise write a quarantine JSON entry and leave unmapped.
  - **`--dry-run` flag**: every write path gated by the flag; default is real run.
  - **Idempotency**: writing the same `id_producto_odoo` value to a product is a no-op update; no `product_mapping` rows are duplicated.
  - **Operational**: emits per-phase counts (read, written, quarantined, skipped), a final reconciliation line (`written ≈ hubspot product count`), and a non-zero exit code if reconciliation mismatches.
  - Run Phase 4.1 / 4.2 / 4.3 GREEN; `npm test` full green.

## Fase 5: Docs (synthetic SKU plan superseded) (PR 1b)

- [x] 5.1 — `docs/todo-sku-sintetico.md`: prepend a "Superseded" banner — state that this change (`hubspot-product-odoo-id-key`) replaces the synthetic-SKU plan via `hs_product_id` resolution + `id_producto_odoo` identity, no customer-visible field ever modified; record the policy decision (no synthetic SKU under any future proposal). No code/test changes; doc-only.

## Review Workload Forecast

Estimated changed lines: 1100-1400
400-line budget risk: High
800-line budget risk: High
Chained PRs recommended: Yes
Decision needed before apply: Yes

### Justification

The change spans ~30 files (3 NEW source files, ~12 modified source files, 2 NEW test files, ~9 modified test files, 1 doc). Production code alone reaches roughly 600–900 net lines once `HubspotProductGateway`, `hubspotApiClient`, `productSyncModule`, and `OdooTargetGateway` reworks are summed — each is a non-trivial multi-method change. Test surface adds another 500–700 lines: the NEW `test/adapters/odoo/OdooTargetGateway.productResolution.test.js` carries 7 explicit RED cases (≈200–280 lines), the NEW `test/scripts/backfillProductOdooId.test.js` carries 3 RED cases plus dry-run scaffolding (≈120–180 lines), and the four rewritten `productSyncModule.*.test.js` suites plus `HubspotProductGateway.test.js` / `.batch.test.js`, `MongoProductMappingRepository.test.js`, `dealSyncModule.test.js`, `hubspotApiClient.*.test.js`, `ProductMapping.test.js`, and the boot/provisioning test together add another 300–500 lines of modified assertions. Net diff lands at ~1100–1400 lines against the 800-line review budget — a clear High risk on both the 400-line and 800-line budgets. Chained PRs are recommended even under the user's fixed single-PR strategy because the design's D3 ("Two mechanisms, not one") and the migration/rollout section make tier 2 a hard precondition on backfill completeness — splitting the change into (PR1: provisioning + identity + backfill) and (PR2: line-item resolution tier + composition wiring) would isolate the revenue-critical deal → sale-order path for focused review and would let the backfill ship ahead of the new resolution tier. Three decisions are open and block apply per `design.md` §Open Questions: (a) `groupName: 'productinformation'` must be verified against the live portal before the provisioning call ships (D7 turns a miss into a loud boot failure); (b) the HubSpot private-app token needs confirmed product-property WRITE scope; (c) the phase-B quarantine volume is unknown until phase A runs in production, so the operator must sign off on the resulting duplicate-product forecast before step 5 of the rollout (full sync) is enabled.
