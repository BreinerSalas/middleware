'use strict'

const { Schema, model } = require('mongoose')
const { JOB_STATUS } = require('../../../config/constants')

const TERMINAL = [JOB_STATUS.COMPLETED, JOB_STATUS.SKIPPED, JOB_STATUS.DEAD_LETTER]

const JobSchema = new Schema({
  sourceId: { type: String, required: true, index: true },
  correlationId: { type: String, default: null, index: true },
  payload: { type: Schema.Types.Mixed, default: null },
  dedupeKey: { type: String, default: null, index: true },
  status: {
    type: String,
    enum: Object.values(JOB_STATUS),
    default: JOB_STATUS.PENDING,
    required: true,
    index: true
  },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 8 },
  nextRetryAt: { type: Date, default: null, index: true },
  lastError: { type: String, default: null },
  lastErrorStack: { type: String, default: null },
  completedAt: { type: Date, default: null },
  createdAt: { type: Date, default: () => new Date() },
  updatedAt: { type: Date, default: () => new Date() }
}, { versionKey: false })

JobSchema.index({ status: 1, nextRetryAt: 1 })
JobSchema.index(
  { completedAt: 1 },
  {
    expireAfterSeconds: 60 * 60 * 24 * 30,
    partialFilterExpression: { status: { $in: TERMINAL } }
  }
)

module.exports = { JobSchema, JobModel: model('Job', JobSchema) }
