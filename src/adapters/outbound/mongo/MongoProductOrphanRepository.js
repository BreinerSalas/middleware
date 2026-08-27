'use strict'

const { ProductOrphanQuarantineModel } = require('./schemas/productOrphanQuarantine.schema')
const { ProductOrphanArchiveModel } = require('./schemas/productOrphanArchive.schema')
const { normalizeProductName } = require('../odoo/productNameKey')

// (sdd/hubspot-product-reverse-discovery, Phase 3) Durable persistence for
// productOrphanReconcileModule.js's quarantine + archive-audit steps. That module already calls
// these four methods defensively (`if (orphanRepo && typeof orphanRepo.X === 'function')`), and
// `recordArchivePending` presence specifically gates whether a real archive happens at all —
// see the design's "never archive without a durable reversible record" decision (D7).
class MongoProductOrphanRepository {
  constructor({
    quarantineModel = ProductOrphanQuarantineModel,
    archiveModel = ProductOrphanArchiveModel,
    logger = null
  } = {}) {
    this.quarantineModel = quarantineModel
    this.archiveModel = archiveModel
    this.logger = logger
  }

  // Called once per quarantined orphan at the end of a real (non-dry-run) run. Upserted by
  // hubspotId so re-quarantining the same orphan across runs never grows the collection
  // unbounded — it refreshes the outcome and increments runCount instead of duplicating rows.
  async upsertQuarantine({
    hubspotId,
    name = null,
    price = null,
    reason,
    odooCandidateIds = [],
    detail = null,
    now = () => new Date()
  } = {}) {
    const at = toDate(now())
    return this.quarantineModel.findOneAndUpdate(
      { hubspotId: String(hubspotId) },
      {
        $set: {
          name: name == null ? null : String(name),
          normalizedName: name == null ? null : normalizeProductName(name),
          price,
          reason,
          odooCandidateIds,
          detail,
          lastSeenAt: at,
          resolvedAt: null,
          updatedAt: at
        },
        $setOnInsert: {
          hubspotId: String(hubspotId),
          firstSeenAt: at,
          createdAt: at
        },
        $inc: { runCount: 1 }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    )
  }

  // Marks a quarantine doc resolved (e.g. a later run promotes or archives the same orphan). A
  // no-op when no quarantine doc exists for the hubspotId — never creates one.
  async resolveQuarantine({ hubspotId, now = () => new Date() } = {}) {
    const at = toDate(now())
    return this.quarantineModel.findOneAndUpdate(
      { hubspotId: String(hubspotId) },
      { $set: { resolvedAt: at, updatedAt: at } }
    )
  }

  // (design D7) Written BEFORE the HubSpot batch/archive call — this is the durable, reversible
  // record that unlocks archiving in the first place.
  async recordArchivePending({
    hubspotId,
    name = null,
    price = null,
    siblingHubspotId = null,
    siblingOdooId = null,
    dryRun = false,
    now = () => new Date()
  } = {}) {
    const at = toDate(now())
    return this.archiveModel.findOneAndUpdate(
      { hubspotId: String(hubspotId) },
      {
        $set: {
          name: name == null ? null : String(name),
          price,
          siblingHubspotId: siblingHubspotId == null ? null : String(siblingHubspotId),
          siblingOdooId: siblingOdooId == null ? null : String(siblingOdooId),
          status: 'pending',
          requestedAt: at,
          archivedAt: null,
          error: null,
          dryRun,
          updatedAt: at
        },
        $setOnInsert: {
          hubspotId: String(hubspotId),
          createdAt: at
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    )
  }

  async markArchived({ hubspotId, now = () => new Date() } = {}) {
    const at = toDate(now())
    return this.archiveModel.findOneAndUpdate(
      { hubspotId: String(hubspotId) },
      { $set: { status: 'archived', archivedAt: at, error: null, updatedAt: at } }
    )
  }

  async markArchiveFailed({ hubspotId, error = null, now = () => new Date() } = {}) {
    const at = toDate(now())
    return this.archiveModel.findOneAndUpdate(
      { hubspotId: String(hubspotId) },
      { $set: { status: 'failed', error: error == null ? null : String(error), updatedAt: at } }
    )
  }
}

function toDate(v) {
  if (v == null) return new Date()
  if (v instanceof Date) return v
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? new Date() : d
}

module.exports = { MongoProductOrphanRepository }
