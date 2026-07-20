'use strict'

const { SyncJob, JOB_STATUS } = require('../../domain/SyncJob')
const { buildDedupeKey } = require('../../shared/hash')

class EnqueueSyncJobUseCase {
  constructor({ jobRepository, dedupeGuard, logger = null } = {}) {
    if (!jobRepository) throw new Error('EnqueueSyncJobUseCase requires jobRepository')
    if (!dedupeGuard) throw new Error('EnqueueSyncJobUseCase requires dedupeGuard')
    this.jobRepository = jobRepository
    this.dedupeGuard = dedupeGuard
    this.logger = logger
  }

  async execute({ sourceId, correlationId = null, rawPayload = null, maxAttempts = 8 } = {}) {
    if (!sourceId) throw new Error('sourceId required')
    const dedupeKey = buildDedupeKey({ sourceId, rawPayload })

    let duplicate = false
    try {
      duplicate = await this.dedupeGuard.isDuplicate(dedupeKey)
    } catch (err) {
      duplicate = false
      if (this.logger) this.logger.warn('dedupeGuard.isDuplicate failed; treating as not duplicate', { error: err.message })
    }
    if (duplicate) {
      if (this.logger) this.logger.info('sync job suppressed by dedupe', { sourceId, dedupeKey })
      return { job: null, deduped: true, dedupeKey }
    }

    const job = new SyncJob({
      sourceId,
      correlationId,
      payload: rawPayload,
      dedupeKey,
      status: JOB_STATUS.PENDING,
      attempts: 0,
      maxAttempts
    })
    const persisted = await this.jobRepository.create(job)
    try {
      await this.dedupeGuard.markSeen(dedupeKey)
    } catch (err) {
      if (this.logger) this.logger.warn('dedupeGuard.markSeen failed; continuing', { error: err.message })
    }
    if (this.logger) this.logger.info('sync job enqueued', { jobId: persisted._id, sourceId, dedupeKey })
    return { job: persisted, deduped: false, dedupeKey }
  }
}

module.exports = { EnqueueSyncJobUseCase }
