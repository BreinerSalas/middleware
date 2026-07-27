'use strict'

class OdooProductSource {
  constructor({ apiClient, logger = null, pageSize = 100 } = {}) {
    if (!apiClient) throw new Error('OdooProductSource requires apiClient')
    this.apiClient = apiClient
    this.logger = logger
    this.pageSize = pageSize
  }

  async count() {
    return this.apiClient.countProductsWithDefaultCode()
  }

  async listAll({ limit = null } = {}) {
    const out = []
    let offset = 0
    let totalFetched = 0
    while (true) {
      const page = await this.apiClient.searchProductsWithDefaultCode({ offset, limit: this.pageSize })
      const count = Array.isArray(page) ? page.length : 0
      if (count === 0) break
      out.push(...page)
      totalFetched += count
      if (count < this.pageSize) break
      if (limit != null && totalFetched >= limit) {
        return out.slice(0, limit)
      }
      offset += this.pageSize
    }
    return out
  }
}

module.exports = { OdooProductSource }
