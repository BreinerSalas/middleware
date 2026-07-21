'use strict'

const { createEchoGuard } = require('../../../core/shared/echoGuard')

const DEAL_PROPERTIES_TO_FETCH = [
  'dealname',
  'dealstage',
  'amount',
  'closedate',
  'pipeline',
  'id_cliente_odoo',
  'id_orden_odoo'
]

class HubspotSourceGateway {
  constructor({ apiClient, propertyOdooCustomerId, propertyOdooOrderId, echoGuard = null, logger = null } = {}) {
    if (!apiClient) throw new Error('HubspotSourceGateway requires apiClient')
    this.apiClient = apiClient
    this.propertyOdooCustomerId = propertyOdooCustomerId || 'id_cliente_odoo'
    this.propertyOdooOrderId = propertyOdooOrderId || 'id_orden_odoo'
    this.echoGuard = echoGuard || createEchoGuard({ ttlMs: 10000 })
    this.logger = logger
  }

  async fetchRecord(sourceId) {
    const data = await this.apiClient.getDeal(sourceId, DEAL_PROPERTIES_TO_FETCH)
    return {
      id: data.id,
      properties: data.properties || {},
      associations: data.associations || {}
    }
  }

  async resolveReferences(record) {
    const references = {}
    if (!record || !record.id) return references
    try {
      const data = await this.apiClient.getDealAssociations(record.id, ['contact', 'company'])
      references.associations = data && data.results ? data.results : []
    } catch (err) {
      this.logger && this.logger.warn('hubspot.resolveReferences.associations failed', { sourceId: record.id, error: err.message })
      references.associations = []
    }
    try {
      references.lineItems = await this.apiClient.getDealLineItems(record.id)
    } catch (err) {
      this.logger && this.logger.warn('hubspot.resolveReferences.lineItems failed', { sourceId: record.id, error: err.message })
      references.lineItems = []
    }
    return references
  }

  async writeBack(sourceId, payload = {}) {
    if (!payload || typeof payload !== 'object') return
    const properties = {}
    if (payload.id_orden_odoo != null) properties[this.propertyOdooOrderId] = payload.id_orden_odoo
    if (payload.id_cliente_odoo != null) properties[this.propertyOdooCustomerId] = payload.id_cliente_odoo
    if (Object.keys(properties).length === 0) return
    const echoKey = `${sourceId}:${JSON.stringify(properties)}`
    if (this.echoGuard.shouldSuppress(echoKey)) {
      if (this.logger) this.logger.debug('hubspot.writeBack suppressed by echo guard', { sourceId, echoKey })
      return
    }
    await this.apiClient.updateDeal(sourceId, properties)
    if (this.logger) this.logger.info('hubspot.writeBack', { sourceId, properties })
  }
}

module.exports = { HubspotSourceGateway, DEAL_PROPERTIES_TO_FETCH }
