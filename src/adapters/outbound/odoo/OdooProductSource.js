'use strict'

class OdooProductSource {
  constructor({ apiClient, logger = null, pageSize = 100 } = {}) {
    if (!apiClient) throw new Error('OdooProductSource requires apiClient')
    this.apiClient = apiClient
    this.logger = logger
    this.pageSize = pageSize
  }

  async count({ includeNoSku = false } = {}) {
    if (includeNoSku) return this.apiClient.countProductsAll()
    return this.apiClient.countProductsWithDefaultCode()
  }

  async listAll({ limit = null, includeNoSku = false } = {}) {
    const fetcher = includeNoSku
      ? (offset, pageSize) => this.apiClient.searchProductsAll({ offset, limit: pageSize })
      : (offset, pageSize) => this.apiClient.searchProductsWithDefaultCode({ offset, limit: pageSize })
    const out = []
    let offset = 0
    let totalFetched = 0
    while (true) {
      const page = await fetcher(offset, this.pageSize)
      const count = Array.isArray(page) ? page.length : 0
      if (count === 0) break
      out.push(...page)
      totalFetched += count
      if (limit != null && totalFetched >= limit) break
      if (count < this.pageSize) break
      offset += this.pageSize
    }
    return limit != null ? out.slice(0, limit) : out
  }

  async *listChangedSince({ writeDateGte, includeNoSku = false } = {}) {
    if (!writeDateGte) throw new Error('OdooProductSource.listChangedSince requires writeDateGte')
    let offset = 0
    while (true) {
      const page = await this.apiClient.searchProductsChangedSince({
        writeDateGte, offset, limit: this.pageSize, includeNoSku
      })
      const count = Array.isArray(page) ? page.length : 0
      if (count === 0) return
      yield page
      if (count < this.pageSize) return
      offset += this.pageSize
    }
  }
}

module.exports = { OdooProductSource }
