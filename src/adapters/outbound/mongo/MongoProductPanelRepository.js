'use strict'

const { ProductMappingModel } = require('./schemas/productMapping.schema')
const { ProductSyncRunModel } = require('./schemas/productSyncRun.schema')
const { MongoProductMappingRepository } = require('./MongoProductMappingRepository')
const { MongoProductSyncRunRepository } = require('./MongoProductSyncRunRepository')

const MAX_PAGE_SIZE = 100

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function buildProductMappingFilter(q) {
  if (!q || typeof q !== 'string') return {}
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(safe, 'i')
  return { $or: [{ odooId: Number.isFinite(Number(q)) ? Number(q) : -1 }, { hsSku: re }, { hubspotId: re }] }
}

class MongoProductPanelRepository {
  constructor({ mappingRepo, runRepo } = {}) {
    this.mappingRepo = mappingRepo || new MongoProductMappingRepository()
    this.runRepo = runRepo || new MongoProductSyncRunRepository()
  }

  async listProductMappings({ page = 1, pageSize = 25, q = null } = {}) {
    const p = clamp(page, 1, Number.MAX_SAFE_INTEGER)
    const ps = clamp(pageSize, 1, MAX_PAGE_SIZE)
    if (this.mappingRepo.listPaginated) {
      const filter = buildProductMappingFilter(q)
      const skip = (p - 1) * ps
      const [items, total] = await Promise.all([
        ProductMappingModel.find(filter).sort({ lastSyncedAt: -1 }).skip(skip).limit(ps).lean(),
        ProductMappingModel.countDocuments(filter)
      ])
      return { items: items.map((m) => ({ ...m, _id: String(m._id) })), total, page: p, pageSize: ps }
    }
    const all = await this.mappingRepo.listAll()
    return { items: all.slice((p - 1) * ps, (p - 1) * ps + ps), total: all.length, page: p, pageSize: ps }
  }

  async listRecentRuns({ limit = 10 } = {}) {
    return ProductSyncRunModel.find({}).sort({ startedAt: -1 }).limit(clamp(limit, 1, MAX_PAGE_SIZE)).lean()
  }

  async getProductCounts() {
    const [mappings, runs] = await Promise.all([
      ProductMappingModel.countDocuments({}),
      ProductSyncRunModel.countDocuments({})
    ])
    return { mappings, runs }
  }
}

module.exports = { MongoProductPanelRepository, buildProductMappingFilter }
