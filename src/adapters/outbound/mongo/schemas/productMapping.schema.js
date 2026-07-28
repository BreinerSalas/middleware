'use strict'

const { Schema, model } = require('mongoose')

const ProductMappingSchema = new Schema({
  odooId: { type: Number, required: true, unique: true, index: true },
  hsSku: { type: String, required: true, index: true },
  hubspotId: { type: String, required: true },
  lastAction: { type: String, enum: ['created', 'updated'], required: true },
  lastSyncedAt: { type: Date, required: true },
  firstSyncedAt: { type: Date, required: true },
  metadata: { type: Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: () => new Date() },
  updatedAt: { type: Date, default: () => new Date() }
}, { versionKey: false })

module.exports = {
  ProductMappingSchema,
  ProductMappingModel: model('ProductMapping', ProductMappingSchema)
}
