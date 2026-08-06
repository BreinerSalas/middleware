'use strict'

class OdooSaleOrderSource {
  constructor({ apiClient, logger = null, pageSize = 100 } = {}) {
    if (!apiClient) throw new Error('OdooSaleOrderSource requires apiClient')
    this.apiClient = apiClient
    this.logger = logger
    this.pageSize = pageSize
  }

  async *listChangedSince({ writeDateGte } = {}) {
    if (!writeDateGte) throw new Error('OdooSaleOrderSource.listChangedSince requires writeDateGte')
    let offset = 0
    while (true) {
      const page = await this.apiClient.searchSalesOrdersChangedSince({
        writeDateGte, offset, limit: this.pageSize
      })
      const count = Array.isArray(page) ? page.length : 0
      if (count === 0) return
      yield page
      if (count < this.pageSize) return
      offset += this.pageSize
    }
  }
}

module.exports = { OdooSaleOrderSource }
