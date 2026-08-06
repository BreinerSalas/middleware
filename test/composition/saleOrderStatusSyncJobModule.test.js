import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createSaleOrderStatusSyncJobModule } = require('../../src/composition/saleOrderStatusSyncJobModule.js')
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

function makeSaleOrderStatusSyncModule({ runIncremental = async () => ({ updated: 0, unmapped: 0, failed: 0, cursorAdvanced: true }) } = {}) {
  return { runIncremental: vi.fn(runIncremental) }
}

function makeJob(overrides = {}) {
  return { _id: 'JOB-1', sourceId: 'sale-order-status-sync-loop', kind: JOB_KIND.SALE_ORDER_STATUS_SYNC, attempts: 1, maxAttempts: 8, ...overrides }
}

describe('saleOrderStatusSyncJobModule (Fase 6 — docs/plan-cambios-2026-08-05.md)', () => {
  it('requires jobRepository', () => {
    expect(() => createSaleOrderStatusSyncJobModule({ saleOrderStatusSyncModule: makeSaleOrderStatusSyncModule() })).toThrow(/jobRepository/)
  })

  it('requires saleOrderStatusSyncModule', () => {
    expect(() => createSaleOrderStatusSyncJobModule({ jobRepository: makeJobRepository() })).toThrow(/saleOrderStatusSyncModule/)
  })

  it('processSaleOrderStatusSyncJob runs runIncremental, marks the job completed, and schedules the next tick', async () => {
    let now = 1_000_000
    const jobRepository = makeJobRepository()
    const saleOrderStatusSyncModule = makeSaleOrderStatusSyncModule()
    const m = createSaleOrderStatusSyncJobModule({
      jobRepository, saleOrderStatusSyncModule, logger: makeLogger(), tickIntervalMs: 60_000, clock: () => now
    })
    await m.processSaleOrderStatusSyncJob(makeJob())
    expect(saleOrderStatusSyncModule.runIncremental).toHaveBeenCalledTimes(1)
    expect(jobRepository.markCompleted).toHaveBeenCalledWith('JOB-1', new Date(now))
    expect(jobRepository.markFailed).not.toHaveBeenCalled()
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
    const scheduled = jobRepository.create.mock.calls[0][0]
    expect(scheduled.kind).toBe(JOB_KIND.SALE_ORDER_STATUS_SYNC)
    expect(scheduled.status).toBe(JOB_STATUS.RETRY_PENDING)
    expect(scheduled.nextRetryAt).toEqual(new Date(now + 60_000))
  })

  it('marks the job failed (retry_pending) when runIncremental throws, but still schedules the next tick', async () => {
    const jobRepository = makeJobRepository()
    const saleOrderStatusSyncModule = makeSaleOrderStatusSyncModule({ runIncremental: async () => { throw new Error('odoo unreachable') } })
    const m = createSaleOrderStatusSyncJobModule({
      jobRepository, saleOrderStatusSyncModule, logger: makeLogger(), tickIntervalMs: 60_000, clock: () => 1_000_000
    })
    await m.processSaleOrderStatusSyncJob(makeJob({ attempts: 1, maxAttempts: 8 }))
    expect(jobRepository.markCompleted).not.toHaveBeenCalled()
    expect(jobRepository.markFailed).toHaveBeenCalledTimes(1)
    const failArgs = jobRepository.markFailed.mock.calls[0][1]
    expect(failArgs.deadLetter).toBe(false)
    expect(failArgs.nextRetryAt).toBeInstanceOf(Date)
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
  })

  it('ensureSeeded schedules a tick when no active sale_order_status_sync job exists', async () => {
    const jobRepository = makeJobRepository({ existsActive: false })
    const m = createSaleOrderStatusSyncJobModule({ jobRepository, saleOrderStatusSyncModule: makeSaleOrderStatusSyncModule(), logger: makeLogger(), clock: () => 5000 })
    const seeded = await m.ensureSeeded()
    expect(seeded).toBe(true)
    expect(jobRepository.existsActive).toHaveBeenCalledWith({ kind: JOB_KIND.SALE_ORDER_STATUS_SYNC })
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
  })

  it('ensureSeeded does nothing when an active sale_order_status_sync job already exists', async () => {
    const jobRepository = makeJobRepository({ existsActive: true })
    const m = createSaleOrderStatusSyncJobModule({ jobRepository, saleOrderStatusSyncModule: makeSaleOrderStatusSyncModule(), logger: makeLogger() })
    const seeded = await m.ensureSeeded()
    expect(seeded).toBe(false)
    expect(jobRepository.create).not.toHaveBeenCalled()
  })

  it('startWorker seeds then starts the poller; stopWorker stops it', async () => {
    const jobRepository = makeJobRepository({ existsActive: false })
    const poller = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const m = createSaleOrderStatusSyncJobModule({ jobRepository, saleOrderStatusSyncModule: makeSaleOrderStatusSyncModule(), logger: makeLogger(), jobPoller: poller })
    await m.startWorker()
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
    expect(poller.start).toHaveBeenCalledTimes(1)
    await m.stopWorker()
    expect(poller.stop).toHaveBeenCalledTimes(1)
  })
})
