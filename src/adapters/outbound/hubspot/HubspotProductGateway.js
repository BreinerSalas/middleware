'use strict'

const async = require('async')

const FALLBACK_CONCURRENCY = 10

class HubspotProductGateway {
  constructor({ apiClient, logger = null, imageUrlBuilder = null, idProperty = 'id_producto_odoo' } = {}) {
    if (!apiClient) throw new Error('HubspotProductGateway requires apiClient')
    this.apiClient = apiClient
    this.logger = logger
    this.imageUrlBuilder = imageUrlBuilder
    this.idProperty = idProperty
  }

  // (openspec/hubspot-product-odoo-id-key) The product-sync identity key is now the Odoo
  // `product.product.id`, NOT `default_code` / `hs_sku`. `hs_sku` is informational only.
  hasValidOdooId(odooProduct) {
    if (!odooProduct) return false
    const id = odooProduct.id
    if (id == null) return false
    if (typeof id === 'number') return Number.isFinite(id)
    const n = Number(id)
    return Number.isFinite(n)
  }

  extractOdooId(odooProduct) {
    return String(odooProduct.id)
  }

  hasValidSku(odooProduct) {
    const code = odooProduct && odooProduct.default_code
    return code != null && code !== false && String(code).trim() !== ''
  }

  extractSku(odooProduct) {
    return this.hasValidSku(odooProduct) ? String(odooProduct.default_code).trim() : ''
  }

  buildProperties(odooProduct) {
    const rawPrice = odooProduct.list_price
    const numPrice = Number(rawPrice)
    const safePrice = (Number.isFinite(numPrice) && numPrice < 0) ? 0 : (rawPrice ?? 0)
    const props = {
      name: String(odooProduct.name),
      price: String(safePrice)
    }
    // id_producto_odoo is the new identity key — always written.
    props.id_producto_odoo = String(odooProduct.id)
    if (this.hasValidSku(odooProduct)) {
      props.hs_sku = String(odooProduct.default_code).trim()
    }
    if (this.imageUrlBuilder) {
      const url = this.imageUrlBuilder(odooProduct)
      if (typeof url === 'string' && url.trim() !== '') {
        props.hs_images = url.trim()
      }
    }
    return props
  }

  async upsertByOdooId(odooProduct) {
    if (!odooProduct) return { skipped: true, reason: 'no_product', created: false }
    if (!this.hasValidOdooId(odooProduct)) {
      return { skipped: true, reason: 'no_id', created: false }
    }
    const name = odooProduct.name == null ? '' : String(odooProduct.name).trim()
    if (!name) return { skipped: true, reason: 'no_name', created: false }

    const odooId = this.extractOdooId(odooProduct)
    const properties = this.buildProperties(odooProduct)

    let existing = null
    try {
      existing = await this.apiClient.searchProductByOdooId(odooId)
    } catch (err) {
      if (this.logger) {
        this.logger.warn('hubspot.product.search failed; falling back to create', { odooId, error: err.message })
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
        if (this.logger) this.logger.warn('hubspot.product.duplicate', { odooId, sourceId: odooProduct.id, error: err.message })
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

  isInvalidPropertyValueError(err) {
    if (!err) return false
    const status = err.httpStatus ?? err.status ?? (err.response && err.response.status)
    const category =
      (err.original && err.original.response && err.original.response.data && err.original.response.data.category) ||
      (err.response && err.response.data && err.response.data.category)
    if (category === 'VALIDATION_ERROR') return true
    const sources = [
      err.message,
      err.response && err.response.data && err.response.data.message,
      err.original && err.original.response && err.original.response.data && err.original.response.data.message
    ].filter(Boolean)
    const msg = sources.join(' ').toLowerCase()
    return status === 400 && msg.includes('property values were not valid')
  }

  // (openspec/hubspot-product-odoo-id-key) batch path dedupes by Odoo id — no SKU partition, no
  // `no_sku` skip entries, no `duplicate_sku_in_input` skip entries. The Odoo id is unique by
  // construction so duplicates within the batch are impossible; missing Odoo ids are skipped
  // up-front (`no_id`).
  async batchUpsertByOdooIds(odooProducts, { chunkSize = 100, idProperty = this.idProperty } = {}) {
    if (!Array.isArray(odooProducts) || odooProducts.length === 0) {
      return { results: [], errors: [], skipped: [] }
    }
    const valid = []
    const skipped = []
    for (const p of odooProducts) {
      if (this.hasValidOdooId(p)) {
        valid.push(p)
      } else {
        skipped.push({ sourceId: p && p.id != null ? p.id : null, reason: 'no_id' })
      }
    }
    if (valid.length === 0) {
      return { results: [], errors: [], skipped }
    }

    const allResults = []
    const allErrors = []
    for (let i = 0; i < valid.length; i += chunkSize) {
      const chunk = valid.slice(i, i + chunkSize)
      const inputs = chunk.map((p) => ({
        id: this.extractOdooId(p),
        properties: this.buildProperties(p)
      }))
      try {
        const response = await this.apiClient.batchUpsertProducts({ inputs, idProperty })
        allResults.push(...(response.results || []))
        allErrors.push(...(response.errors || []))
      } catch (err) {
        if (this.logger) {
          this.logger.warn('hubspot.product.batch_chunk_failed_fallback_to_individual', {
            chunkSize: chunk.length, error: err.message
          })
        }
        await async.mapLimit(chunk, FALLBACK_CONCURRENCY, async (p) => {
          const odooId = this.extractOdooId(p)
          try {
            const response = await this.apiClient.batchUpsertProducts({
              inputs: [{ id: odooId, properties: this.buildProperties(p) }],
              idProperty
            })
            allResults.push(...(response.results || []))
          } catch (itemErr) {
            if (this.isDuplicateError(itemErr)) {
              if (this.logger) this.logger.warn('hubspot.product.duplicate', { odooId, sourceId: p.id, error: itemErr.message })
              skipped.push({ sourceId: p.id, reason: 'duplicate_in_hubspot' })
            } else if (this.isInvalidPropertyValueError(itemErr)) {
              if (this.logger) this.logger.warn('hubspot.product.invalid_property_value', { odooId, sourceId: p.id, error: itemErr.message })
              skipped.push({ sourceId: p.id, reason: 'invalid_property_value' })
            } else {
              allErrors.push({ id: odooId, message: itemErr.message })
            }
          }
        })
      }
    }
    return { results: allResults, errors: allErrors, skipped }
  }
}

module.exports = { HubspotProductGateway }
