'use strict'

const { Schema, model } = require('mongoose')

const PartnerMappingSchema = new Schema({
  odooId: { type: Number, required: true, unique: true, index: true },
  odooPartnerId: { type: String, default: null, index: true },
  hubspotId: { type: String, default: null },
  lastAction: {
    type: String,
    enum: ['created', 'updated', 'backfilled', 'attempted'],
    required: true
  },
  lastSyncedAt: { type: Date, required: true },
  firstSyncedAt: { type: Date, required: true },
  metadata: { type: Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: () => new Date() },
  updatedAt: { type: Date, default: () => new Date() }
}, { versionKey: false })

module.exports = {
  PartnerMappingSchema,
  PartnerMappingModel: model('PartnerMapping', PartnerMappingSchema)
}
