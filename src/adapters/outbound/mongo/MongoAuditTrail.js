'use strict'

const { AuditModel } = require('./schemas/audit.schema')
const { SyncAuditEntry } = require('../../../core/domain/SyncAuditEntry')

class MongoAuditTrail {
  constructor({ model = AuditModel } = {}) { this.model = model }

  async record(entry) {
    const e = entry instanceof SyncAuditEntry ? entry : new SyncAuditEntry(entry)
    const doc = await this.model.create({
      jobId: e.jobId ? String(e.jobId) : null,
      sourceId: e.sourceId,
      correlationId: e.correlationId,
      event: e.event,
      detail: e.detail,
      success: e.success,
      createdAt: e.createdAt || new Date()
    })
    return new SyncAuditEntry({
      _id: String(doc._id),
      jobId: e.jobId,
      sourceId: doc.sourceId,
      correlationId: doc.correlationId,
      event: doc.event,
      detail: doc.detail,
      success: doc.success,
      createdAt: doc.createdAt
    })
  }
}

module.exports = { MongoAuditTrail }
