'use strict'

const { DedupeModel } = require('./schemas/dedupe.schema')

class MongoDedupeGuard {
  constructor({ model = DedupeModel } = {}) { this.model = model }

  async isDuplicate(key) {
    const doc = await this.model.findOne({ key }).lean()
    return !!doc
  }

  async markSeen(key) {
    try {
      await this.model.updateOne({ key }, { $setOnInsert: { key, createdAt: new Date() } }, { upsert: true })
    } catch (err) {
      if (err && err.code === 11000) return
      throw err
    }
  }
}

module.exports = { MongoDedupeGuard }
