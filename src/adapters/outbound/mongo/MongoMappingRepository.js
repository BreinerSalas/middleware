'use strict'

const { MappingModel } = require('./schemas/mapping.schema')
const { SyncMapping } = require('../../../core/domain/SyncMapping')

function toDomain(doc) {
  if (!doc) return null
  const obj = doc.toObject ? doc.toObject() : doc
  return new SyncMapping({
    _id: obj._id ? String(obj._id) : null,
    sourceId: obj.sourceId,
    targetId: obj.targetId,
    targetRef: obj.targetRef,
    payloadHash: obj.payloadHash,
    lastSyncedAt: obj.lastSyncedAt,
    metadata: obj.metadata || {},
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt
  })
}

class MongoMappingRepository {
  constructor({ model = MappingModel } = {}) { this.model = model }

  async findBySourceId(sourceId) {
    const doc = await this.model.findOne({ sourceId })
    return toDomain(doc)
  }

  async findByTargetId(targetId) {
    const doc = await this.model.findOne({ targetId })
    return toDomain(doc)
  }

  async upsert(mapping) {
    const existing = await this.model.findOne({ sourceId: mapping.sourceId }).lean()
    const mergedMetadata = { ...((existing && existing.metadata) || {}), ...(mapping.metadata || {}) }
    const update = {
      targetId: mapping.targetId,
      targetRef: mapping.targetRef,
      payloadHash: mapping.payloadHash,
      lastSyncedAt: mapping.lastSyncedAt || new Date(),
      metadata: mergedMetadata,
      updatedAt: new Date()
    }
    const doc = await this.model.findOneAndUpdate(
      { sourceId: mapping.sourceId },
      { $set: update, $setOnInsert: { sourceId: mapping.sourceId, createdAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    )
    return toDomain(doc)
  }
}

module.exports = { MongoMappingRepository, toDomain }
