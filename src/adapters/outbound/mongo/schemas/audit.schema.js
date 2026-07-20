'use strict'

const { Schema, model } = require('mongoose')

const AuditSchema = new Schema({
  jobId: { type: String, default: null, index: true },
  sourceId: { type: String, required: true, index: true },
  correlationId: { type: String, default: null, index: true },
  event: { type: String, required: true },
  detail: { type: Schema.Types.Mixed, default: null },
  success: { type: Boolean, default: true },
  createdAt: { type: Date, default: () => new Date(), index: true }
}, { versionKey: false })

module.exports = { AuditSchema, AuditModel: model('Audit', AuditSchema) }
