'use strict'

const { SkipSyncError } = require('./errors')

const JOB_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  RETRY_PENDING: 'RETRY_PENDING',
  COMPLETED: 'COMPLETED',
  SKIPPED: 'SKIPPED',
  DEAD_LETTER: 'DEAD_LETTER'
})

const TERMINAL_STATUSES = Object.freeze([JOB_STATUS.COMPLETED, JOB_STATUS.SKIPPED, JOB_STATUS.DEAD_LETTER])

class SyncJob {
  constructor({
    sourceId,
    correlationId = null,
    payload = null,
    dedupeKey = null,
    kind = 'deal',
    status = JOB_STATUS.PENDING,
    attempts = 0,
    maxAttempts = 8,
    nextRetryAt = null,
    lastError = null,
    lastErrorStack = null,
    completedAt = null,
    _id = null,
    createdAt = null,
    updatedAt = null
  } = {}) {
    if (!sourceId) throw new Error('SyncJob requires sourceId')
    this._id = _id
    this.sourceId = sourceId
    this.correlationId = correlationId
    this.payload = payload
    this.dedupeKey = dedupeKey
    this.kind = kind
    this.status = status
    this.attempts = attempts
    this.maxAttempts = maxAttempts
    this.nextRetryAt = nextRetryAt
    this.lastError = lastError
    this.lastErrorStack = lastErrorStack
    this.completedAt = completedAt
    this.createdAt = createdAt || new Date()
    this.updatedAt = updatedAt || new Date()
  }

  markProcessing(now = new Date()) {
    if (this.status === JOB_STATUS.PROCESSING) {
      this.updatedAt = now
      return this
    }
    if (TERMINAL_STATUSES.includes(this.status)) {
      throw new Error(`Cannot mark a terminal job (${this.status}) as PROCESSING`)
    }
    this.status = JOB_STATUS.PROCESSING
    this.attempts += 1
    this.updatedAt = now
    return this
  }

  markCompleted(now = new Date()) {
    this.status = JOB_STATUS.COMPLETED
    this.completedAt = now
    this.lastError = null
    this.lastErrorStack = null
    this.nextRetryAt = null
    this.updatedAt = now
    return this
  }

  markSkipped(reason, now = new Date()) {
    if (typeof reason === 'string') reason = new SkipSyncError(reason)
    this.status = JOB_STATUS.SKIPPED
    this.completedAt = now
    this.lastError = reason instanceof SkipSyncError ? (reason.reason || reason.message) : (reason && reason.message) || String(reason)
    this.lastErrorStack = reason instanceof Error ? reason.stack : null
    this.nextRetryAt = null
    this.updatedAt = now
    return this
  }

  markFailed({ error, nextRetryAt = null, deadLetter = false, now = new Date() } = {}) {
    this.lastError = error ? (error.message || String(error)) : 'Unknown error'
    this.lastErrorStack = error && error.stack ? error.stack : null
    this.updatedAt = now
    if (deadLetter) {
      this.status = JOB_STATUS.DEAD_LETTER
      this.completedAt = now
      this.nextRetryAt = null
    } else {
      this.status = JOB_STATUS.RETRY_PENDING
      this.nextRetryAt = nextRetryAt
    }
    return this
  }

  toJSON() {
    return {
      _id: this._id,
      sourceId: this.sourceId,
      correlationId: this.correlationId,
      payload: this.payload,
      dedupeKey: this.dedupeKey,
      kind: this.kind,
      status: this.status,
      attempts: this.attempts,
      maxAttempts: this.maxAttempts,
      nextRetryAt: this.nextRetryAt,
      lastError: this.lastError,
      lastErrorStack: this.lastErrorStack,
      completedAt: this.completedAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    }
  }
}

module.exports = { SyncJob, JOB_STATUS, TERMINAL_STATUSES }
