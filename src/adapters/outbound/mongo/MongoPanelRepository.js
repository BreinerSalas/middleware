'use strict'

const { MappingModel } = require('./schemas/mapping.schema.js')
const { AuditModel } = require('./schemas/audit.schema.js')
const { JobModel } = require('./schemas/job.schema.js')

const MAX_PAGE_SIZE = 100

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function buildMappingFilter(q) {
  if (!q || typeof q !== 'string') return {}
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(safe, 'i')
  return { $or: [{ sourceId: re }, { targetId: re }] }
}

function buildAuditFilter({ event, success, q }) {
  const filter = {}
  if (event) filter.event = event
  if (typeof success === 'boolean') filter.success = success
  if (q && typeof q === 'string') {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    filter.sourceId = new RegExp(safe, 'i')
  }
  return filter
}

class MongoPanelRepository {
  constructor({ mappingModel = MappingModel, auditModel = AuditModel, jobModel = JobModel } = {}) {
    this.mappingModel = mappingModel
    this.auditModel = auditModel
    this.jobModel = jobModel
  }

  async listMappings({ page = 1, pageSize = 25, q = null } = {}) {
    const p = clamp(page, 1, Number.MAX_SAFE_INTEGER)
    const ps = clamp(pageSize, 1, MAX_PAGE_SIZE)
    const filter = buildMappingFilter(q)
    const [items, total] = await Promise.all([
      this.mappingModel.find(filter).sort({ updatedAt: -1 }).skip((p - 1) * ps).limit(ps).lean(),
      this.mappingModel.countDocuments(filter)
    ])
    return { items: items.map((m) => ({ ...m, _id: String(m._id) })), total, page: p, pageSize: ps }
  }

  async deleteMapping(id) {
    if (!id) return false
    const res = await this.mappingModel.deleteOne({ _id: id })
    return res.deletedCount === 1
  }

  async clearMappings() {
    const res = await this.mappingModel.deleteMany({})
    return res.deletedCount || 0
  }

  async listLogs({ page = 1, pageSize = 25, event = null, success = undefined, q = null } = {}) {
    const p = clamp(page, 1, Number.MAX_SAFE_INTEGER)
    const ps = clamp(pageSize, 1, MAX_PAGE_SIZE)
    const filter = buildAuditFilter({ event, success, q })
    const [items, total] = await Promise.all([
      this.auditModel.find(filter).sort({ createdAt: -1 }).skip((p - 1) * ps).limit(ps).lean(),
      this.auditModel.countDocuments(filter)
    ])
    return { items: items.map((a) => ({ ...a, _id: String(a._id) })), total, page: p, pageSize: ps }
  }

  async getLogById(id) {
    if (!id) return null
    const doc = await this.auditModel.findById(id).lean()
    return doc ? { ...doc, _id: String(doc._id) } : null
  }

  async deleteLog(id) {
    if (!id) return false
    const res = await this.auditModel.deleteOne({ _id: id })
    return res.deletedCount === 1
  }

  async clearLogs() {
    const res = await this.auditModel.deleteMany({})
    return res.deletedCount || 0
  }

  async getCounts() {
    const [mappings, audits, jobsByStatus] = await Promise.all([
      this.mappingModel.countDocuments({}),
      this.auditModel.countDocuments({}),
      this.jobModel.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
    ])
    const byStatus = {}
    for (const row of jobsByStatus) byStatus[row._id] = row.count
    return { mappings, audits, jobsByStatus: byStatus }
  }
}

module.exports = { MongoPanelRepository, clamp, buildMappingFilter, buildAuditFilter }
