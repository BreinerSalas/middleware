'use strict'

const { SyncCursorModel } = require('./schemas/syncCursor.schema')

class MongoSyncCursorRepository {
  constructor({ model = SyncCursorModel } = {}) {
    this.model = model
  }

  async get(key) {
    const doc = await this.model.findOne({ key }).lean()
    return doc ? doc.watermark : null
  }

  async set(key, watermark, now = new Date()) {
    await this.model.updateOne(
      { key },
      { $set: { watermark, updatedAt: now } },
      { upsert: true }
    )
  }
}

module.exports = { MongoSyncCursorRepository }
