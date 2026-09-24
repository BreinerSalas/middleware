'use strict'

const VALID_ACTIONS = new Set(['created', 'updated', 'linked'])

// (sdd/hubspot-contact-inbound-sync) Records which system originated the mapping so a later
// outbound tick can never flip the origin. Legacy rows (direction: null) count as
// odoo_to_hubspot and are not backfilled — see MongoPartnerMappingRepository.bulkUpsertMany.
const DIRECTIONS = Object.freeze({
  ODOO_TO_HUBSPOT: 'odoo_to_hubspot',
  HUBSPOT_TO_ODOO: 'hubspot_to_odoo'
})

class PartnerMapping {
  constructor(props = {}) {
    this.odooId = props.odooId
    this.odooPartnerId = props.odooPartnerId
    this.hubspotId = props.hubspotId
    this.action = props.action
    this.syncedAt = props.syncedAt
    this.lastSyncedAt = props.lastSyncedAt || props.syncedAt
    this.createdAt = props.createdAt || props.syncedAt
    this.direction = props.direction
  }
}

function buildPartnerMapping({ odooId, hubspotId, action, direction = null, now = () => new Date().toISOString() } = {}) {
  if (odooId == null) throw new Error('buildPartnerMapping requires odooId')
  if (hubspotId == null) throw new Error('buildPartnerMapping requires hubspotId')
  if (!VALID_ACTIONS.has(action)) throw new Error(`buildPartnerMapping invalid action: ${action}`)
  const syncedAt = now()
  const numericOdooId = Number(odooId)
  return {
    odooId: numericOdooId,
    odooPartnerId: String(numericOdooId),
    hubspotId: String(hubspotId),
    action,
    syncedAt,
    lastSyncedAt: syncedAt,
    createdAt: syncedAt,
    direction
  }
}

function recordSyncSuccess({ mapping, action, now = () => new Date().toISOString() } = {}) {
  if (!mapping) throw new Error('recordSyncSuccess requires mapping')
  if (!VALID_ACTIONS.has(action)) throw new Error(`recordSyncSuccess invalid action: ${action}`)
  const syncedAt = now()
  return {
    odooId: mapping.odooId,
    odooPartnerId: mapping.odooPartnerId,
    hubspotId: mapping.hubspotId,
    action,
    syncedAt,
    lastSyncedAt: syncedAt,
    createdAt: mapping.createdAt || syncedAt
  }
}

module.exports = { PartnerMapping, buildPartnerMapping, recordSyncSuccess, VALID_ACTIONS, DIRECTIONS }
