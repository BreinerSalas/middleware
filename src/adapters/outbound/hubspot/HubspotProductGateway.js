'use strict'

const async = require('async')

const FALLBACK_CONCURRENCY = 10

class HubspotProductGateway {
  constructor({ apiClient, logger = null, imageUrlBuilder = null } = {}) {
    if (!apiClient) throw new Error('HubspotProductGateway requires apiClient')
    this.apiClient = apiClient
    this.logger = logger
    this.imageUrlBuilder = imageUrlBuilder
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

  async batchUpsertBySkus(odooProducts, { chunkSize = 100, idProperty = 'hs_sku' } = {}) {
    if (!Array.isArray(odooProducts) || odooProducts.length === 0) {
      return { results: [], errors: [], skipped: [] }
    }
    const valid = []
    const skippedNoSku = []
    for (const p of odooProducts) {
      if (!p || this.hasValidSku(p)) {
        valid.push(p)
      } else {
        skippedNoSku.push({ sourceId: p && p.id != null ? p.id : null, reason: 'no_sku' })
      }
    }
    const seen = new Map()
    const dupSkipped = []
    const dedup = []
    for (const p of valid) {
      const sku = this.extractSku(p)
      if (seen.has(sku)) {
        dupSkipped.push({ sourceId: p.id, reason: 'duplicate_sku_in_input' })
      } else {
        seen.set(sku, p)
        dedup.push(p)
      }
    }
    if (dupSkipped.length > 0 && this.logger && typeof this.logger.warn === 'function') {
      this.logger.warn('hubspot.products.duplicate_sku_in_input', {
        count: dupSkipped.length, sourceIds: dupSkipped.slice(0, 5).map((d) => d.sourceId)
      })
    }
    if (dedup.length === 0) {
      return { results: [], errors: [], skipped: [...skippedNoSku, ...dupSkipped] }
    }
    const allResults = []
    const allErrors = []
    const fallbackSkipped = []
    for (let i = 0; i < dedup.length; i += chunkSize) {
      const chunk = dedup.slice(i, i + chunkSize)
      const inputs = chunk.map((p) => ({
        id: this.extractSku(p),
        properties: this.buildProperties(p)
      }))
      try {
        const response = await this.apiClient.batchUpsertProducts({ inputs, idProperty })
        allResults.push(...(response.results || []))
        allErrors.push(...(response.errors || []))
      } catch (err) {
        // HubSpot can reject the WHOLE batch request for a single item's conflict/invalid value
        // (e.g. a duplicate hs_sku collision or a malformed property) instead of returning it as
        // a per-item error. Falling back to one single-item batch call per product isolates just
        // the offending product(s) so the rest of the chunk still syncs.
        if (this.logger) {
          this.logger.warn('hubspot.product.batch_chunk_failed_fallback_to_individual', {
            chunkSize: chunk.length, error: err.message
          })
        }
        await async.mapLimit(chunk, FALLBACK_CONCURRENCY, async (p) => {
          const sku = this.extractSku(p)
          try {
            const response = await this.apiClient.batchUpsertProducts({
              inputs: [{ id: sku, properties: this.buildProperties(p) }],
              idProperty
            })
            allResults.push(...(response.results || []))
          } catch (itemErr) {
            if (this.isDuplicateError(itemErr)) {
              if (this.logger) this.logger.warn('hubspot.product.duplicate', { sku, sourceId: p.id, error: itemErr.message })
              fallbackSkipped.push({ sourceId: p.id, reason: 'duplicate_in_hubspot' })
            } else if (this.isInvalidPropertyValueError(itemErr)) {
              if (this.logger) this.logger.warn('hubspot.product.invalid_property_value', { sku, sourceId: p.id, error: itemErr.message })
              fallbackSkipped.push({ sourceId: p.id, reason: 'invalid_property_value' })
            } else {
              allErrors.push({ id: sku, message: itemErr.message })
            }
          }
        })
      }
    }
    return { results: allResults, errors: allErrors, skipped: [...skippedNoSku, ...dupSkipped, ...fallbackSkipped] }
  }
}

module.exports = { HubspotProductGateway }
