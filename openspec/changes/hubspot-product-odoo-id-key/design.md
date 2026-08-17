# Design: HubSpot Product Identity — `id_producto_odoo` key + `hs_product_id` resolution

## Technical Approach

Two decoupled mechanisms, one per capability. **(1) Catalog identity**: mirror the proven contact pattern (`contactPropertyDefinitions.js`) — a provisioned unique `id_producto_odoo` becomes the sole `idProperty`; `productSyncModule` drops the SKU partition and correlates batch results by the Odoo id it sent. **(2) Line-item resolution**: a third staged-enrichment tier in `OdooTargetGateway.resolveProductIds` translating HubSpot-native `hs_product_id` → `product_mapping` → `odooId`, inserted between the SKU tier and the name fallback. Neither mechanism reads the other at runtime; (2) only depends on (1)'s *data* (`product_mapping` rows).

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| D1 | Line-item → product reference | HubSpot-native `hs_product_id` | Custom line-item property mirroring `id_producto_odoo` | HubSpot never copies custom Product properties onto line items and populates `hs_product_id` automatically from the catalog. A custom property would need a write on every line item — customer-visible data we are forbidden to touch. |
| D2 | Tier order (SKU → mapping → name) | Fixed, first-match-wins | Mapping-first | Tier 1 is a direct Odoo read (authoritative, no middleware state). Tier 2 depends on `product_mapping` freshness. Tier 3 is fuzzy. Ordering by decreasing authority means a stale mapping can never override a live Odoo `default_code` match. |
| D3 | Two mechanisms, not one | Keep identity and resolution separate | Reuse `id_producto_odoo` for resolution | Technically impossible (D1), and coupling them would make a line-item read depend on catalog-property provisioning. |
| D4 | Repo injection into `OdooTargetGateway` | Optional `productMappingRepository` ctor dep; tier self-disables when absent | Required dep | ~26 existing tests construct the gateway without it; mirrors the existing `typeof this.apiClient.searchProductIdsByNames !== 'function'` guard in `lookupByName`. Absent repo ⇒ pre-change behavior exactly. |
| D5 | Repo error handling | `TransientSyncError` on throw; `null` result falls through | Fall through on error | A Mongo blip must retry, not silently degrade to fuzzy name matching. Consistent with `lookupByDefaultCode`. |
| D6 | Heuristic pre-existing rows | Quarantine, do not promote | Trust rows written by `scripts/backfill-product-no-sku.js` | Those rows were name-matched with `candidates.shift()` on ambiguity (`lastAction: 'backfilled'` / `'no_sku_no_match'`). Promoting one writes a **wrong** `id_producto_odoo` onto a real HubSpot product and later builds a wrong sale-order line. A visible duplicate product is recoverable; a silent wrong order is not. |
| D7 | Fail-loud provisioning | Explicit gate in `server.js` on the products summary | Make `provisionProperties` throw | `provisionProperties` currently swallows per-property errors (`status: 'failed'`) and `server.js:65` only warns. Throwing globally would change deals/quotes/contacts boot behavior out of scope. |

## Data Flow

### Catalog sync (product-sync-identity)

```
OdooProductSource.listAll({includeNoSku:true})   ← no partition
        │  all products (SKU or not)
        ▼
HubspotProductGateway.batchUpsertByOdooIds()
   inputs[] = { id: String(odooProduct.id), properties }   ← id IS the Odoo id
        ▼
hubspotApiClient.batchUpsertProducts({ inputs, idProperty:'id_producto_odoo' })
        │  results[] echo item.properties.id_producto_odoo
        ▼
productSyncModule: correlate by sent Odoo id (Map<odooId, product>)
        ▼
persistMappings → bulkUpsertMany  (no hsSku filter — every product gets a row)
```

### Line-item resolution (deal-product-resolution)

```
ProcessSyncJob   HubspotSourceGateway   OdooTargetGateway   ProductMappingRepo   OdooApiClient
      │                  │                     │                    │                 │
      │─ getLineItems ──▶│                     │                    │                 │
      │                  │ batch/read props:   │                    │                 │
      │                  │ hs_sku, quantity,   │                    │                 │
      │                  │ price, name,        │                    │                 │
      │                  │ **hs_product_id**   │                    │                 │
      │◀── lineItems ────│                     │                    │                 │
      │─ upsert(record, references.lineItems) ─▶│                   │                 │
      │                  │                     │─ T1 lookupByDefaultCode(skus) ──────▶│
      │                  │                     │◀── {sku: odooId} ──────────────────── │
      │                  │                     │  applySkuMatch → staged1             │
      │                  │                     │─ T2 findByHubspotId(hs_product_id) ─▶│ │
      │                  │                     │      (only for unresolved lines)     │ │
      │                  │                     │◀── {hubspotId: odooId} | null ──────── │
      │                  │                     │  applyProductMappingMatch → staged2  │
      │                  │                     │─ T3 lookupByName(unresolved) ───────▶│
      │                  │                     │  applyNameMatch → staged3            │
      │                  │                     │─ resolveProductUoms(staged3) ───────▶│
      │                  │                     │  assertProductsResolved → SkipSyncError if any unresolved
      │◀── sale.order upsert result ───────────│                    │                 │
```

Tier 2 runs only for lines where `resolveProductId(li) == null`, sets `productId` only (UoM is filled downstream by `resolveProductUoms`), and never fabricates an id.

## File Changes

| File | Action | Description |
|---|---|---|
| `src/composition/productPropertyDefinitions.js` | Create | `buildProductPropertyDefinitions(cfgHubspot)` → `[{ name: cfgHubspot.propertyOdooProductId \|\| 'id_producto_odoo', label:'ID Producto Odoo', type:'string', fieldType:'text', groupName:'productinformation', hasUniqueValue:true }]` |
| `src/server.js` | Modify | 4th `provisionProperties({ objectType:'products' })`; **throw** if any products entry has `status:'failed'` (D7) |
| `src/config/index.js` | Modify | `hubspot.propertyOdooProductId`; `productSync.includeNoSku` defaults `true` |
| `src/adapters/outbound/hubspot/hubspotApiClient.js` | Modify | `LINE_ITEM_PROPERTIES` += `hs_product_id`; map it in `getLineItemsFor` return shape (line ~139); `searchProductByOdooId(odooId)` replacing `searchProductByHsSku`; `batchUpsertProducts` default `idProperty:'id_producto_odoo'` and support `idProperty: null` ⇒ omit per-input `idProperty` (native-object-id upsert, needed by the backfill) |
| `src/adapters/outbound/hubspot/HubspotProductGateway.js` | Modify | `hasValidOdooId`/`extractOdooId` replace `hasValidSku`/`extractSku` as the key; `buildProperties` adds `id_producto_odoo`, keeps `hs_sku` written only when `default_code` is real; `upsertByOdooId`, `batchUpsertByOdooIds` (dedupe by Odoo id — impossible to collide; the `no_sku`/`duplicate_sku_in_input` skip paths disappear) |
| `src/composition/productSyncModule.js` | Modify | Delete `partition`; single batch path over all products; correlate by sent Odoo id; `persistMappings` drops the `hsSku`-truthy filter; `runOnce`/`runIncremental` `includeNoSku = true` default |
| `src/core/domain/ProductMapping.js` | Modify | Drop `if (!hsSku) throw`; require `odooId` + `hubspotId` + valid `action`; emit `hsSku: hsSku == null \|\| hsSku === false \|\| String(hsSku).trim() === '' ? null : String(hsSku)` |
| `src/adapters/outbound/mongo/schemas/productMapping.schema.js` | Modify | `hubspotId: { ..., index: true, sparse: true }` — today unindexed, and tier 2 queries it per line item |
| `src/adapters/outbound/mongo/MongoProductMappingRepository.js` | Modify | `findByHubspotId(hubspotId)` — returns `null` for null/empty/`'null'` input **before** querying (pre-existing `no_sku_no_match` rows store `hubspotId: null` and would otherwise match) |
| `src/core/application/ports/ProductMappingRepositoryPort.js` | Create | JSDoc typedef `{ findByHubspotId(id) => Promise<{odooId:number}\|null> }` (ports dir is coverage-excluded) |
| `src/adapters/outbound/odoo/OdooTargetGateway.js` | Modify | Ctor accepts `productMappingRepository = null`; module-level `applyProductMappingMatch(li, map)`; `lookupByHubspotProductId(lineItems, correlationId)`; 3-stage `resolveProductIds`; `collectUnresolvedLines` entry gains `hsProductId` and `describeUnresolved` mentions it |
| `src/composition/dealSyncModule.js` | Modify | Wire `productMappingRepository: new MongoProductMappingRepository()` into the **single** `new OdooTargetGateway` site (line 82) |
| `scripts/backfill-product-odoo-id.js` | Create | Phased, idempotent, `--dry-run` (see Migration) |
| `scripts/sync-products.js`, `docs/todo-sku-sintetico.md` | Modify | `--include-no-sku` becomes `--only-with-sku` opt-out; mark the synthetic-SKU plan superseded/rejected |

## Interfaces / Contracts

```js
// OdooTargetGateway.js — staged enrichment, one stage per tier
async resolveProductIds (lineItems, correlationId) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return []
  const bySku    = await this.lookupByDefaultCode(lineItems, correlationId)
  const staged1  = lineItems.map((li) => applySkuMatch(li, bySku))
  const byHsProd = await this.lookupByHubspotProductId(staged1, correlationId) // T2
  const staged2  = staged1.map((li) => applyProductMappingMatch(li, byHsProd))
  const byName   = await this.lookupByName(staged2, correlationId)
  return staged2.map((li) => applyNameMatch(li, byName))
}

// Returns { [hsProductId]: odooId }. {} when repo absent (D4). Throws TransientSyncError on repo failure (D5).
async lookupByHubspotProductId (lineItems, correlationId) {
  if (!this.productMappingRepository) return {}
  const ids = [...new Set(lineItems
    .filter((li) => li && resolveProductId(li) == null && li.hs_product_id)
    .map((li) => String(li.hs_product_id)))]
  if (ids.length === 0) return {}
  try {
    const rows = await Promise.all(ids.map((id) => this.productMappingRepository.findByHubspotId(id)))
    const map = {}
    rows.forEach((row, i) => { if (row && row.odooId != null) map[ids[i]] = Number(row.odooId) })
    return map
  } catch (err) {
    if (this.logger) this.logger.warn('odoo.upsert.lookupByHubspotProductId failed', { error: err.message, correlationId })
    throw new TransientSyncError('product_mapping lookup by hubspotId failed', { cause: err })
  }
}

// applyProductMappingMatch: pure, mirrors applySkuMatch/applyNameMatch
function applyProductMappingMatch (li, map) {
  if (!li || resolveProductId(li) != null) return li
  const key = li.hs_product_id != null ? String(li.hs_product_id) : null
  const odooId = key ? map[key] : null
  return odooId == null ? li : { ...li, productId: Number(odooId) }
}
```

`buildProductMapping` new contract: requires `odooId`, `hubspotId`, valid `action`; `hsSku` optional → normalized to `null`.

## Testing Strategy

Strict TDD: every row below is RED first. `test/` mirrors `src/`.

| Layer | File | What to test |
|---|---|---|
| Unit (domain) | `test/core/domain/ProductMapping.test.js` (M) | Null/absent/`false` `hsSku` builds a valid mapping; `odooId`/`hubspotId`/`action` still throw |
| Unit (gateway) | `test/adapters/hubspot/HubspotProductGateway.test.js` (M), `.batch.test.js` (M) | Search/upsert keyed on `id_producto_odoo`; no-SKU product is upserted not skipped; `hs_sku` written only when `default_code` real; no `no_sku` skip entries |
| Unit (api client) | `test/adapters/hubspot/hubspotApiClient.*.test.js` (M/N) | `LINE_ITEM_PROPERTIES` contains `hs_product_id` and it reaches the mapped shape; `idProperty` default; `idProperty: null` omits the field |
| Unit (composition) | `test/composition/productSyncModule.test.js`, `.batch.test.js`, `.persistence.test.js`, `.incremental.test.js` (M) | No partition; correlation by sent Odoo id (incl. an item whose `hs_sku` echo is absent/mismatched); mapping persisted for a no-SKU product |
| Unit (repo) | `test/adapters/mongo/MongoProductMappingRepository.test.js` (M/N) | `findByHubspotId` hit/miss; `null`/`''` input returns `null` without querying |
| **Unit (revenue-critical)** | `test/adapters/odoo/OdooTargetGateway.productResolution.test.js` (**NEW**) | **Zero coverage exists today for `resolveProductIds`/`lookupByName`/`assertProductsResolved`.** Required cases: T1 wins over T2 when both would match; T2 resolves when `hs_sku` null and `lookupByName` is *never called*; unmapped `hs_product_id` falls through to T3; all tiers fail ⇒ `SkipSyncError` with `hsProductId` in the detail; repo absent ⇒ byte-identical pre-change behavior; repo throws ⇒ `TransientSyncError`, no order line; UoM still filled after a T2 match |
| Unit (composition wiring) | `test/composition/dealSyncModule.test.js` (M) | Gateway receives a `productMappingRepository` |
| Unit (boot) | `test/composition/provisionProperties.test.js` / server boot test (M) | Products provisioning failure halts boot, never degrades to SKU matching |
| Unit (script) | `test/scripts/backfillProductOdooId.test.js` (**NEW**) | Re-run is a no-op; heuristic rows quarantined, never promoted; `--dry-run` issues zero writes |
| Manual/E2E | — | Proposal's Manual Verification list (deal `63513953175` / line item `57766337288`) |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. The backfill is a Node script invoked by an operator; it spawns nothing and takes no shell input.

## Migration / Rollout

Strictly ordered; each step verifiable and re-runnable.

1. **Provision** `id_producto_odoo` (boot or `--provision-only`). Fail loud.
2. **Backfill phase A** — `scripts/backfill-product-odoo-id.js`: read `product_mapping` rows with a non-null `hubspotId` and `lastAction ∈ {created, updated}` (SKU-derived, authoritative); write `id_producto_odoo = odooId` via `batchUpsertProducts({ inputs:[{id:hubspotId, properties:{id_producto_odoo}}], idProperty: null })`, 100/chunk. Idempotent (writing the same value is a no-op update), business-hours safe under the existing `rps:15/burst:20` limiter (~11k ÷ 100 ≈ 110 calls).
3. **Backfill phase B (quarantine)** — rows with `lastAction ∈ {backfilled, no_sku_no_match}` are name-heuristic (D6). Promote **only** when the HubSpot product's `normalizeProductName(name)` uniquely matches exactly one Odoo product and one HubSpot product. Everything else is reported to a quarantine JSON and left unmapped: it will be created fresh by step 4 (a visible duplicate), never silently mis-mapped.
4. **Reconcile** — assert `count(product_mapping with id_producto_odoo written) ≈ HubSpot product count`; dry-run the new sync and diff created-vs-updated before enabling.
5. **Full sync** on the new key; run twice, expect zero net creates on the second run.
6. **Enable tier 2** — steps 1–5 are a hard precondition; before them tier 2 is a silent no-op (spec: *Retroactive Coverage Depends on Backfill Completeness*).

**Rollback**: per proposal. `id_producto_odoo` values and extra `product_mapping` rows are additive and inert once unused; no customer-visible field is ever written or cleared.

## Open Questions

- [ ] `groupName: 'productinformation'` is **unverified** against the live portal — this repo has no products precedent (`contactinformation`/`dealinformation`/`quoteinformation` exist). Confirm before apply; if absent, either create the group or fall back to HubSpot's default product group. `ensureCustomProperty` GET-404-then-POST surfaces this as a create failure, which D7 now turns into a loud boot failure.
- [ ] Phase B quarantine volume is unknown until phase A runs — if a large share of the ~5.3k no-SKU products quarantines, step 4's duplicate forecast needs an explicit operator sign-off before step 5.
- [ ] HubSpot private-app token needs product-property **write** scope (proposal dependency, still unverified).
