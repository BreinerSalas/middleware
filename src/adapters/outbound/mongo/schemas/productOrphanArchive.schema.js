'use strict'

const { Schema, model } = require('mongoose')

// (sdd/hubspot-product-reverse-discovery, design D7/D8) Written `pending` BEFORE the HubSpot
// archive call, flipped to `archived`/`failed` after — never archive without a durable,
// reversible record. `restored` is reserved for the manual HubSpot recycle-bin rollback path
// described in the design's Migration/Rollout section.
const ProductOrphanArchiveSchema = new Schema({
  hubspotId: { type: String, required: true, unique: true, index: true },
  name: { type: String, default: null },
  price: { type: Schema.Types.Mixed, default: null },
  siblingHubspotId: { type: String, default: null },
  siblingOdooId: { type: String, default: null },
  status: { type: String, enum: ['pending', 'archived', 'failed', 'restored'], default: 'pending', index: true },
  requestedAt: { type: Date, required: true },
  archivedAt: { type: Date, default: null },
  error: { type: String, default: null },
  dryRun: { type: Boolean, default: false },
  createdAt: { type: Date, default: () => new Date() },
  updatedAt: { type: Date, default: () => new Date() }
}, { versionKey: false })

module.exports = {
  ProductOrphanArchiveSchema,
  ProductOrphanArchiveModel: model('ProductOrphanArchive', ProductOrphanArchiveSchema)
}
