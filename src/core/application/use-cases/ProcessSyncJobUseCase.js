'use strict'

const { JOB_STATUS } = require('../../domain/SyncJob')
const { calculateNextRetry, isRetryableError, shouldDeadLetter } = require('../../domain/RetryPolicy')
const { SkipSyncError } = require('../../domain/errors')

class ProcessSyncJobUseCase {
  constructor({
    jobRepository,
    mappingRepository,
    sourceGateway,
    targetGateway,
    auditTrail,
    retryPolicy = {},
    validators = [],
    logger = null
  } = {}) {
    if (!jobRepository) throw new Error('ProcessSyncJobUseCase requires jobRepository')
    if (!mappingRepository) throw new Error('ProcessSyncJobUseCase requires mappingRepository')
    if (!sourceGateway) throw new Error('ProcessSyncJobUseCase requires sourceGateway')
    if (!targetGateway) throw new Error('ProcessSyncJobUseCase requires targetGateway')
    if (!auditTrail) throw new Error('ProcessSyncJobUseCase requires auditTrail')
    this.jobRepository = jobRepository
    this.mappingRepository = mappingRepository
    this.sourceGateway = sourceGateway
    this.targetGateway = targetGateway
    this.auditTrail = auditTrail
    this.validators = Array.isArray(validators) ? validators : [validators]
    this.logger = logger
    this.retryPolicy = {
      baseMs: retryPolicy.baseMs ?? 1000,
      maxDelayMs: retryPolicy.maxDelayMs ?? 300000,
      jitter: retryPolicy.jitter ?? true,
      isRetryable: retryPolicy.isRetryable ?? isRetryableError,
      hashPayload: retryPolicy.hashPayload,
      buildWriteBackPayload: retryPolicy.buildWriteBackPayload
    }
  }

  async audit(entry) {
    try {
      await this.auditTrail.record(entry)
    } catch (err) {
      if (this.logger) this.logger.warn('auditTrail.record failed', { event: entry.event, error: err.message })
    }
  }

  async execute({ job }) {
    if (!job || !job._id) throw new Error('ProcessSyncJobUseCase requires a persisted job')
    const { _id: jobId, sourceId, correlationId, attempts: priorAttempts, maxAttempts } = job
    const log = (msg, extra = {}) => this.logger && this.logger.info(msg, { jobId, sourceId, ...extra })

    try {
      await this.audit({ jobId, sourceId, correlationId, event: 'job.processing.start', success: true })
      log('job.processing.start')

      const record = await this.sourceGateway.fetchRecord(sourceId)
      await this.audit({ jobId, sourceId, correlationId, event: 'source.fetched', success: true, detail: { recordId: record && record.id } })

      const references = await this.sourceGateway.resolveReferences(record) || {}
      await this.audit({ jobId, sourceId, correlationId, event: 'source.references.resolved', success: true, detail: Object.keys(references) })

      for (const validator of this.validators) {
        if (typeof validator !== 'function') continue
        const result = validator({ record, references, job })
        if (result && typeof result.then === 'function') await result
      }
      await this.audit({ jobId, sourceId, correlationId, event: 'validators.passed', success: true })

      const existingMapping = await this.mappingRepository.findBySourceId(sourceId)
      const upsertResult = await this.targetGateway.upsert({
        existingTargetId: existingMapping ? existingMapping.targetId : null,
        record,
        references,
        correlationId
      })
      await this.audit({
        jobId, sourceId, correlationId,
        event: 'target.upserted', success: true,
        detail: {
          targetId: upsertResult.targetId,
          targetRef: upsertResult.targetRef,
          salesOrderId: upsertResult.salesOrderId || null,
          metadata: upsertResult.metadata || null
        }
      })

      const payloadHash = (this.retryPolicy.hashPayload && this.retryPolicy.hashPayload(record)) || null
      const mappingMetadata = { lastJobId: jobId, ...(upsertResult.metadata || {}) }
      if (upsertResult.salesOrderId) mappingMetadata.salesOrderId = upsertResult.salesOrderId
      const mapping = await this.mappingRepository.upsert({
        sourceId,
        targetId: upsertResult.targetId,
        targetRef: upsertResult.targetRef,
        payloadHash,
        metadata: mappingMetadata
      })
      await this.audit({ jobId, sourceId, correlationId, event: 'mapping.upserted', success: true, detail: { targetId: mapping.targetId } })

      await this.sourceGateway.writeBack(sourceId, this.buildWriteBackPayload(mapping))
      await this.audit({ jobId, sourceId, correlationId, event: 'source.writeback.done', success: true })

      const updated = await this.jobRepository.markCompleted(jobId)
      await this.audit({ jobId, sourceId, correlationId, event: 'job.completed', success: true })
      return { job: updated, result: upsertResult, mapping }
    } catch (err) {
      return await this.handleError({ job, jobId, sourceId, correlationId, err, priorAttempts, maxAttempts })
    }
  }

  buildWriteBackPayload(mapping) {
    if (typeof this.retryPolicy.buildWriteBackPayload === 'function') {
      return this.retryPolicy.buildWriteBackPayload(mapping)
    }
    return { id_presupuesto_odoo: mapping && mapping.targetRef ? mapping.targetRef : null }
  }

  async handleError({ job, jobId, sourceId, correlationId, err, priorAttempts, maxAttempts }) {
    if (err instanceof SkipSyncError) {
      const updated = await this.jobRepository.markSkipped(jobId, err)
      await this.audit({
        jobId,
        sourceId,
        correlationId,
        event: 'job.skipped',
        success: false,
        detail: { reason: err.reason || err.message, skipDetail: err.detail || null }
      })
      return { job: updated, skipped: true, error: err }
    }

    const attempts = (priorAttempts || 0)
    const retryable = this.retryPolicy.isRetryable(err)
    const deadLetter = shouldDeadLetter({ attempts, maxAttempts, error: err }) || !retryable
    const nextRetryAt = deadLetter ? null : calculateNextRetry({
      attempts,
      baseMs: this.retryPolicy.baseMs,
      maxDelayMs: this.retryPolicy.maxDelayMs,
      jitter: this.retryPolicy.jitter
    })

    const updated = await this.jobRepository.markFailed(jobId, {
      error: err,
      nextRetryAt,
      deadLetter
    })
    await this.audit({
      jobId, sourceId, correlationId,
      event: deadLetter ? 'job.dead_letter' : 'job.retry_scheduled',
      success: false,
      detail: {
        attempts,
        retryable,
        nextRetryAt: nextRetryAt ? nextRetryAt.toISOString() : null,
        message: err && err.message,
        stack: err && err.stack
      }
    })
    return { job: updated, retryable, deadLetter, error: err }
  }
}

module.exports = { ProcessSyncJobUseCase }
