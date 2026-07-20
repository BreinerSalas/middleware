import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { SyncJob, JOB_STATUS } = require('../../src/core/domain/SyncJob.js')
const { SkipSyncError } = require('../../src/core/domain/errors.js')

describe('SyncJob (extended)', () => {
  it('markProcessing is idempotent while already PROCESSING', () => {
    const j = new SyncJob({ sourceId: 'D-1' }).markProcessing()
    const attemptsBefore = j.attempts
    const updated = j.markProcessing()
    expect(updated).toBe(j)
    expect(j.attempts).toBe(attemptsBefore)
  })

  it('markSkipped accepts a SkipSyncError instance directly', () => {
    const j = new SyncJob({ sourceId: 'D-1' }).markProcessing()
    const reason = new SkipSyncError('no line items')
    j.markSkipped(reason)
    expect(j.status).toBe(JOB_STATUS.SKIPPED)
    expect(j.lastError).toBe('no line items')
    expect(j.lastErrorStack).toBeTruthy()
  })

  it('markSkipped with non-Error reason sets String lastError', () => {
    const j = new SyncJob({ sourceId: 'D-1' }).markProcessing()
    j.markSkipped('plain string reason')
    expect(j.lastError).toBe('plain string reason')
    // Reason gets wrapped in SkipSyncError internally; stack is captured.
    expect(j.lastErrorStack).toBeTruthy()
  })

  it('toJSON includes all fields', () => {
    const j = new SyncJob({ sourceId: 'D-1', correlationId: 'c-1', payload: { x: 1 }, dedupeKey: 'k' })
    const obj = j.toJSON()
    expect(obj.sourceId).toBe('D-1')
    expect(obj.correlationId).toBe('c-1')
    expect(obj.payload).toEqual({ x: 1 })
    expect(obj.dedupeKey).toBe('k')
  })

  it('cannot markProcessing from SKIPPED', () => {
    const j = new SyncJob({ sourceId: 'D-1' }).markProcessing()
    j.markSkipped('x')
    expect(() => j.markProcessing()).toThrow(/terminal/)
  })

  it('cannot markProcessing from DEAD_LETTER', () => {
    const j = new SyncJob({ sourceId: 'D-1' }).markProcessing()
    j.markFailed({ deadLetter: true })
    expect(() => j.markProcessing()).toThrow(/terminal/)
  })
})

