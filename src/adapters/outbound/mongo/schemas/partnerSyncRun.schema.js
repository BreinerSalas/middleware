'use strict'

const { Schema, model } = require('mongoose')

const PartnerSyncRunSchema = new Schema({
  startedAt: { type: Date, required: true },
  endedAt: { type: Date, default: null },
  status: { type: String, enum: ['running', 'completed', 'failed'], default: 'running' },
  total: { type: Number, default: 0 },
  created: { type: Number, default: 0 },
  updated: { type: Number, default: 0 },
  skipped: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  archived: { type: Number, default: 0 },
  dryRun: { type: Boolean, default: false },
  metadata: { type: Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: () => new Date() },
  updatedAt: { type: Date, default: () => new Date() }
}, { versionKey: false })

module.exports = {
  PartnerSyncRunSchema,
  PartnerSyncRunModel: model('PartnerSyncRun', PartnerSyncRunSchema)
}
