'use strict'

const { JobModel } = require('./schemas/job.schema')
const { SyncJob, JOB_STATUS } = require('../../../core/domain/SyncJob')

function toDomain(doc) {
  if (!doc) return null
  const obj = doc.toObject ? doc.toObject() : doc
  return new SyncJob({
    _id: obj._id ? String(obj._id) : null,
    sourceId: obj.sourceId,
    correlationId: obj.correlationId,
    payload: obj.payload,
    dedupeKey: obj.dedupeKey,
    status: obj.status,
    attempts: obj.attempts,
    maxAttempts: obj.maxAttempts,
    nextRetryAt: obj.nextRetryAt,
    lastError: obj.lastError,
    lastErrorStack: obj.lastErrorStack,
    completedAt: obj.completedAt,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt
  })
}

class MongoJobRepository {
  constructor({ model = JobModel, logger = null } = {}) {
    this.model = model
    this.logger = logger
  }

  async create(job) {
    const doc = await this.model.create({
      sourceId: job.sourceId,
      correlationId: job.correlationId,
      payload: job.payload,
      dedupeKey: job.dedupeKey,
      status: job.status || JOB_STATUS.PENDING,
      attempts: job.attempts || 0,
      maxAttempts: job.maxAttempts,
      nextRetryAt: job.nextRetryAt,
      lastError: job.lastError,
      lastErrorStack: job.lastErrorStack,
      completedAt: job.completedAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    })
    return toDomain(doc)
  }

  async findById(id) {
    const doc = await this.model.findById(id)
    return toDomain(doc)
  }

  async findClaimable({ limit = 3, now = new Date() } = {}) {
    const claimed = []
    for (let i = 0; i < limit; i += 1) {
      const doc = await this.model.findOneAndUpdate(
        {
          status: { $in: [JOB_STATUS.PENDING, JOB_STATUS.RETRY_PENDING] },
          $or: [
            { nextRetryAt: null },
            { nextRetryAt: { $lte: now } }
          ]
        },
        {
          $set: { status: JOB_STATUS.PROCESSING, updatedAt: now },
          $inc: { attempts: 1 }
        },
        { sort: { createdAt: 1 }, new: true }
      )
      if (!doc) break
      claimed.push(toDomain(doc))
    }
    return claimed
  }

  async markCompleted(id, now = new Date()) {
    const doc = await this.model.findByIdAndUpdate(id, {
      $set: {
        status: JOB_STATUS.COMPLETED,
        completedAt: now,
        lastError: null,
        lastErrorStack: null,
        nextRetryAt: null,
        updatedAt: now
      }
    }, { new: true })
    return toDomain(doc)
  }

  async markSkipped(id, reason, now = new Date()) {
    const message = reason instanceof Error ? (reason.reason || reason.message) : String(reason)
    const stack = reason instanceof Error ? reason.stack : null
    const doc = await this.model.findByIdAndUpdate(id, {
      $set: {
        status: JOB_STATUS.SKIPPED,
        completedAt: now,
        lastError: message,
        lastErrorStack: stack,
        nextRetryAt: null,
        updatedAt: now
      }
    }, { new: true })
    return toDomain(doc)
  }

  async markFailed(id, { error, nextRetryAt = null, deadLetter = false, now = new Date() } = {}) {
    const message = error ? (error.message || String(error)) : 'Unknown error'
    const stack = error && error.stack ? error.stack : null
    const update = {
      status: deadLetter ? JOB_STATUS.DEAD_LETTER : JOB_STATUS.RETRY_PENDING,
      lastError: message,
      lastErrorStack: stack,
      nextRetryAt: deadLetter ? null : nextRetryAt,
      updatedAt: now
    }
    if (deadLetter) update.completedAt = now
    const doc = await this.model.findByIdAndUpdate(id, { $set: update }, { new: true })
    return toDomain(doc)
  }

  async recoverOrphans(now = new Date(), watchdogMs = 5 * 60 * 1000) {
    const cutoff = new Date(now.getTime() - watchdogMs)
    const result = await this.model.updateMany(
      { status: JOB_STATUS.PROCESSING, updatedAt: { $lt: cutoff } },
      { $set: { status: JOB_STATUS.PENDING, updatedAt: now } }
    )
    return result.modifiedCount || 0
  }
}

module.exports = { MongoJobRepository, toDomain }
