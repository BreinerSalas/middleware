'use strict'

const VALID_ACTIONS = new Set(['created', 'updated'])

class ProductMapping {
  constructor(props = {}) {
    this.odooId = props.odooId
    this.hsSku = props.hsSku
    this.hubspotId = props.hubspotId
    this.action = props.action
    this.syncedAt = props.syncedAt
    this.lastSyncedAt = props.lastSyncedAt || props.syncedAt
    this.createdAt = props.createdAt || props.syncedAt
  }
}

function buildProductMapping({ odooId, hsSku, hubspotId, action, now = () => new Date().toISOString() } = {}) {
  if (odooId == null) throw new Error('buildProductMapping requires odooId')
  if (hubspotId == null) throw new Error('buildProductMapping requires hubspotId')
  if (!VALID_ACTIONS.has(action)) throw new Error(`buildProductMapping invalid action: ${action}`)
  // (openspec/hubspot-product-odoo-id-key) hsSku is informational only — never an identity key.
  // Normalize null/absent/false/whitespace to null so no-SKU products can be persisted.
  const normalizedHsSku = (hsSku == null || hsSku === false || String(hsSku).trim() === '')
    ? null
    : String(hsSku)
  const syncedAt = now()
  return {
    odooId: Number(odooId),
    hsSku: normalizedHsSku,
    hubspotId: String(hubspotId),
    action,
    syncedAt,
    lastSyncedAt: syncedAt,
    createdAt: syncedAt
  }
}

function recordSyncSuccess({ mapping, action, now = () => new Date().toISOString() } = {}) {
  if (!mapping) throw new Error('recordSyncSuccess requires mapping')
  if (!VALID_ACTIONS.has(action)) throw new Error(`recordSyncSuccess invalid action: ${action}`)
  const syncedAt = now()
  return {
    odooId: mapping.odooId,
    hsSku: mapping.hsSku,
    hubspotId: mapping.hubspotId,
    action,
    syncedAt,
    lastSyncedAt: syncedAt,
    createdAt: mapping.createdAt || syncedAt
  }
}

module.exports = { ProductMapping, buildProductMapping, recordSyncSuccess, VALID_ACTIONS }
