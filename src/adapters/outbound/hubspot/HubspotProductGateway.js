'use strict'

class HubspotProductGateway {
  constructor({ apiClient, logger = null } = {}) {
    if (!apiClient) throw new Error('HubspotProductGateway requires apiClient')
    this.apiClient = apiClient
    this.logger = logger
  }

  hasValidSku(odooProduct) {
    const code = odooProduct && odooProduct.default_code
    return code != null && code !== false && String(code).trim() !== ''
  }

  extractSku(odooProduct) {
    return this.hasValidSku(odooProduct) ? String(odooProduct.default_code).trim() : ''
  }

  buildProperties(odooProduct) {
    const props = {
      name: String(odooProduct.name),
      price: String(odooProduct.list_price ?? 0)
    }
    if (this.hasValidSku(odooProduct)) {
      props.hs_sku = String(odooProduct.default_code).trim()
    }
    return props
  }

  async upsertBySku(odooProduct) {
    if (!odooProduct) return { skipped: true, reason: 'no_product', created: false }
    const name = odooProduct.name == null ? '' : String(odooProduct.name).trim()
    if (!name) return { skipped: true, reason: 'no_name', created: false }
    const hasSku = this.hasValidSku(odooProduct)
    const sku = hasSku ? this.extractSku(odooProduct) : ''
    const properties = this.buildProperties(odooProduct)

    let existing = null
    if (hasSku) {
      try {
        existing = await this.apiClient.searchProductByHsSku(sku)
      } catch (err) {
        if (this.logger) this.logger.warn('hubspot.product.search failed; falling back to create', { sku, error: err.message })
      }
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
