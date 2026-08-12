'use strict'

class OdooPartnerSource {
  constructor({ apiClient, logger = null, pageSize = 100 } = {}) {
    if (!apiClient) throw new Error('OdooPartnerSource requires apiClient')
    this.apiClient = apiClient
    this.logger = logger
    this.pageSize = pageSize
  }

  async count() {
    return this.apiClient.countPartners()
  }

  async listAll({ limit = null } = {}) {
    const out = []
    let offset = 0
    let totalFetched = 0
    while (true) {
      const page = await this.apiClient.searchPartnersAll({ offset, limit: this.pageSize })
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

  async *listChangedSince({ writeDateGte } = {}) {
    if (!writeDateGte) throw new Error('OdooPartnerSource.listChangedSince requires writeDateGte')
    let offset = 0
    while (true) {
      const page = await this.apiClient.searchPartnersChangedSince({ writeDateGte, offset, limit: this.pageSize })
      const count = Array.isArray(page) ? page.length : 0
      if (count === 0) return
      yield page
      if (count < this.pageSize) return
      offset += this.pageSize
    }
  }
}

module.exports = { OdooPartnerSource }
