import { describe, it, expect } from 'vitest'
import { SyncJob, JOB_STATUS } from '../../src/core/domain/SyncJob.js'
import { SkipSyncError } from '../../src/core/domain/errors.js'

describe('SyncJob', () => {
  it('requires sourceId', () => {
    expect(() => new SyncJob({})).toThrow(/requires sourceId/)
  })

  it('initializes with defaults', () => {
    const j = new SyncJob({ sourceId: 'D-1' })
    expect(j.status).toBe(JOB_STATUS.PENDING)
    expect(j.attempts).toBe(0)
    expect(j.maxAttempts).toBe(8)
    expect(j.createdAt).toBeInstanceOf(Date)
  })

  it('markProcessing increments attempts and sets status', () => {
    const j = new SyncJob({ sourceId: 'D-1' })
    j.markProcessing()
    expect(j.status).toBe(JOB_STATUS.PROCESSING)
    expect(j.attempts).toBe(1)
    // re-marking while already PROCESSING is idempotent (no double increment)
    j.markProcessing()
    expect(j.attempts).toBe(1)
  })

  it('markCompleted sets terminal state', () => {
    const j = new SyncJob({ sourceId: 'D-1' }).markProcessing()
    j.markCompleted()
    expect(j.status).toBe(JOB_STATUS.COMPLETED)
    expect(j.completedAt).toBeInstanceOf(Date)
    expect(j.lastError).toBeNull()
  })

  it('markSkipped stores reason string', () => {
    const j = new SyncJob({ sourceId: 'D-1' }).markProcessing()
    j.markSkipped(new SkipSyncError('no items'))
    expect(j.status).toBe(JOB_STATUS.SKIPPED)
    expect(j.lastError).toBe('no items')
    expect(j.completedAt).toBeInstanceOf(Date)
  })

  it('cannot markProcessing from terminal state', () => {
    const j = new SyncJob({ sourceId: 'D-1' }).markProcessing().markCompleted()
    expect(() => j.markProcessing()).toThrow(/terminal/)
  })

  it('markFailed retries with nextRetryAt', () => {
    const j = new SyncJob({ sourceId: 'D-1' }).markProcessing()
    const when = new Date()
    j.markFailed({ error: new Error('boom'), nextRetryAt: when, deadLetter: false })
    expect(j.status).toBe(JOB_STATUS.RETRY_PENDING)
    expect(j.nextRetryAt).toBe(when)
    expect(j.lastError).toBe('boom')
  })

  it('markFailed deadLetter sets completedAt and clears nextRetryAt', () => {
    const j = new SyncJob({ sourceId: 'D-1' }).markProcessing()
    j.markFailed({ error: new Error('fatal'), deadLetter: true })
    expect(j.status).toBe(JOB_STATUS.DEAD_LETTER)
    expect(j.completedAt).toBeInstanceOf(Date)
    expect(j.nextRetryAt).toBeNull()
  })
})
