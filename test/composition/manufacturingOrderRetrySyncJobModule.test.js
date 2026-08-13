import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createManufacturingOrderRetrySyncJobModule } = require('../../src/composition/manufacturingOrderRetrySyncJobModule.js')
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

function makeManufacturingOrderRetrySyncModule({ runOnce = async () => ({ found: 0, stillPending: 0, failed: 0 }) } = {}) {
  return { runOnce: vi.fn(runOnce) }
}

function makeJob(overrides = {}) {
  return { _id: 'JOB-1', sourceId: 'manufacturing-order-retry-sync-loop', kind: JOB_KIND.MANUFACTURING_ORDER_RETRY_SYNC, attempts: 1, maxAttempts: 8, ...overrides }
}

describe('manufacturingOrderRetrySyncJobModule (Fase 6 — brecha de MO tardía)', () => {
  it('requires jobRepository', () => {
    expect(() => createManufacturingOrderRetrySyncJobModule({ manufacturingOrderRetrySyncModule: makeManufacturingOrderRetrySyncModule() })).toThrow(/jobRepository/)
  })

  it('requires manufacturingOrderRetrySyncModule', () => {
    expect(() => createManufacturingOrderRetrySyncJobModule({ jobRepository: makeJobRepository() })).toThrow(/manufacturingOrderRetrySyncModule/)
  })

  it('processManufacturingOrderRetrySyncJob runs runOnce, marks the job completed, and schedules the next tick', async () => {
    let now = 1_000_000
    const jobRepository = makeJobRepository()
    const manufacturingOrderRetrySyncModule = makeManufacturingOrderRetrySyncModule()
    const m = createManufacturingOrderRetrySyncJobModule({
      jobRepository, manufacturingOrderRetrySyncModule, logger: makeLogger(), tickIntervalMs: 60_000, clock: () => now
    })
    await m.processManufacturingOrderRetrySyncJob(makeJob())
    expect(manufacturingOrderRetrySyncModule.runOnce).toHaveBeenCalledTimes(1)
    expect(jobRepository.markCompleted).toHaveBeenCalledWith('JOB-1', new Date(now))
    expect(jobRepository.markFailed).not.toHaveBeenCalled()
    const scheduled = jobRepository.create.mock.calls[0][0]
    expect(scheduled.kind).toBe(JOB_KIND.MANUFACTURING_ORDER_RETRY_SYNC)
    expect(scheduled.sourceId).toBe('manufacturing-order-retry-sync-loop')
    expect(scheduled.status).toBe(JOB_STATUS.RETRY_PENDING)
    expect(scheduled.nextRetryAt).toEqual(new Date(now + 60_000))
  })

  it('marks the job failed (retry_pending) when runOnce throws, but still schedules the next tick', async () => {
    const jobRepository = makeJobRepository()
    const manufacturingOrderRetrySyncModule = makeManufacturingOrderRetrySyncModule({ runOnce: async () => { throw new Error('odoo unreachable') } })
    const m = createManufacturingOrderRetrySyncJobModule({
      jobRepository, manufacturingOrderRetrySyncModule, logger: makeLogger(), tickIntervalMs: 60_000, clock: () => 1_000_000
    })
    await m.processManufacturingOrderRetrySyncJob(makeJob({ attempts: 1, maxAttempts: 8 }))
    expect(jobRepository.markCompleted).not.toHaveBeenCalled()
    expect(jobRepository.markFailed).toHaveBeenCalledTimes(1)
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
  })

  it('ensureSeeded schedules a tick when no active manufacturing_order_retry_sync job exists', async () => {
    const jobRepository = makeJobRepository({ existsActive: false })
    const m = createManufacturingOrderRetrySyncJobModule({ jobRepository, manufacturingOrderRetrySyncModule: makeManufacturingOrderRetrySyncModule(), logger: makeLogger(), clock: () => 5000 })
    const seeded = await m.ensureSeeded()
    expect(seeded).toBe(true)
    expect(jobRepository.existsActive).toHaveBeenCalledWith({ kind: JOB_KIND.MANUFACTURING_ORDER_RETRY_SYNC })
  })

  it('ensureSeeded does nothing when an active job already exists', async () => {
    const jobRepository = makeJobRepository({ existsActive: true })
    const m = createManufacturingOrderRetrySyncJobModule({ jobRepository, manufacturingOrderRetrySyncModule: makeManufacturingOrderRetrySyncModule(), logger: makeLogger() })
    const seeded = await m.ensureSeeded()
    expect(seeded).toBe(false)
    expect(jobRepository.create).not.toHaveBeenCalled()
  })

  it('startWorker seeds then starts the poller; stopWorker stops it', async () => {
    const jobRepository = makeJobRepository({ existsActive: false })
    const poller = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const m = createManufacturingOrderRetrySyncJobModule({ jobRepository, manufacturingOrderRetrySyncModule: makeManufacturingOrderRetrySyncModule(), logger: makeLogger(), jobPoller: poller })
    await m.startWorker()
    expect(poller.start).toHaveBeenCalledTimes(1)
    await m.stopWorker()
    expect(poller.stop).toHaveBeenCalledTimes(1)
  })
})
