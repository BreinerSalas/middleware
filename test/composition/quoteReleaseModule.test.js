import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createQuoteReleaseModule } = require('../../src/composition/quoteReleaseModule.js')
const { EvaluateQuoteReleaseUseCase } = require('../../src/core/application/use-cases/EvaluateQuoteReleaseUseCase.js')
const { TriggerQuoteReleaseUseCase } = require('../../src/core/application/use-cases/TriggerQuoteReleaseUseCase.js')
const { RevertQuoteReleaseOnCancellationUseCase } = require('../../src/core/application/use-cases/RevertQuoteReleaseOnCancellationUseCase.js')

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function makeTrackerRepository() {
  return { findByQuoteId: vi.fn(async () => null), save: vi.fn(async (t) => t) }
}

function makeEnqueueSyncJobUseCase() {
  return { execute: vi.fn(async () => ({ job: { _id: 'JOB-1' }, deduped: false })) }
}

function makeAuditTrail() {
  return { record: vi.fn(async (entry) => entry) }
}

describe('createQuoteReleaseModule', () => {
  it('requires trackerRepository', () => {
    expect(() => createQuoteReleaseModule({
      enqueueSyncJobUseCase: makeEnqueueSyncJobUseCase(),
      auditTrail: makeAuditTrail()
    })).toThrow('trackerRepository')
  })

  it('requires enqueueSyncJobUseCase', () => {
    expect(() => createQuoteReleaseModule({
      trackerRepository: makeTrackerRepository(),
      auditTrail: makeAuditTrail()
    })).toThrow('enqueueSyncJobUseCase')
  })

  it('returns evaluateQuoteRelease, triggerQuoteRelease and revertQuoteReleaseOnCancellation instances', () => {
    const trackerRepository = makeTrackerRepository()
    const enqueueSyncJobUseCase = makeEnqueueSyncJobUseCase()
    const auditTrail = makeAuditTrail()
    const logger = makeLogger()

    const module_ = createQuoteReleaseModule({ trackerRepository, enqueueSyncJobUseCase, auditTrail, logger })

    expect(module_.evaluateQuoteRelease).toBeInstanceOf(EvaluateQuoteReleaseUseCase)
    expect(module_.triggerQuoteRelease).toBeInstanceOf(TriggerQuoteReleaseUseCase)
    expect(module_.revertQuoteReleaseOnCancellation).toBeInstanceOf(RevertQuoteReleaseOnCancellationUseCase)
  })

  it('wires the same trackerRepository into evaluateQuoteRelease, triggerQuoteRelease and revertQuoteReleaseOnCancellation', () => {
    const trackerRepository = makeTrackerRepository()
    const enqueueSyncJobUseCase = makeEnqueueSyncJobUseCase()
    const auditTrail = makeAuditTrail()

    const { evaluateQuoteRelease, triggerQuoteRelease, revertQuoteReleaseOnCancellation } = createQuoteReleaseModule({
      trackerRepository, enqueueSyncJobUseCase, auditTrail
    })

    expect(evaluateQuoteRelease.trackerRepository).toBe(trackerRepository)
    expect(triggerQuoteRelease.trackerRepository).toBe(trackerRepository)
    expect(triggerQuoteRelease.evaluateQuoteRelease).toBe(evaluateQuoteRelease)
    expect(triggerQuoteRelease.enqueueSyncJobUseCase).toBe(enqueueSyncJobUseCase)
    expect(revertQuoteReleaseOnCancellation.trackerRepository).toBe(trackerRepository)
    expect(revertQuoteReleaseOnCancellation.auditTrail).toBe(auditTrail)
  })

  it('wires the logger into all three use cases when provided', () => {
    const logger = makeLogger()
    const { evaluateQuoteRelease, triggerQuoteRelease, revertQuoteReleaseOnCancellation } = createQuoteReleaseModule({
      trackerRepository: makeTrackerRepository(),
      enqueueSyncJobUseCase: makeEnqueueSyncJobUseCase(),
      auditTrail: makeAuditTrail(),
      logger
    })
    expect(evaluateQuoteRelease.logger).toBe(logger)
    expect(triggerQuoteRelease.logger).toBe(logger)
    expect(revertQuoteReleaseOnCancellation.logger).toBe(logger)
  })
})
