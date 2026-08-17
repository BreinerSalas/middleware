'use strict'

/**
 * Port: ProductMappingRepositoryPort
 *
 * Persistent mapping between Odoo product.product.id and HubSpot product ids. Used by the
 * deal → sale-order line-item resolution path (openspec/hubspot-product-odoo-id-key deal-product-
 * resolution capability, PR 2 — Fase 3) to translate `hs_product_id` → `odooId`.
 *
 * NOTE: this port is in `src/core/application/ports/`, which is excluded from coverage. It is a
 * contract-only typedef; runtime behavior is exercised against the concrete adapter
 * `MongoProductMappingRepository` in `test/adapters/mongo/MongoProductMappingRepository.test.js`.
 */

/**
 * @typedef {Object} ProductMappingDoc
 * @property {number} odooId
 * @property {string|null} hsSku
 * @property {string|null} hubspotId
 * @property {'created'|'updated'|'backfilled'|'attempted'|'no_sku_no_match'} lastAction
 * @property {Date} lastSyncedAt
 * @property {Date} firstSyncedAt
 * @property {Object} metadata
 */

/**
 * @typedef {Object} ProductMappingRepositoryPort
 * @property {(odooId: number|string) => Promise<ProductMappingDoc|null>} findByOdooId
 * @property {(hubspotId: string) => Promise<{odooId: number}|null>} findByHubspotId
 * @property {({ items: Array<{odooId:number, hsSku?:string|null, hubspotId:string, action:string}> }) => Promise<{upsertedCount:number}>} bulkUpsertMany
 * @property {({ odooId:number, hsSku?:string|null, hubspotId:string|null, action:string }) => Promise<ProductMappingDoc>} upsert
 */

module.exports = {
  name: 'ProductMappingRepositoryPort',
  description: 'Persistent mapping odooId ↔ hubspotId for HubSpot products (PR 2 contract; PR 1 publishes it for PR 2 to consume)'
}
