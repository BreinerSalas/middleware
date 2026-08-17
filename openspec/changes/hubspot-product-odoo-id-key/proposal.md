# Proposal: HubSpot Product Identity — `id_producto_odoo` upsert key + `hs_product_id` line-item resolution

> Prior analysis: `openspec/changes/hubspot-product-odoo-id-key/exploration.md`.
> Mode: interactive · Store: hybrid · Delivery: single-pr · Review budget: 800 lines.
> Revision 2: line-item → Odoo product resolution moved from **non-goal** to **in scope** after live portal + Mongo verification.

## Intent

Product sync is keyed end-to-end on Odoo `default_code` (SKU), but **46% of Odoo products have no SKU** (~5,300 of ~11,132). Consequences today: (a) those products are excluded by default (`PRODUCT_SYNC_INCLUDE_NO_SKU=false`) and **never appear in HubSpot**, so sales cannot quote them; (b) if the flag is enabled, `upsertBySku` skips the search and creates a **duplicate HubSpot product on every run** (`docs/todo-sku-sintetico.md` literally forbids running it); (c) `batchUpsertBySkus` silently drops them. A mutable business field is the wrong identity. Odoo's immutable `product.product` id is the right one, and the contact side (`id_contacto_odoo_v2`) already proves the pattern.

**Downstream, this is the real operational pain**: deal → sale-order sync also depends on SKU. Verified live against the production portal — deal `63513953175` → line item `57766337288` ("WALMART QUAD - CON PUSHERS") returns `hs_sku: null`, so `resolveProductIds` falls straight through to the fragile `lookupByName` fuzzy match, and `assertProductsResolved` throws `SkipSyncError` whenever the name does not match or is ambiguous. Orders silently fail to reach Odoo for ~46% of the catalog. That path was a non-goal in the prior revision; it is now **in scope**.

## Scope

### In Scope
- New HubSpot product property `id_producto_odoo` (`hasUniqueValue: true`), declared in a new `productPropertyDefinitions.js` and provisioned via `provisionProperties({ objectType: 'products' })` in `server.js`.
- Switch idempotency key to `id_producto_odoo` in `HubspotProductGateway` (single + batch) and `hubspotApiClient` (product search + `batchUpsertProducts` `idProperty`).
- Rework `productSyncModule.js`: drop the `withSku`/`withoutSku` partition and SKU-echo correlation; correlate batch results by the Odoo id sent as batch `id`; drop the `hsSku`-truthy filter in `persistMappings`.
- **Sync all Odoo products by default** — flip `PRODUCT_SYNC_INCLUDE_NO_SKU` / `--include-no-sku` semantics so no-SKU products are included.
- **New line-item resolution tier** in `OdooTargetGateway.resolveProductIds`, evaluated **before** `lookupByName`:
  1. `productId` present, or numeric `hs_sku` → unchanged (existing `default_code` path).
  2. **NEW** — line item carries `hs_product_id` → `product_mapping.findByHubspotId(hs_product_id)` → mapped `odooId`.
  3. else `lookupByName` — now genuinely last-resort, not the primary no-SKU path.
  4. else `SkipSyncError` via `assertProductsResolved` (unchanged).
- Add `hs_product_id` to `LINE_ITEM_PROPERTIES` in `hubspotApiClient.js` (today `['hs_sku','quantity','price','name']`) so `getDealLineItems`/`getQuoteLineItems` actually fetch it.
- Add `findByHubspotId(hubspotId)` to `MongoProductMappingRepository`, mirroring `findByOdooId`; inject the repository into `OdooTargetGateway` (wired in `dealSyncModule.js`).
- **One-time backfill**, covering BOTH: (a) `id_producto_odoo` onto existing HubSpot products via `product_mapping.hubspotId` (batch upsert by native object id, no search); (b) `product_mapping` rows for **every** existing HubSpot product, with or without SKU, so tier 2 works retroactively for deals referencing products that were never mapped.
- Rewrite the four SKU-asserting test suites (see exploration) plus new coverage in `test/adapters/odoo/OdooTargetGateway.test.js`.

### Out of Scope
- `product_mapping` schema (already `odooId`-unique) and `MongoProductPanelRepository` filters.
- Writing `id_producto_odoo` onto line items or quotes — HubSpot populates `hs_product_id` natively; nothing to write.
- **Rejected, do not re-propose**: synthetic `hs_sku = String(odooId)` (`docs/todo-sku-sintetico.md`, 2026-07-30). Company policy forbids altering customer-visible product data; a synthetic SKU corrupts real customer records. That document is superseded by this change, which reaches the same goal via `hs_product_id` without touching any customer-visible field.

## Capabilities

### New Capabilities
- `product-sync-identity`: HubSpot product identity/idempotency keyed on the Odoo product id, full-catalog coverage, and `hs_sku` demoted to informational data.
- `deal-product-resolution`: deterministic HubSpot line-item → Odoo product resolution ordered `productId` → `hs_sku` → `hs_product_id` via `product_mapping` → name (last resort) → skip. No existing spec covers this; `openspec/specs/` has only `partner-sync`, `tick-job-scheduling`, `core-vendor-neutrality`.

### Modified Capabilities
- None.

## Approach

**Two decoupled mechanisms solving two different problems — do not conflate them.**

1. *Product-level upsert idempotency*: mirror the proven contact pattern. A provisioned, unique `id_producto_odoo` custom property carries the stable Odoo id; the gateway takes `idProperty` by injection; the sync module correlates on the id it sent, not on an echoed business field. This prevents duplicate HubSpot Products on repeat syncs. It is neither used by nor needed for line-item resolution.
2. *Line-item → Odoo resolution*: uses HubSpot's **native** `hs_product_id` on the line item, a documented stable reference to the associated Product's object id, populated automatically whenever a line item is added from the catalog — with or without a SKU (verified live on line item `57766337288`). HubSpot never copies custom Product properties onto line items, so `id_producto_odoo` could never have solved this; `hs_product_id` is the only native vehicle. The middleware translates `hs_product_id` → `odooId` through `product_mapping`.

Mechanism 2 is only as complete as `product_mapping`. Today `productSyncModule.persistMappings` filters out falsy `hsSku` before persisting, and `buildProductMapping` hard-requires `hsSku`, so **no** row exists for no-SKU products — confirmed live: `hubspotId: "46671077999"` has no `product_mapping` row. The backfill is therefore a **hard precondition**, not a nice-to-have: without it tier 2 silently no-ops for pre-existing products and everything still falls through to the fragile name match.

`hs_sku` keeps being written when `default_code` exists (sales/support value) but never participates in matching, search, or `idProperty`. Provisioning **fails loud** if the property cannot be created — no silent fallback to SKU matching (same philosophy as `revertDealStage`). Strict TDD: red tests for id-based upsert, no-SKU inclusion, correlation-by-id, and the `hs_product_id` tier before deleting SKU logic.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/composition/productPropertyDefinitions.js` | New | `buildProductPropertyDefinitions(cfgHubspot)` |
| `src/composition/productSyncModule.js` | Modified | Partition removed; correlation by Odoo id; persist all mappings |
| `src/adapters/outbound/hubspot/HubspotProductGateway.js` | Modified | `hasValidOdooId`/`extractOdooId`; search + batch by `id_producto_odoo` |
| `src/adapters/outbound/hubspot/hubspotApiClient.js` | Modified | Generic product search by property; `idProperty` default; `hs_product_id` in `LINE_ITEM_PROPERTIES` |
| `src/adapters/outbound/odoo/OdooTargetGateway.js` | Modified | New `hs_product_id` tier in `resolveProductIds` before `lookupByName`; repository injected in constructor |
| `src/adapters/outbound/mongo/MongoProductMappingRepository.js` | Modified | New `findByHubspotId(hubspotId)` |
| `src/core/domain/ProductMapping.js` | Modified | `buildProductMapping` must accept a null/absent `hsSku` |
| `src/composition/dealSyncModule.js` | Modified | Wire `productMappingRepository` into the 3 `OdooTargetGateway` construction sites |
| `src/server.js`, `src/config/index.js` | Modified | Products provisioning call; include-all default |
| `scripts/backfill-product-odoo-id.js` | New | Backfill `id_producto_odoo` + `product_mapping` rows for every HubSpot product |
| `scripts/sync-products.js`, `docs/todo-sku-sintetico.md` | Modified | Flag semantics + mark the synthetic-SKU plan superseded/rejected |
| `test/adapters/hubspot/HubspotProductGateway*.test.js`, `test/composition/productSyncModule*.test.js` | Modified | Replace SKU-key assertions |
| `test/adapters/odoo/OdooTargetGateway.test.js` | Modified | Today asserts only SKU/name resolution — add the `hs_product_id` tier and its ordering |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Backfill misses a product → duplicate created on first run | Med | Backfill runs and is verified **before** the new sync path; dry-run count reconciliation |
| Products `groupName` unconfirmed against the live portal | Med | Confirm in design against the real portal; otherwise HubSpot default group |
| `hs_sku` native uniqueness behavior opaque/out of our control | Low | `hs_sku` no longer used for matching; informational only |
| Property provisioning fails at boot | Low | Fail loud, never fall back to SKU matching |
| Catalog volume ~11k jumps from ~5.8k synced | Med | 100-item batches ≈ 110 calls, inside existing `rps:15` limiter |
| Rework of `productSyncModule` correlation is the largest blast radius | High | TDD-first; `--dry-run` parity check before enabling |
| **New `hs_product_id` tier changes the revenue-critical deal → sale-order path** (previously a declared non-goal); a wrong `product_mapping` row now silently creates an order line for the wrong Odoo product | High | Dedicated tests in `test/adapters/odoo/OdooTargetGateway.test.js` covering each tier and its ordering; flag for extra scrutiny in design and review; keep `assertProductsResolved` fail-loud; treat a missing mapping as "fall through", never as a guess |
| Incomplete backfill leaves tier 2 a silent no-op, masking the fix while name matching still fails | High | Backfill completes and is count-reconciled **before** the new resolution path is enabled; assert `product_mapping` row count ≈ HubSpot product count |

## Rollback Plan

Revert the branch commits: SKU-based matching, the SKU-only default return, and the SKU→name-only resolution order. The `id_producto_odoo` property can be left in HubSpot — unused it is inert. Backfilled values and extra `product_mapping` rows are additive and destroy no data; `hs_sku` is never cleared and no customer-visible field is ever written. Only irreversible effect is any product newly created in HubSpot before the revert; those keep valid `product_mapping` rows and are re-matched by SKU where a SKU exists, and are re-detectable by `id_producto_odoo` if the change is re-applied. Sale orders already created through the `hs_product_id` tier stay valid — the resolution path is idempotent per `origin`.

## Dependencies

- HubSpot private-app token needs product-property write scope (verify before apply).
- Backfill must complete before the first full sync run on the new key **and** before the `hs_product_id` resolution tier is relied on in production.
- `hs_product_id` must be present in the fetched line-item properties; without the `LINE_ITEM_PROPERTIES` change, tier 2 never fires.

## Manual Verification

- Boot → `id_producto_odoo` exists in the portal with `hasUniqueValue`.
- Backfill → sample HubSpot products carry the correct Odoo id; `product_mapping` has a row for `hubspotId: "46671077999"` (today it does not).
- Full sync twice → HubSpot product count stable, zero duplicates, no-SKU products present.
- Deal `63513953175` (line item `57766337288`, `hs_sku: null`, `hs_product_id: "46671077999"`) resolves its Odoo product via tier 2, with no name lookup issued.

## Success Criteria

- [ ] No `hs_sku` used as `idProperty` or search key anywhere in `src/`
- [ ] All ~11k Odoo products reach HubSpot by default; repeat runs create zero duplicates
- [ ] Every existing `product_mapping.hubspotId` carries `id_producto_odoo`
- [ ] `product_mapping` rows persist for no-SKU products, from both the backfill and the live sync path
- [ ] A no-SKU line item resolves its Odoo product through `hs_product_id`, and `lookupByName` runs only when neither `hs_sku` nor `hs_product_id` resolves
- [ ] `npm test` green
