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
    try {
      const data = await this.apiClient.createProduct(properties)
      return { ...data, created: true }
    } catch (err) {
      if (this.isDuplicateError(err)) {
        if (this.logger) this.logger.warn('hubspot.product.duplicate', { sku, sourceId: odooProduct.id, error: err.message })
        return { skipped: true, reason: 'duplicate_in_hubspot', created: false }
      }
      throw err
    }
  }

  isDuplicateError(err) {
    if (!err) return false
    const status = err.httpStatus ?? err.status ?? (err.response && err.response.status)
    if (status !== 400 && status !== 409) return false
    const sources = [
      err.message,
      err.response && err.response.data && err.response.data.message,
      err.original && err.original.response && err.original.response.data && err.original.response.data.message
    ].filter(Boolean)
    const msg = sources.join(' ').toLowerCase()
    return msg.includes('already has that value') || msg.includes('propertyvaluecoordinates')
  }
}

module.exports = { HubspotProductGateway }
