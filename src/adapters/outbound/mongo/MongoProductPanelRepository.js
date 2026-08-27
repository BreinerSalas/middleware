'use strict'

const { ProductMappingModel } = require('./schemas/productMapping.schema')
const { ProductSyncRunModel } = require('./schemas/productSyncRun.schema')
const { ProductOrphanQuarantineModel } = require('./schemas/productOrphanQuarantine.schema')
const { ProductOrphanArchiveModel } = require('./schemas/productOrphanArchive.schema')
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

// (sdd/hubspot-product-reverse-discovery, Phase 4) Reuses the escaped-regex convention above.
function buildOrphanQuarantineFilter(q) {
  if (!q || typeof q !== 'string') return {}
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(safe, 'i')
  return { $or: [{ hubspotId: re }, { name: re }, { reason: re }] }
}

function buildOrphanArchiveFilter(q) {
  if (!q || typeof q !== 'string') return {}
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(safe, 'i')
  return { $or: [{ hubspotId: re }, { name: re }, { status: re }] }
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

  // (sdd/hubspot-product-reverse-discovery, Phase 4) Read-only surface over the Phase 3
  // quarantine/archive audit collections. Same {page, pageSize, q} shape as listProductMappings.
  async listOrphanQuarantine({ page = 1, pageSize = 25, q = null } = {}) {
    const p = clamp(page, 1, Number.MAX_SAFE_INTEGER)
    const ps = clamp(pageSize, 1, MAX_PAGE_SIZE)
    const filter = buildOrphanQuarantineFilter(q)
    const skip = (p - 1) * ps
    const [items, total] = await Promise.all([
      ProductOrphanQuarantineModel.find(filter).sort({ lastSeenAt: -1 }).skip(skip).limit(ps).lean(),
      ProductOrphanQuarantineModel.countDocuments(filter)
    ])
    return { items: items.map((d) => ({ ...d, _id: String(d._id) })), total, page: p, pageSize: ps }
  }

  async listOrphanArchives({ page = 1, pageSize = 25, q = null } = {}) {
    const p = clamp(page, 1, Number.MAX_SAFE_INTEGER)
    const ps = clamp(pageSize, 1, MAX_PAGE_SIZE)
    const filter = buildOrphanArchiveFilter(q)
    const skip = (p - 1) * ps
    const [items, total] = await Promise.all([
      ProductOrphanArchiveModel.find(filter).sort({ requestedAt: -1 }).skip(skip).limit(ps).lean(),
      ProductOrphanArchiveModel.countDocuments(filter)
    ])
    return { items: items.map((d) => ({ ...d, _id: String(d._id) })), total, page: p, pageSize: ps }
  }
}

module.exports = { MongoProductPanelRepository, buildProductMappingFilter, buildOrphanQuarantineFilter, buildOrphanArchiveFilter }
