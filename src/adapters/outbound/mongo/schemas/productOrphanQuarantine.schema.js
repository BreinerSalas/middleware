'use strict'

const { Schema, model } = require('mongoose')

// (sdd/hubspot-product-reverse-discovery, design D8) Orphans have no odooId, so they cannot be
// rows in product_mapping (unique required odooId). Upserted per run by hubspotId so re-seeing
// the same orphan never grows the collection unbounded — runCount tracks how many runs saw it.
const ProductOrphanQuarantineSchema = new Schema({
  hubspotId: { type: String, required: true, unique: true, index: true },
  name: { type: String, default: null },
  normalizedName: { type: String, default: null, index: true },
  price: { type: Schema.Types.Mixed, default: null },
  reason: { type: String, required: true },
  odooCandidateIds: { type: [Number], default: [] },
  detail: { type: Schema.Types.Mixed, default: null },
  firstSeenAt: { type: Date, required: true },
  lastSeenAt: { type: Date, required: true },
  runCount: { type: Number, default: 0 },
  resolvedAt: { type: Date, default: null },
  createdAt: { type: Date, default: () => new Date() },
  updatedAt: { type: Date, default: () => new Date() }
}, { versionKey: false })

module.exports = {
  ProductOrphanQuarantineSchema,
  ProductOrphanQuarantineModel: model('ProductOrphanQuarantine', ProductOrphanQuarantineSchema)
}
