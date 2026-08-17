# Verify Report: hubspot-product-odoo-id-key

**Mode**: full artifacts (proposal, 2 specs, design, tasks) · **Store**: hybrid (OpenSpec + Engram)
**Strict TDD**: active · **Test runner**: Vitest (`npm test`, `npm run test:coverage`)
**Verdict**: **PASS WITH WARNINGS** (1 CRITICAL, 4 WARNING, 2 SUGGESTION)

This change is fully implemented across all 3 PR slices (PR 1a: Fases 1–2, PR 1b: Fases 4–5, PR 2: Fase 3), uncommitted, working tree only. All 35 tasks in `tasks.md` are checked `[x]`.

## Completeness (tasks.md)

| Fase | Tasks | Status |
|---|---|---|
| 1 — Property provisioning | 1.1–1.6 (6) | ✅ complete, matches code |
| 2 — Product sync identity | 2.1–2.18 (18) | ✅ complete, matches code |
| 3 — Deal product resolution | 3.1–3.6 (6) | ✅ complete, matches code |
| 4 — Backfill | 4.1–4.4 (4) | ✅ complete, **but see CRITICAL-1** |
| 5 — Docs | 5.1 (1) | ✅ complete, matches code |

**35/35 tasks checked, all independently spot-checked against actual source, not just trusted from the report.**

## Test Execution Evidence

- `npm test` run 1: **2 failures** in `test/e2e/full-flow.test.js` (unrelated file, zero diff — `git diff --stat HEAD -- test/e2e/full-flow.test.js` is empty). `expected 'PROCESSING' to be 'COMPLETED'` and an empty-array assertion — both symptomatic of async/poll timing under full-suite CPU contention.
- Isolated re-run of `test/e2e/full-flow.test.js` alone: **4/4 pass**.
- `npm test` run 2 (full suite): **99/99 files, 1062/1062 tests pass**.
- `npm test` run 3 (via `test:coverage`): **99/99 files, 1062/1062 tests pass**.
- Conclusion: pre-existing flaky e2e test, not a regression from this change (file untouched, fails only under load, passes reliably otherwise). Flagged as WARNING, not CRITICAL — see WARNING-2.

## Coverage (aggregate + changed files)

Aggregate (`npm run test:coverage`): **95.27% lines / 79.22% branches / 91.1% funcs / 95.27% statements** — comfortably clears the 80/70/70/80 project thresholds; command exits 0, no threshold failure.

Per-file (json-summary), for files touched by this change:

| File | Lines | Branches | Funcs | Stmts | Note |
|---|---|---|---|---|---|
| `HubspotProductGateway.js` | 92.14 | 70.11 | 90 | 92.14 | branch just above 70; uncovered branches are error-classification paths (`isInvalidPropertyValueError`, batch-fallback error branches), not the new odoo-id key logic |
| `hubspotApiClient.js` | 96.81 | 70.52 | 93.1 | 96.81 | uncovered branches are pre-existing error-normalization paths |
| `MongoProductMappingRepository.js` | 98 | **65.21** | 72.72 | 98 | below 70% branch **per file** — verified via html report: every uncovered branch is in pre-existing `upsert`/`bulkUpsertMany`/`clear`/`toDate`; the NEW `findByHubspotId` (lines 68–73) is **fully covered**, all 3 short-circuit branches exercised |
| `productMapping.schema.js` | 100 | 100 | 100 | 100 | ✅ |
| `OdooTargetGateway.js` | 95.63 | 81.46 | 100 | 95.63 | ✅ |
| `dealSyncModule.js` | 100 | 94.11 | 100 | 100 | ✅ |
| `productSyncModule.js` | 90.88 | 76.97 | 80 | 90.88 | ✅ |
| `productPropertyDefinitions.js` | 100 | 100 | 100 | 100 | ✅ |
| `productsProvisioningGate.js` | 100 | 100 | 100 | 100 | ✅ |
| `ProductMapping.js` | 100 | 82.35 | 80 | 100 | ✅ |
| `server.js`, `config/index.js`, ports | — | — | — | — | excluded from coverage by `vitest.config.js` (pre-existing exclude list); `server.js`'s D7 gate call is exercised by `test/composition/serverBoot.provisioning.test.js` (4 tests, passing) but not measured |
| `scripts/*.js` | — | — | — | — | `scripts/**` not in coverage `include`; tested via `test/scripts/*.test.js` but not measured |

The only per-file miss (branches < 70%) is `MongoProductMappingRepository.js`, and it is a pre-existing gap unrelated to the new code path added by this change — see WARNING-3.

## Assertion Quality Audit (Strict TDD, Step 5f)

`test/adapters/odoo/OdooTargetGateway.productResolution.test.js` (the revenue-critical NEW file, 7 cases) — read in full: **zero trivial assertions**. Every test drives real production code (`resolveProductIds`, `assertProductsResolved`, `upsert`), asserts distinct expected values (42, 99, 7, `SkipSyncError` detail shape, `TransientSyncError`, UoM `7`), uses spies to prove tiers are *not* invoked when they shouldn't be (real negative-space assertions, not tautologies), and one case runs a full `gw.upsert(...)` to prove `createSalesOrder`/`updateSalesOrder` are never called on repo failure. **Assertion quality: ✅ all assertions verify real behavior.**

`test/scripts/backfillProductOdooId.test.js` (4.1–4.3, 6 cases) — read in full: real assertions on `written`, `promoted`, `quarantined`, exact `batchUpsertProducts` call args and chunk sizes. No tautologies. **However**, see CRITICAL-1: this test's own mock strategy (treating sequential `api.searchProducts` calls as alternating "Odoo lookup" / "HubSpot lookup") papers over a real defect in the script under test, which passes only one API client (HubSpot's) to `runBackfill` — there is no actual Odoo-side lookup to alternate with in production.

## Spec Conformance

### `product-sync-identity` (6 requirements, 10 scenarios)

| Requirement / Scenario | Verdict |
|---|---|
| Provisioned Unique Odoo-ID Property (2 scenarios) | ✅ `runProductsProvisioningGate` throws on any `status:'failed'` entry (D7); `server.js:62` calls it before boot completes; `test/composition/serverBoot.provisioning.test.js` (4 tests) covers both paths |
| Idempotent Upsert Keyed on Odoo Product ID (2 scenarios) | ✅ `id_producto_odoo` is the sole `idProperty` default in `batchUpsertProducts`/`searchProductByOdooId`; correlation by sent Odoo id with echo-first + index-fallback in `productSyncModule.runBatchForOdooItems`, confirmed by direct read |
| Full Catalog Sync Regardless of SKU (2 scenarios) | ✅ `productSync.includeNoSku` defaults `true` (`config/index.js:148`); `runOnce`/`runIncremental` default `includeNoSku:true`; no SKU partition anywhere in `productSyncModule.js` (confirmed by direct read, `partition` step fully removed) |
| `hs_sku` Is Write-Only and Informational (1 scenario) | ✅ grep confirms zero remaining `searchProductByHsSku` in `src/`; every remaining `hs_sku` reference is either (a) the pre-existing numeric-SKU-as-productId tier-1 fast path (unchanged, spec-sanctioned), or (b) write-only in `buildProperties` |
| Idempotent Backfill of Existing Products (2 scenarios) | ⚠️ Phase A (authoritative) is correctly idempotent and upsert-safe. Phase B (quarantine/promote) has a real defect — see **CRITICAL-1** |
| Domain Factory Accepts Absent SKU (1 scenario) | ✅ `buildProductMapping` normalizes null/undefined/`false`/whitespace `hsSku` to `null`; only `odooId`/`hubspotId`/`action` still throw |

### `deal-product-resolution` (6 requirements, 9 scenarios)

| Requirement / Scenario | Verdict |
|---|---|
| Fixed Tier Order, First Match Wins (2 scenarios) | ✅ `resolveProductIds` is exactly T1 (`lookupByDefaultCode`/`applySkuMatch`) → T2 (`lookupByHubspotProductId`/`applyProductMappingMatch`) → T3 (`lookupByName`/`applyNameMatch`), byte-identical to design's interface contract; confirmed by direct read of `OdooTargetGateway.js:533-544` |
| `hs_product_id` Fetched From HubSpot (1 scenario) | ✅ `LINE_ITEM_PROPERTIES` includes `'hs_product_id'`; `getLineItemsFor` maps `hs_product_id: (li.properties && li.properties.hs_product_id) || null` |
| `product_mapping` Lookup by HubSpot Product Id (2 scenarios) | ✅ `findByHubspotId` hit/miss both covered; null/empty/`'null'` short-circuits before querying Mongo (verified: uncovered-branch scan shows this exact method is fully exercised) |
| Name Match Remains Last Resort (1 scenario) | ✅ `applyProductMappingMatch` only sets `productId` when unresolved on entry; T3 only runs on the tier-2 output, unchanged behavior otherwise |
| Unresolvable Line Items Skip Loud (2 scenarios) | ✅ `assertProductsResolved`/`collectUnresolvedLines`/`describeUnresolved` all extended with `hsProductId`; `SkipSyncError` raised, `detail.unresolved[*].hsProductId` present |
| Retroactive Coverage Depends on Backfill Completeness (1 scenario) | ✅ `lookupByHubspotProductId` self-disables (`{}`) when repo absent or `findByHubspotId` is not a function (D4); falls through silently to T3, no error surfaced — matches spec exactly |

## Design Conformance (D1–D7)

| Decision | Verdict |
|---|---|
| D1 — `hs_product_id` native, no custom line-item property | ✅ no write to any line-item property attempted anywhere in the diff |
| D2 — Fixed tier order, decreasing authority | ✅ confirmed above |
| D3 — Two decoupled mechanisms | ✅ `id_producto_odoo` (identity) and `hs_product_id`→mapping (resolution) never read each other at runtime; only shared data is `product_mapping` rows |
| D4 — Optional repo, self-disable | ✅ ctor accepts `productMappingRepository = null`; `lookupByHubspotProductId` returns `{}` when absent; `test/…productResolution.test.js` case "repo absent" proves byte-identical pre-change behavior |
| D5 — Repo throw → `TransientSyncError` | ✅ confirmed by direct read (`OdooTargetGateway.js:606-618`) and by the "repo throws" test case, including the end-to-end assertion that `createSalesOrder`/`updateSalesOrder` are never reached |
| D6 — Quarantine heuristic rows, never blindly promote | ⚠️ **Partially implemented — see CRITICAL-1.** The "never blindly trust `backfill-product-no-sku.js` rows" half is correct (heuristic rows are segregated by `lastAction` and never auto-written). The "unique match against BOTH Odoo AND HubSpot" half is **not actually implemented** — the promotion check queries the same HubSpot API client twice, never Odoo |
| D7 — Fail-loud provisioning gate in `server.js`, isolated from other objects | ✅ `productsProvisioningGate.js` throws only on the products summary; deals/quotes/contacts provisioning untouched (still warn-only, out of scope by design) |

## CRITICAL

**CRITICAL-1 — Backfill Phase B (quarantine) never actually checks Odoo-side name uniqueness; it checks HubSpot uniqueness twice.**

`scripts/backfill-product-odoo-id.js` lines 81–95: `runBackfill` receives a single `api` parameter (in production, `main()` constructs only `createHubspotApiClient(...)` — no Odoo API client is ever wired in). The Phase B promotion logic calls:
```js
const odooResp = await api.searchProducts({ filterGroups: [...], properties: ['name'], limit: 5 })
odooMatches = (odooResp && odooResp.total) || 0
const hubResp = await api.searchProducts({ filterGroups: [...], properties: ['name'], limit: 5 })  // SAME method, SAME params
hubspotMatches = ((hubResp && hubResp.results) || []).length
```
Both calls hit `hubspotApiClient.searchProducts` (the only `searchProducts` defined anywhere in `src/` — confirmed by grep; there is no equivalent Odoo product-name-search wired into this script). In production this means `odooMatches` and `hubspotMatches` are computed from two identical HubSpot queries — the "matches exactly one Odoo product AND one HubSpot product" safety property from design D6 and tasks.md 4.4 is a tautology: it can never detect the exact failure mode D6 exists to prevent (an Odoo-side name collision between two different Odoo products, one of which happens to have a uniquely-named HubSpot counterpart). `test/scripts/backfillProductOdooId.test.js` masks this by mocking `api.searchProducts` with a call-index counter that treats the 1st/3rd calls as "the Odoo lookup" and the 2nd/4th as "the HubSpot lookup" — a test-only fiction; the production code has no such distinction because it only ever has one client.

This directly affects the revenue-critical path this design was built to protect (D6's own rationale: "a visible duplicate product is recoverable; a silent wrong order is not"). Recommend before archiving: either wire a real Odoo product-name lookup into `runBackfill` (e.g. via `odooApiClient.searchProductsByName` or equivalent, if one exists) and re-derive `odooMatches` from that, or reduce the promotion rule to what is actually implemented (HubSpot-uniqueness only) and update design.md/tasks.md to reflect the weaker — but honestly stated — guarantee, with an explicit operator sign-off given the revenue exposure.

## WARNING

**WARNING-1**: (see CRITICAL-1) not double-counted here.

**WARNING-2 — Pre-existing e2e flakiness in `test/e2e/full-flow.test.js`, not caused by this change.** First `npm test` run showed 2 failures under full-suite load; isolated run and two subsequent full-suite runs were 100% green. File has zero diff. Timing-sensitive (poll-based job status assertions). Not a blocker for this change, but worth a follow-up ticket independent of this SDD change.

**WARNING-3 — `MongoProductMappingRepository.js` branch coverage (65.21%) is below the project's 70% branch bar when measured per-file** (project only enforces the aggregate, which passes). Confirmed via html coverage report that every uncovered branch is in pre-existing methods (`upsert`, `bulkUpsertMany`, `clear`, `toDate`) — the new `findByHubspotId` method added by this change is 100% branch-covered. Not a regression, but the file was already below-bar before this change and this change did not improve it.

**WARNING-4 — `apply-progress` Engram topic for this change only reflects Fase 3 (PR 2).** The topic key `sdd/hubspot-product-odoo-id-key/apply-progress` was upserted (not appended) across two separate `sdd-apply` runs; retrieving it now returns only the batch-2 (Fase 3) content, with the batch-1 (Fases 1,2,4,5) TDD Cycle Evidence table no longer independently retrievable from Engram. This verify report compensated by directly reading and cross-checking the actual source/test files for Fases 1, 2, 4, 5 rather than relying on a structured per-task RED/GREEN table, but the Strict TDD "TDD Cycle Evidence" cross-reference (Step 5a) could only be performed at full fidelity for Fase 3.

## SUGGESTION

**SUGGESTION-1**: `scripts/backfill-product-odoo-id.js`'s local `normalizeName()` duplicates `src/adapters/outbound/odoo/productNameKey.js`'s `normalizeProductName()` (identical trim/collapse-whitespace/lowercase logic). Reuse the shared util to keep one source of truth for the name-matching key used across the codebase (the comment in `productNameKey.js` itself warns "have to use it on both sides… or a difference falls silently").

**SUGGESTION-2**: Once CRITICAL-1 is resolved, add a dedicated test case where the Odoo-side name search returns >1 match while the HubSpot-side returns exactly 1, to prove the fixed logic actually rejects that case (the current test suite cannot express this scenario because both "sides" are the same mock in production).

## Regression / Isolation Check

`git diff --stat` (tracked files only, excluding `openspec/`, `.atl/`, `.codegraph/`): 26 files changed, 938 insertions(+), 676 deletions(-) — all within `productSync*`, `HubspotProductGateway`, `hubspotApiClient` (product+line-item surface only), `OdooTargetGateway`, `MongoProductMappingRepository`, `ProductMapping`, `dealSyncModule` (+6 lines, the single wiring site), `config/index.js`, `server.js`, `scripts/sync-products.js`, `docs/todo-sku-sintetico.md`. No unrelated sync module (partner sync, quote sync, manufacturing-order sync) shows any diff. Isolation confirmed clean.

## CRITICAL-1 Resolution (post-verify fix)

Fixed directly by the orchestrator (not delegated), TDD RED→GREEN:

- `runBackfill` now takes separate `hubspotApi` and `odooApi` clients instead of one `api` used twice. Phase B calls `odooApi.searchProductIdsByNames([name])` (the same Odoo-side name-search already used by `OdooTargetGateway.lookupByName`) to get a real Odoo-side match count, and keeps `hubspotApi.searchProducts` for the HubSpot-side count — the two systems are now genuinely queried independently.
- Fixed a related defect found while fixing CRITICAL-1: the name was read from `row.odooName`, a field that does not exist on `productMapping.schema.js` (only `metadata` is a Mixed bag). Production rows would have hit the `no_name` quarantine path unconditionally. Now reads `row.metadata.name` (with `row.odooName` kept as a fallback for flexibility), matching what `scripts/backfill-product-no-sku.js` actually persists.
- `normalizeName` now delegates to the shared `productNameKey.normalizeProductName` (SUGGESTION-1 applied) instead of duplicating the trim/lowercase/collapse-whitespace logic.
- Added a new RED→GREEN regression test (`test/scripts/backfillProductOdooId.test.js`, case: "does NOT promote when the name is ambiguous in Odoo even though HubSpot has exactly one match") — this is exactly SUGGESTION-2, and it is the scenario the original bug could never have caught since production only ever had one client to query twice.
- `main()` now constructs and wires a real `createOdooApiClient(...)` alongside the HubSpot client.

Verified independently: `npx vitest run test/scripts/backfillProductOdooId.test.js` → RED (8/8 failing on the old `{ api, mappingRepo }` signature) → GREEN (8/8 passing) after the fix. Full suite: `npm test` → 99 files, 1063 tests passing (1062 + 1 new regression case), no regressions.

D6 is now fully conformant: promotion requires a unique name match against **both** Odoo and HubSpot, checked via two genuinely distinct clients.

## Carried-Forward Operational Risks (not verify failures, per design.md Open Questions)

- `groupName: 'productinformation'` is unverified against the live HubSpot portal — will surface as a loud boot failure (D7) if the group doesn't exist, not a silent degrade.
- Private-app token product-property WRITE scope is unverified against the live portal.
- Phase-B quarantine volume is unknown until Phase A runs in production — compounded by CRITICAL-1: until that is fixed, any Phase B promotion should be treated as HubSpot-uniqueness-only, and an operator should manually sanity-check the quarantine/promoted split before relying on it in production.
