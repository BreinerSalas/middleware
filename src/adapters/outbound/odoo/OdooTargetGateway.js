'use strict'

const { mapDealToManufacturingOrder } = require('./dealToManufacturingOrderMapper')

class OdooTargetGateway {
  constructor({ apiClient, hashPayload, logger = null } = {}) {
    if (!apiClient) throw new Error('OdooTargetGateway requires apiClient')
    if (typeof hashPayload !== 'function') throw new Error('OdooTargetGateway requires hashPayload')
    this.apiClient = apiClient
    this.hashPayload = hashPayload
    this.logger = logger
  }

  async upsert({ existingTargetId = null, record, references = {}, correlationId = null } = {}) {
    if (!record) throw new Error('OdooTargetGateway.upsert requires record')
    const odooCustomerId = (references && references.odooCustomerId) || (record.properties && record.properties.id_cliente_odoo) || null
    const hsLineItems = (references && references.lineItems) || []
    let payload
    try {
      payload = mapDealToManufacturingOrder({
        hsDeal: record,
        odooCustomerId,
        hsLineItems,
        now: new Date()
      })
    } catch (err) {
      if (err.code === 'MISSING_ODOO_CUSTOMER_ID') {
        const t = new Error('Missing Odoo customer reference for HubSpot deal')
        t.transient = true
        t.code = 'MISSING_ODOO_CUSTOMER_ID'
        t.cause = err
        throw t
      }
      throw err
    }

    if (existingTargetId) {
      const result = await this.apiClient.updateManufacturingOrder(existingTargetId, payload)
      if (this.logger) this.logger.info('odoo.upsert.update', { targetId: result.id, correlationId })
      return {
        targetId: result.id,
        targetRef: result.ref || null,
        syncToken: result.state || null,
        raw: result.raw,
        payloadHash: this.hashPayload(payload)
      }
    }
    const result = await this.apiClient.createManufacturingOrder(payload)
    if (this.logger) this.logger.info('odoo.upsert.create', { targetId: result.id, correlationId })
    return {
      targetId: result.id,
      targetRef: result.ref || null,
      syncToken: result.state || null,
      raw: result.raw,
      payloadHash: this.hashPayload(payload)
    }
  }
}

module.exports = { OdooTargetGateway }
