'use strict'

const { Schema, model } = require('mongoose')

const MappingSchema = new Schema({
  sourceId: { type: String, required: true, unique: true, index: true },
  targetId: { type: String, default: null },
  targetRef: { type: String, default: null },
  payloadHash: { type: String, default: null },
  lastSyncedAt: { type: Date, default: () => new Date() },
  metadata: { type: Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: () => new Date() },
  updatedAt: { type: Date, default: () => new Date() }
}, { versionKey: false })

module.exports = { MappingSchema, MappingModel: model('Mapping', MappingSchema) }
