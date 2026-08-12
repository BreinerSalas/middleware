'use strict'

const { PartnerMappingModel } = require('./schemas/partnerMapping.schema')

class MongoPartnerMappingRepository {
  constructor({ model = PartnerMappingModel, logger = null } = {}) {
    this.model = model
    this.logger = logger
  }

  async upsert({ odooId, hubspotId, action, now = () => new Date() } = {}) {
    const at = toDate(now())
    const numericOdooId = Number(odooId)
    const result = await this.model.findOneAndUpdate(
      { odooId: numericOdooId },
      {
        $set: {
          odooPartnerId: String(numericOdooId),
          hubspotId: hubspotId == null ? null : String(hubspotId),
          lastAction: action,
          lastSyncedAt: at,
          updatedAt: at
        },
        $setOnInsert: {
          odooId: numericOdooId,
          firstSyncedAt: at,
          createdAt: at
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    )
    return result
  }

  async bulkUpsertMany({ items = [], now = () => new Date() } = {}) {
    if (!items.length) return { upsertedCount: 0 }
    const at = toDate(now())
    const ops = items.map((it) => {
      const numericOdooId = Number(it.odooId)
      return {
        updateOne: {
          filter: { odooId: numericOdooId },
          update: {
            $set: {
              odooPartnerId: String(numericOdooId),
              hubspotId: it.hubspotId == null ? null : String(it.hubspotId),
              lastAction: it.action,
              lastSyncedAt: at,
              updatedAt: at
            },
            $setOnInsert: {
              odooId: numericOdooId,
              firstSyncedAt: at,
              createdAt: at
            }
          },
          upsert: true
        }
      }
    })
    const result = await this.model.bulkWrite(ops, { ordered: false })
    return { upsertedCount: (result.upsertedCount || 0) + (result.modifiedCount || 0) + (result.matchedCount || 0) }
  }

  async findByOdooId(odooId) {
    return this.model.findOne({ odooId: Number(odooId) }).lean()
  }

  async listAll() {
    return this.model.find({}).sort({ lastSyncedAt: -1 }).lean()
  }

  async listPaginated({ page = 1, limit = 20 } = {}) {
    const skip = (Math.max(1, page) - 1) * limit
    const [items, total] = await Promise.all([
      this.model.find({}).sort({ lastSyncedAt: -1 }).skip(skip).limit(limit).lean(),
      this.model.countDocuments()
    ])
    return { items, total, page, limit }
  }

  async clear() {
    return this.model.deleteMany({})
  }
}

function toDate(v) {
  if (v == null) return new Date()
  if (v instanceof Date) return v
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? new Date() : d
}

module.exports = { MongoPartnerMappingRepository }
