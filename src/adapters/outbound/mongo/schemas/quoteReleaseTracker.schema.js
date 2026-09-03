'use strict'

const { Schema, model } = require('mongoose')

const QuoteReleaseTrackerSchema = new Schema({
  quoteId: { type: String, required: true, unique: true, index: true },
  dealId: { type: String, required: true },
  stage: {
    type: String,
    enum: ['pending', 'released', 'cancelled'],
    default: 'pending'
  }
}, { timestamps: true, versionKey: false })

module.exports = {
  QuoteReleaseTrackerSchema,
  QuoteReleaseTrackerModel: model('QuoteReleaseTracker', QuoteReleaseTrackerSchema)
}
