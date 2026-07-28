'use strict'

const { mapDealToManufacturingOrder } = require('./dealToManufacturingOrderMapper')

class OdooTargetGateway {
  constructor({ apiClient, hashPayload, logger = null, defaultCustomerId = '' } = {}) {
    if (!apiClient) throw new Error('OdooTargetGateway requires apiClient')
    if (typeof hashPayload !== 'function') throw new Error('OdooTargetGateway requires hashPayload')
    this.apiClient = apiClient
    this.hashPayload = hashPayload
    this.logger = logger
    this.defaultCustomerId = defaultCustomerId ? String(defaultCustomerId) : ''
  }

  async upsert({ existingTargetId = null, record, references = {}, correlationId = null } = {}) {
    if (!record) throw new Error('OdooTargetGateway.upsert requires record')
    const odooCustomerId =
      (references && references.odooCustomerId) ||
      (record.properties && record.properties.id_cliente_odoo) ||
      this.defaultCustomerId ||
      null
    const hsLineItems = (references && references.lineItems) || []

    const enrichedLineItems = await this.resolveProductIds(hsLineItems, correlationId)

    let payload
    try {
      payload = mapDealToManufacturingOrder({
        hsDeal: record,
        odooCustomerId,
        hsLineItems: enrichedLineItems,
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

    const salesOrderId = await this.resolveSalesOrderId({ record, payload, correlationId })
    const moPayload = { ...payload.manufacturingOrder }

    let moResult
    if (existingTargetId) {
      moResult = await this.apiClient.updateManufacturingOrder(existingTargetId, moPayload)
      if (this.logger) this.logger.info('odoo.upsert.update', { targetId: moResult.id, salesOrderId, correlationId })
    } else {
      moResult = await this.apiClient.createManufacturingOrder(moPayload)
      if (this.logger) this.logger.info('odoo.upsert.create', { targetId: moResult.id, salesOrderId, correlationId })
    }

    return {
      targetId: moResult.id,
      targetRef: moResult.ref || null,
      syncToken: moResult.state || null,
      raw: moResult.raw,
      payloadHash: this.hashPayload({ saleOrder: payload.saleOrder, manufacturingOrder: moPayload }),
      salesOrderId: String(salesOrderId)
    }
  }

  async resolveProductIds(lineItems, correlationId) {
    if (!Array.isArray(lineItems) || lineItems.length === 0) return []
    const needsLookup = []
    const seen = new Set()
    for (const li of lineItems) {
      const sku = li && li.hs_sku != null ? String(li.hs_sku) : ''
      const numeric = /^\d+$/.test(sku)
      const hasProductId = li && li.productId != null
      if (!hasProductId && !numeric && sku && !seen.has(sku)) {
        seen.add(sku)
        needsLookup.push(sku)
      }
    }
    if (needsLookup.length === 0) return lineItems
    let map = {}
    try {
      map = await this.apiClient.searchProductIdsByDefaultCodes(needsLookup) || {}
    } catch (err) {
      if (this.logger) this.logger.warn('odoo.upsert.lookupProducts failed', { error: err.message, correlationId })
      return lineItems
    }
    return lineItems.map((li) => {
      const sku = li && li.hs_sku != null ? String(li.hs_sku) : null
      const resolved = sku && map[sku] != null ? map[sku] : null
      let productId = null
      if (resolved != null) {
        productId = typeof resolved === 'object' && resolved !== null ? resolved.id : resolved
        if (productId != null) productId = Number(productId)
      }
      return productId != null ? { ...li, productId } : li
    })
  }

  async resolveSalesOrderId({ record, payload, correlationId }) {
    let salesOrderId = null
    try {
      const found = await this.apiClient.searchSalesOrderByOrigin(payload.saleOrder.origin)
      if (Array.isArray(found) && found.length > 0) salesOrderId = String(found[0])
    } catch (err) {
      if (this.logger) this.logger.warn('odoo.upsert.searchSalesOrder failed', { error: err.message, correlationId })
    }
    if (salesOrderId) {
      await this.apiClient.updateSalesOrder(salesOrderId, payload.saleOrder)
      if (this.logger) this.logger.info('odoo.upsert.salesOrder.update', { salesOrderId, correlationId })
      return salesOrderId
    }
    const soResult = await this.apiClient.createSalesOrder(payload.saleOrder)
    if (this.logger) this.logger.info('odoo.upsert.salesOrder.create', { salesOrderId: soResult.id, correlationId })
    return soResult.id
  }
}

module.exports = { OdooTargetGateway }
