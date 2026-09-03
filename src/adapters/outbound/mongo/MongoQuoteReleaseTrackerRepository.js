'use strict'

const { QuoteReleaseTrackerModel } = require('./schemas/quoteReleaseTracker.schema')
const { QuoteReleaseTracker } = require('../../../core/domain/QuoteReleaseTracker')

function toDomain(doc) {
  if (!doc) return null
  return new QuoteReleaseTracker({
    quoteId: doc.quoteId,
    dealId: doc.dealId,
    stage: doc.stage
  })
}

class MongoQuoteReleaseTrackerRepository {
  constructor({ model = QuoteReleaseTrackerModel, logger = null } = {}) {
    this.model = model
    this.logger = logger
  }

  async findByQuoteId(quoteId) {
    const doc = await this.model.findOne({ quoteId: String(quoteId) }).lean()
    return toDomain(doc)
  }

  async save(tracker) {
    const doc = await this.model.findOneAndUpdate(
      { quoteId: tracker.quoteId },
      { $set: { dealId: tracker.dealId, stage: tracker.stage } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean()
    return toDomain(doc)
  }
}

module.exports = { MongoQuoteReleaseTrackerRepository }
