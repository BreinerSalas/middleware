# Exploration: hubspot-product-odoo-id-key

## Problem

46% of Odoo products have no `default_code` (SKU). The entire HubSpot product
sync/matching path is keyed on it, so those products break:

- `src/adapters/outbound/hubspot/HubspotProductGateway.js`:
  - `hasValidSku`/`extractSku` (15-22) read only `default_code`.
  - `upsertBySku` (44-74): when SKU is missing, it skips the HubSpot search
    entirely and always calls `createProduct` — creating a duplicate HubSpot
    product on every sync run.
  - `batchUpsertBySkus` (105-184): when SKU is missing, the product is
    silently dropped (`reason: 'no_sku'`), never synced.
- `src/adapters/outbound/hubspot/hubspotApiClient.js`: `batchUpsertProducts`
  (225-251) and `searchProductByHsSku` (200-211) both idempotize against
  HubSpot using `hs_sku` as the natural key / `idProperty`.
- `scripts/sync-products.js` defaults `--include-no-sku` to OFF (~5848 with
  SKU vs ~11132 total) — no-SKU products aren't even attempted unless the
  flag is passed.

## Existing precedent (contacts)

The contact side already has a complete, working blueprint for a
stable-Odoo-id key, decoupled from any business field:

- `src/composition/contactPropertyDefinitions.js:3-16` declares
  `id_contacto_odoo_v2` with `hasUniqueValue: true`.
- `src/server.js:51-56` wires it via
  `provisionProperties({api, objectType:'contacts', properties, logger})` —
  same call also used for `'deals'`/`'quotes'`; no `objectType:'products'`
  call exists yet.
- `src/composition/provisionProperties.js:3-40` is fully object-type-agnostic
  — adding `'products'` is a drop-in.
- `src/adapters/outbound/hubspot/hubspotApiClient.js:334-345`
  `ensureCustomProperty` (GET 404 → POST create) is the exact declare/create
  mechanism a new product property would reuse.
- `HubspotContactGateway.js` (`hasValidOdooId`/`extractOdooId`,
  `searchContactByProperty(idProperty, odooId)`,
  `batchUpsertContacts({inputs, idProperty})` —
  `hubspotApiClient.js:306-332`) is proven working code for exactly this
  pattern.

## Affected areas

**Must change:**

- `src/adapters/outbound/hubspot/HubspotProductGateway.js` — `hasValidSku`/
  `extractSku` (15-22), `upsertBySku` (44-74), `batchUpsertBySkus`
  (105-184).
- `src/adapters/outbound/hubspot/hubspotApiClient.js` —
  `searchProductByHsSku` (200-211, hardcoded `hs_sku` filter) and
  `batchUpsertProducts` default `idProperty='hs_sku'` (225-251).
- `src/composition/productSyncModule.js` — the deepest coupling:
  `partition()` (41-50) splits `withSku`/`withoutSku` before the gateway is
  even called; `runBatchForOdooItems` (58-148) builds a `skuToOdooIds` map
  and correlates HubSpot batch-upsert results back to source records by
  matching the returned `item.properties.hs_sku` (line 85);
  `persistMappings` (169-186) filters out any result with a falsy `hsSku`
  (line 179) before calling `mappingRepo.bulkUpsertMany` — **no-SKU products
  currently never get a `product_mapping` row from the live sync path**,
  only from the manual `scripts/backfill-product-no-sku.js` name-match. This
  is the single largest redesign surface.
- New `src/composition/productPropertyDefinitions.js` + one new
  `provisionProperties({..., objectType:'products', ...})` call in
  `src/server.js`, mirroring `contactPropertyDefinitions.js`.

**Should stay informational, no change needed:**

- `src/adapters/outbound/odoo/dealToSaleOrderMapper.js:resolveProductId`
  (3-8) and `OdooTargetGateway.lookupByDefaultCode`/`lookupByName`
  (519-558) resolve a HubSpot **line item's** `hs_sku` to an Odoo
  `product_id` for sale-order lines — a decoupled concern with an existing
  name-fallback. No line item carries `id_producto_odoo` today, so this path
  is unaffected.
- `src/adapters/outbound/odoo/odooApiClient.js`
  `searchProductsWithDefaultCode`/`searchProductsAll` (538-549) already
  fetch `id` on every page — no query change needed.
- `src/adapters/outbound/mongo/MongoProductMappingRepository.js` +
  `schemas/productMapping.schema.js` — **already keyed on `odooId`**
  (`{type:Number, required:true, unique:true, index:true}`), with `hsSku`
  merely `{type:String, default:null, index:true}` (non-unique, nullable).
  No schema change needed — strongest existing precedent that Odoo id is
  already canonical.
- `MongoProductPanelRepository.js` — filter already matches
  `odooId`/`hsSku`/`hubspotId`; unaffected.
- `src/core/domain/ProductMapping.js` (`buildProductMapping`) hard-requires
  truthy `hsSku`, but is dead code in the live path —
  `productSyncModule.persistMappings` builds plain objects directly; only
  its own test calls it.

## Backfill approach

`product_mapping` already has `odooId <-> hubspotId` pairs for nearly every
product ever synced (including no-SKU ones via
`scripts/backfill-product-no-sku.js`, `hsSku: null`). Once `id_producto_odoo`
exists, the safest backfill reads `listAll()`/`listPaginated()` and does a
`batchUpsertProducts` pass keyed by the already-known `hubspotId` (native
object id) — no search step needed. Rate limits
(`hubspotApiClient.js:44-58`, `rps:15, burst:20`, observed real limits
`secondly=19, max=190/10s`) comfortably handle ~110 batch calls for ~11k
products at chunk size 100.

## Existing tests asserting SKU-based behavior (will need rewriting)

- `test/adapters/hubspot/HubspotProductGateway.test.js` — explicitly asserts
  "upsertBySku without default_code goes straight to create (no search)"
  (59-69, 110-128) — the current duplicate-creation bug is *tested as
  correct behavior* today.
- `test/adapters/hubspot/HubspotProductGateway.batch.test.js` — asserts
  default `idProperty:'hs_sku'` (42), `no_sku` skip reporting (48-66),
  SKU-based dedup (68-85).
- `test/composition/productSyncModule.persistence.test.js:83-84` and
  siblings — assert persisted mappings carry `hsSku` correlated from batch
  results.
- `test/adapters/odoo/OdooTargetGateway.test.js` — tests the decoupled
  line-item resolution concern; not expected to need changes.

## Architectural soundness assessment

**Confirmed sound.** The exact provisioning mechanism, the exact gateway
pattern, and the Mongo persistence layer (already `odooId`-keyed) all
pre-exist as working precedent from the contact-sync flow.

Complicating factors to resolve in proposal/design (not blockers):

1. `productSyncModule.js`'s SKU-based result correlation is the largest
   rework — must switch to correlating via the `id` field sent in each
   batch input (echoed back by HubSpot), not the returned `hs_sku`.
2. `hs_sku`'s uniqueness enforcement in HubSpot is opaque (it's a native
   property, never provisioned by this codebase) — doesn't block the plan
   since `id_producto_odoo` will explicitly declare `hasUniqueValue: true`.
3. The HubSpot property `groupName` for products (deals/contacts/quotes use
   `dealinformation`/`contactinformation`/`quoteinformation`) needs
   confirming against the live portal schema before implementation.
4. Products whose `default_code` changes later, or get archived
   (`active===false`, already handled in `runIncremental`), are a net
   *robustness improvement* under the new key since Odoo's internal id is
   immutable, unlike SKU.

## Ready for proposal

Yes.
