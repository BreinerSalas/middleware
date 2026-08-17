# Product Sync Identity Specification

## Purpose

HubSpot product upsert identity keyed on the immutable Odoo `product.product` id (`id_producto_odoo`), covering the full Odoo catalog regardless of SKU presence. `hs_sku` becomes informational only, never a matching key.

## Requirements

### Requirement: Provisioned Unique Odoo-ID Property

The system MUST provision a HubSpot product property `id_producto_odoo` with `hasUniqueValue: true` via `provisionProperties({ objectType: 'products' })`, and MUST fail loud at boot if provisioning fails, with no fallback to SKU-based matching.

#### Scenario: Property provisioned successfully at boot

- GIVEN `id_producto_odoo` does not yet exist in the HubSpot portal
- WHEN the service starts
- THEN the property is created with `hasUniqueValue: true` before the flow reports ready

#### Scenario: Provisioning failure halts boot instead of degrading

- GIVEN HubSpot rejects property creation for `id_producto_odoo`
- WHEN the service starts
- THEN boot fails loud and the system MUST NOT fall back to `hs_sku` as the idempotency key

### Requirement: Idempotent Upsert Keyed on Odoo Product ID

The system MUST use `id_producto_odoo` as the sole `idProperty` for HubSpot product search, single upsert, and batch upsert (`batchUpsertProducts`), correlating batch results by the Odoo id sent as the batch item id rather than any echoed business field.

#### Scenario: Repeat sync updates, never duplicates

- GIVEN a product already mapped via `id_producto_odoo`
- WHEN it is synced again
- THEN the existing HubSpot product is updated, not duplicated

#### Scenario: Batch result correlates by sent Odoo id

- GIVEN a batch upsert request keyed by Odoo product ids
- WHEN HubSpot returns batch results
- THEN each result is correlated back to its source product by the Odoo id sent, not by SKU echo

### Requirement: Full Catalog Sync Regardless of SKU

The system MUST sync all eligible Odoo products by default, including those with no `default_code`, and MUST NOT partition or filter products by SKU presence before upsert or mapping persistence.

#### Scenario: No-SKU product is synced and mapped

- GIVEN an Odoo product with no `default_code`
- WHEN the sync flow runs with default settings
- THEN the product is upserted into HubSpot and a `product_mapping` row is persisted for it

#### Scenario: Legacy exclusion flag no longer suppresses no-SKU products

- GIVEN the sync flow runs with default configuration
- WHEN products are selected for sync
- THEN no-SKU products are included by default, not excluded

### Requirement: `hs_sku` Is Write-Only and Informational

The system MUST write `hs_sku` when `default_code` exists, but MUST NOT use `hs_sku` for search, `idProperty`, or any product-matching logic.

#### Scenario: `hs_sku` present but unused for matching

- GIVEN a product has both `id_producto_odoo` and a non-null `hs_sku`
- WHEN the product is searched or upserted
- THEN matching occurs solely via `id_producto_odoo`, and `hs_sku` is written but never read for identity

### Requirement: Idempotent Backfill of Existing Products

The system MUST provide a backfill that (a) writes `id_producto_odoo` onto every existing HubSpot product mapped via `product_mapping.hubspotId`, and (b) is safe to run repeatedly and during normal business hours, using upsert semantics with no duplicate side effects on repeat runs.

#### Scenario: Backfill re-run is a no-op for already-backfilled products

- GIVEN a HubSpot product already carries the correct `id_producto_odoo`
- WHEN the backfill script runs again
- THEN no duplicate write or side effect occurs for that product

#### Scenario: Backfill completes before full-catalog sync relies on it

- GIVEN the backfill has not yet run
- WHEN the full sync with `id_producto_odoo` as the key is enabled
- THEN existing products risk duplication until the backfill completes and its counts are reconciled against `product_mapping`

### Requirement: Domain Factory Accepts Absent SKU

The system MUST allow `buildProductMapping` to construct a valid `ProductMapping` when `hsSku` is null or absent, so no-SKU product mappings can be constructed and persisted.

#### Scenario: Mapping constructed with no SKU

- GIVEN a product with no `default_code` and therefore no `hsSku`
- WHEN `buildProductMapping` is called with a null `hsSku`
- THEN a valid `ProductMapping` is returned instead of throwing
