'use strict'

const { PartnerSyncRunModel } = require('./schemas/partnerSyncRun.schema')

function toDate(v) {
  if (v == null) return new Date()
  if (v instanceof Date) return v
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? new Date() : d
}

class MongoPartnerSyncRunRepository {
  constructor({ model = PartnerSyncRunModel, logger = null } = {}) {
    this.model = model
    this.logger = logger
  }

  async start({ total = 0, dryRun = false, now = () => new Date() } = {}) {
    const at = toDate(now())
    return this.model.create({
      startedAt: at,
      status: 'running',
      total,
      dryRun
    })
  }

  async complete({
    runId,
    created = 0,
    updated = 0,
    skipped = 0,
    failed = 0,
    archived = 0,
    status = 'completed',
    now = () => new Date()
  } = {}) {
    const at = toDate(now())
    return this.model.findByIdAndUpdate(
      runId,
      {
        $set: {
          endedAt: at,
          status,
          created,
          updated,
          skipped,
          failed,
          archived,
          updatedAt: at
        }
      },
      { new: true }
    )
  }

  async listRecent({ limit = 10 } = {}) {
    return this.model.find({}).sort({ startedAt: -1 }).limit(limit).lean()
  }
}

module.exports = { MongoPartnerSyncRunRepository }
