'use strict'

const { Schema, model } = require('mongoose')

const PartnerMappingSchema = new Schema({
  odooId: { type: Number, required: true, unique: true, index: true },
  odooPartnerId: { type: String, default: null, index: true },
  // (sdd/hubspot-contact-inbound-sync) Non-unique on purpose: legacy rows may already have
  // duplicate hubspotId values, and this index only needs to speed up findByHubspotId lookups.
  hubspotId: { type: String, default: null, index: true, sparse: true },
  // (sdd/hubspot-contact-inbound-sync) Records which system originated the mapping. Default
  // null = legacy row, implicitly odoo_to_hubspot. Never backfilled; see
  // MongoPartnerMappingRepository.bulkUpsertMany ($setOnInsert only, never $set).
  direction: { type: String, enum: ['odoo_to_hubspot', 'hubspot_to_odoo'], default: null },
  lastAction: {
    type: String,
    enum: ['created', 'updated', 'backfilled', 'attempted', 'linked'],
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
