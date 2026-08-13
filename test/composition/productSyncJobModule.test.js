import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createProductSyncJobModule } = require('../../src/composition/productSyncJobModule.js')
const { JOB_STATUS } = require('../../src/core/domain/SyncJob.js')
const { JOB_KIND } = require('../../src/config/constants.js')

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function makeJobRepository({ existsActive = false } = {}) {
  return {
    create: vi.fn(async (doc) => ({ _id: 'NEXT-1', ...doc })),
    markCompleted: vi.fn(async () => null),
    markFailed: vi.fn(async () => null),
    existsActive: vi.fn(async () => existsActive)
  }
}

function makeProductSyncModule({ runIncremental = async () => ({ created: 0, updated: 0, failed: 0, skipped: 0, archived: 0, cursorAdvanced: true }) } = {}) {
  return { runIncremental: vi.fn(runIncremental) }
}

function makeJob(overrides = {}) {
  return { _id: 'JOB-1', sourceId: 'product-sync-loop', kind: JOB_KIND.PRODUCT_SYNC, attempts: 1, maxAttempts: 8, ...overrides }
}

describe('productSyncJobModule (Fase 3 — docs/plan-cambios-2026-08-05.md)', () => {
  it('requires jobRepository', () => {
    expect(() => createProductSyncJobModule({ productSyncModule: makeProductSyncModule() })).toThrow(/jobRepository/)
  })

  it('requires productSyncModule', () => {
    expect(() => createProductSyncJobModule({ jobRepository: makeJobRepository() })).toThrow(/productSyncModule/)
  })

  it('processProductSyncJob runs runIncremental, marks the job completed, and schedules the next tick', async () => {
    let now = 1_000_000
    const jobRepository = makeJobRepository()
    const productSyncModule = makeProductSyncModule()
    const m = createProductSyncJobModule({
      jobRepository, productSyncModule, logger: makeLogger(), tickIntervalMs: 60_000, clock: () => now
    })
    await m.processProductSyncJob(makeJob())
    expect(productSyncModule.runIncremental).toHaveBeenCalledTimes(1)
    expect(jobRepository.markCompleted).toHaveBeenCalledWith('JOB-1', new Date(now))
    expect(jobRepository.markFailed).not.toHaveBeenCalled()
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
    const scheduled = jobRepository.create.mock.calls[0][0]
    expect(scheduled.kind).toBe(JOB_KIND.PRODUCT_SYNC)
    expect(scheduled.sourceId).toBe('product-sync-loop')
    expect(scheduled.status).toBe(JOB_STATUS.RETRY_PENDING)
    expect(scheduled.nextRetryAt).toEqual(new Date(now + 60_000))
  })

  it('marks the job failed (retry_pending) when runIncremental throws, but still schedules the next tick', async () => {
    const jobRepository = makeJobRepository()
    const productSyncModule = makeProductSyncModule({ runIncremental: async () => { throw new Error('odoo unreachable') } })
    const m = createProductSyncJobModule({
      jobRepository, productSyncModule, logger: makeLogger(), tickIntervalMs: 60_000, clock: () => 1_000_000
    })
    await m.processProductSyncJob(makeJob({ attempts: 1, maxAttempts: 8 }))
    expect(jobRepository.markCompleted).not.toHaveBeenCalled()
    expect(jobRepository.markFailed).toHaveBeenCalledTimes(1)
    const failArgs = jobRepository.markFailed.mock.calls[0][1]
    expect(failArgs.deadLetter).toBe(false)
    expect(failArgs.nextRetryAt).toBeInstanceOf(Date)
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
  })

  it('dead-letters when attempts already reached maxAttempts, but still schedules the next tick', async () => {
    const jobRepository = makeJobRepository()
    const productSyncModule = makeProductSyncModule({ runIncremental: async () => { throw new Error('odoo unreachable') } })
    const m = createProductSyncJobModule({
      jobRepository, productSyncModule, logger: makeLogger(), tickIntervalMs: 60_000, clock: () => 1_000_000
    })
    await m.processProductSyncJob(makeJob({ attempts: 8, maxAttempts: 8 }))
    const failArgs = jobRepository.markFailed.mock.calls[0][1]
    expect(failArgs.deadLetter).toBe(true)
    expect(failArgs.nextRetryAt).toBeNull()
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
  })

  it('ensureSeeded schedules a tick when no active product_sync job exists', async () => {
    const jobRepository = makeJobRepository({ existsActive: false })
    const m = createProductSyncJobModule({ jobRepository, productSyncModule: makeProductSyncModule(), logger: makeLogger(), clock: () => 5000 })
    const seeded = await m.ensureSeeded()
    expect(seeded).toBe(true)
    expect(jobRepository.existsActive).toHaveBeenCalledWith({ kind: JOB_KIND.PRODUCT_SYNC })
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
  })

  it('ensureSeeded does nothing when an active product_sync job already exists', async () => {
    const jobRepository = makeJobRepository({ existsActive: true })
    const m = createProductSyncJobModule({ jobRepository, productSyncModule: makeProductSyncModule(), logger: makeLogger() })
    const seeded = await m.ensureSeeded()
    expect(seeded).toBe(false)
    expect(jobRepository.create).not.toHaveBeenCalled()
  })

  it('startWorker seeds then starts the poller; stopWorker stops it', async () => {
    const jobRepository = makeJobRepository({ existsActive: false })
    const poller = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const m = createProductSyncJobModule({ jobRepository, productSyncModule: makeProductSyncModule(), logger: makeLogger(), jobPoller: poller })
    await m.startWorker()
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
    expect(poller.start).toHaveBeenCalledTimes(1)
    await m.stopWorker()
    expect(poller.stop).toHaveBeenCalledTimes(1)
  })
})
