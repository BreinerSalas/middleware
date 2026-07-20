'use strict'

class SyncAuditEntry {
  constructor({ jobId = null, sourceId, correlationId = null, event, detail = null, success = true, createdAt = new Date(), _id = null } = {}) {
    if (!sourceId) throw new Error('SyncAuditEntry requires sourceId')
    if (!event) throw new Error('SyncAuditEntry requires event')
    this._id = _id
    this.jobId = jobId
    this.sourceId = sourceId
    this.correlationId = correlationId
    this.event = event
    this.detail = detail
    this.success = !!success
    this.createdAt = createdAt
    Object.freeze(this)
  }

  toJSON() {
    return {
      _id: this._id,
      jobId: this.jobId,
      sourceId: this.sourceId,
      correlationId: this.correlationId,
      event: this.event,
      detail: this.detail,
      success: this.success,
      createdAt: this.createdAt
    }
  }
}

module.exports = { SyncAuditEntry }
