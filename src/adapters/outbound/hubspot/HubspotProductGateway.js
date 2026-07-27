'use strict'

class HubspotProductGateway {
  constructor({ apiClient, logger = null } = {}) {
    if (!apiClient) throw new Error('HubspotProductGateway requires apiClient')
    this.apiClient = apiClient
    this.logger = logger
  }

  buildProperties(odooProduct) {
    return {
      hs_sku: String(odooProduct.default_code),
      name: String(odooProduct.name),
      price: String(odooProduct.list_price ?? 0)
    }
  }

  async upsertBySku(odooProduct) {
    const sku = odooProduct && odooProduct.default_code != null ? String(odooProduct.default_code).trim() : ''
    if (!sku) return { skipped: true, reason: 'no_sku', created: false }
    const name = odooProduct.name == null ? '' : String(odooProduct.name).trim()
    if (!name) throw new Error('product.name is required (HubSpot rejects empty)')

    const properties = this.buildProperties(odooProduct)

    let existing = null
    try {
      existing = await this.apiClient.searchProductByHsSku(sku)
    } catch (err) {
      if (this.logger) this.logger.warn('hubspot.product.search failed; falling back to create', { sku, error: err.message })
    }
    if (existing && existing.id) {
      const data = await this.apiClient.updateProduct(existing.id, properties)
      return { ...data, created: false }
    }
    const data = await this.apiClient.createProduct(properties)
    return { ...data, created: true }
  }
}

module.exports = { HubspotProductGateway }
