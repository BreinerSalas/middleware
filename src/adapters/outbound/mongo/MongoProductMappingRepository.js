'use strict'

const { ProductMappingModel } = require('./schemas/productMapping.schema')

class MongoProductMappingRepository {
  constructor({ model = ProductMappingModel, logger = null } = {}) {
    this.model = model
    this.logger = logger
  }

  async upsert({ odooId, hsSku, hubspotId, action, now = () => new Date() } = {}) {
    const at = toDate(now())
    const result = await this.model.findOneAndUpdate(
      { odooId: Number(odooId) },
      {
        $set: {
          hsSku: hsSku == null ? null : String(hsSku),
          hubspotId: hubspotId == null ? null : String(hubspotId),
          lastAction: action,
          lastSyncedAt: at,
          updatedAt: at
        },
        $setOnInsert: {
          odooId: Number(odooId),
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
    const ops = items.map((it) => ({
      updateOne: {
        filter: { odooId: Number(it.odooId) },
        update: {
          $set: {
            hsSku: it.hsSku == null ? null : String(it.hsSku),
            hubspotId: it.hubspotId == null ? null : String(it.hubspotId),
            lastAction: it.action,
            lastSyncedAt: at,
            updatedAt: at
          },
          $setOnInsert: {
            odooId: Number(it.odooId),
            firstSyncedAt: at,
            createdAt: at
          }
        },
        upsert: true
      }
    }))
    const result = await this.model.bulkWrite(ops, { ordered: false })
    return { upsertedCount: (result.upsertedCount || 0) + (result.modifiedCount || 0) + (result.matchedCount || 0) }
  }

  async findByOdooId(odooId) {
    return this.model.findOne({ odooId: Number(odooId) }).lean()
  }

  // (openspec/hubspot-product-odoo-id-key) Tier 2 in the line-item resolution path queries the
  // mapping by HubSpot product id. Pre-existing `no_sku_no_match` rows store `hubspotId: null`
  // — those MUST short-circuit to null without a Mongo query so we never "match" them.
  async findByHubspotId(hubspotId) {
    if (hubspotId == null) return null
    const s = String(hubspotId)
    if (s.length === 0 || s === 'null') return null
    return this.model.findOne({ hubspotId: s }).lean()
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

module.exports = { MongoProductMappingRepository }
