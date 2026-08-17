# Deal Product Resolution Specification

## Purpose

Deterministic resolution of a HubSpot deal/quote line item to an Odoo product id, adding a native `hs_product_id` → `product_mapping` tier before the fragile name-based fallback, without changing existing SKU/productId behavior.

## Requirements

### Requirement: Fixed Tier Order, First Match Wins

The system MUST resolve a line item's Odoo product id by evaluating tiers in this fixed order, stopping at the first match: (1) existing `productId`/numeric `hs_sku` path, (2) `hs_product_id` via `product_mapping.findByHubspotId`, (3) `lookupByName`, (4) `SkipSyncError` via `assertProductsResolved`.

#### Scenario: Existing SKU/productId path wins over `hs_product_id`

- GIVEN a line item has both a resolvable numeric `hs_sku`/`productId` AND a `hs_product_id` that would independently match
- WHEN the line item is resolved
- THEN the SKU/productId path resolves it and tier 2 is never evaluated

#### Scenario: `hs_product_id` tier resolves when SKU is absent

- GIVEN a line item has `hs_sku: null` and a populated `hs_product_id`
- WHEN the line item is resolved
- THEN tier 2 resolves the Odoo product id via `product_mapping.findByHubspotId`, and `lookupByName` is never invoked

### Requirement: `hs_product_id` Fetched From HubSpot

The system MUST include `hs_product_id` in `LINE_ITEM_PROPERTIES` so `getDealLineItems` and `getQuoteLineItems` fetch it on every call.

#### Scenario: Line item property set includes `hs_product_id`

- GIVEN a deal or quote line-item fetch is issued
- WHEN properties are requested from HubSpot
- THEN `hs_product_id` is included alongside `hs_sku`, `quantity`, `price`, and `name`

### Requirement: `product_mapping` Lookup by HubSpot Product Id

The system MUST provide `findByHubspotId(hubspotId)` on the product mapping repository, returning the mapped Odoo product id or an absent result if no mapping exists.

#### Scenario: Mapping found returns Odoo id

- GIVEN a `product_mapping` row exists for a given `hubspotId`
- WHEN `findByHubspotId(hubspotId)` is called
- THEN the associated `odooId` is returned

#### Scenario: No mapping row falls through, never guesses

- GIVEN no `product_mapping` row exists for a `hs_product_id`
- WHEN tier 2 is evaluated
- THEN resolution falls through to `lookupByName`, and no Odoo product id is fabricated or guessed

### Requirement: Name Match Remains Last Resort

The system MUST invoke `lookupByName` only after both tier 1 and tier 2 fail to resolve, preserving it as the permanent fallback for manually created line items that carry neither a usable `hs_sku` nor `hs_product_id`.

#### Scenario: Manually created line item resolves by name only

- GIVEN a line item has no `hs_sku`, no `productId`, and no `hs_product_id`
- WHEN resolution runs
- THEN `lookupByName` is the only path attempted before a possible skip

### Requirement: Unresolvable Line Items Skip Loud, Never Silent

The system MUST raise `SkipSyncError` via `assertProductsResolved` when no tier resolves a line item's Odoo product id, and MUST NOT create a sale-order line for an unresolved or guessed product.

#### Scenario: All tiers exhausted raises SkipSyncError

- GIVEN a line item resolves through neither `hs_sku`/`productId`, nor `hs_product_id`/`product_mapping`, nor `lookupByName`
- WHEN `assertProductsResolved` runs
- THEN `SkipSyncError` is raised and no sale-order line is created for that item

#### Scenario: `hs_product_id` present but unmapped still allows skip, not a wrong match

- GIVEN a line item's `hs_product_id` has no matching `product_mapping` row and the name match also fails
- WHEN resolution completes
- THEN `SkipSyncError` is raised rather than resolving to an arbitrary or wrong Odoo product

### Requirement: Retroactive Coverage Depends on Backfill Completeness

The system's `hs_product_id` tier MUST rely on `product_mapping` having a row for every pre-existing HubSpot product (with or without SKU); the tier MUST silently fall through to name matching for any product left unmapped by an incomplete backfill.

#### Scenario: Incomplete backfill causes silent fallback, not an error

- GIVEN a pre-existing HubSpot product was never backfilled into `product_mapping`
- WHEN a line item referencing that product's `hs_product_id` is resolved
- THEN resolution falls through to `lookupByName` exactly as it did before this tier existed, with no explicit warning surfaced by this requirement
