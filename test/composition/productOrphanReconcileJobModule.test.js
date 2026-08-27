import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createProductOrphanReconcileJobModule } = require('../../src/composition/productOrphanReconcileJobModule.js')
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

function makeProductOrphanReconcileModule({
  run = async () => ({ scanned: 0, promoted: [], archived: [], quarantined: [] })
} = {}) {
  return { run: vi.fn(run) }
}

function makeJob(overrides = {}) {
  return { _id: 'JOB-1', sourceId: 'product-orphan-reconcile-loop', kind: JOB_KIND.PRODUCT_ORPHAN_RECONCILE, attempts: 1, maxAttempts: 8, ...overrides }
}

describe('productOrphanReconcileJobModule (sdd/hubspot-product-reverse-discovery, Phase 5)', () => {
  it('requires jobRepository', () => {
    expect(() => createProductOrphanReconcileJobModule({ productOrphanReconcileModule: makeProductOrphanReconcileModule() })).toThrow(/jobRepository/)
  })

  it('requires productOrphanReconcileModule', () => {
    expect(() => createProductOrphanReconcileJobModule({ jobRepository: makeJobRepository() })).toThrow(/productOrphanReconcileModule/)
  })

  it('processProductOrphanReconcileJob runs run() with the configured limit, marks the job completed, and schedules the next tick', async () => {
    let now = 1_000_000
    const jobRepository = makeJobRepository()
    const productOrphanReconcileModule = makeProductOrphanReconcileModule()
    const m = createProductOrphanReconcileJobModule({
      jobRepository, productOrphanReconcileModule, logger: makeLogger(), tickIntervalMs: 86_400_000, limit: 200, clock: () => now
    })
    await m.processProductOrphanReconcileJob(makeJob())
    expect(productOrphanReconcileModule.run).toHaveBeenCalledTimes(1)
    expect(productOrphanReconcileModule.run).toHaveBeenCalledWith({ limit: 200 })
    expect(jobRepository.markCompleted).toHaveBeenCalledWith('JOB-1', new Date(now))
    expect(jobRepository.markFailed).not.toHaveBeenCalled()
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
    const scheduled = jobRepository.create.mock.calls[0][0]
    expect(scheduled.kind).toBe(JOB_KIND.PRODUCT_ORPHAN_RECONCILE)
    expect(scheduled.sourceId).toBe('product-orphan-reconcile-loop')
    expect(scheduled.status).toBe(JOB_STATUS.RETRY_PENDING)
    expect(scheduled.nextRetryAt).toEqual(new Date(now + 86_400_000))
  })

  it('marks the job failed (retry_pending) when run() throws, but still schedules the next tick', async () => {
    const jobRepository = makeJobRepository()
    const productOrphanReconcileModule = makeProductOrphanReconcileModule({ run: async () => { throw new Error('hubspot unreachable') } })
    const m = createProductOrphanReconcileJobModule({
      jobRepository, productOrphanReconcileModule, logger: makeLogger(), tickIntervalMs: 86_400_000, clock: () => 1_000_000
    })
    await m.processProductOrphanReconcileJob(makeJob({ attempts: 1, maxAttempts: 8 }))
    expect(jobRepository.markCompleted).not.toHaveBeenCalled()
    expect(jobRepository.markFailed).toHaveBeenCalledTimes(1)
    const failArgs = jobRepository.markFailed.mock.calls[0][1]
    expect(failArgs.deadLetter).toBe(false)
    expect(failArgs.nextRetryAt).toBeInstanceOf(Date)
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
  })

  it('dead-letters when attempts already reached maxAttempts, but still schedules the next tick', async () => {
    const jobRepository = makeJobRepository()
    const productOrphanReconcileModule = makeProductOrphanReconcileModule({ run: async () => { throw new Error('hubspot unreachable') } })
    const m = createProductOrphanReconcileJobModule({
      jobRepository, productOrphanReconcileModule, logger: makeLogger(), tickIntervalMs: 86_400_000, clock: () => 1_000_000
    })
    await m.processProductOrphanReconcileJob(makeJob({ attempts: 8, maxAttempts: 8 }))
    const failArgs = jobRepository.markFailed.mock.calls[0][1]
    expect(failArgs.deadLetter).toBe(true)
    expect(failArgs.nextRetryAt).toBeNull()
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
  })

  it('ensureSeeded schedules a tick when no active product_orphan_reconcile job exists', async () => {
    const jobRepository = makeJobRepository({ existsActive: false })
    const m = createProductOrphanReconcileJobModule({ jobRepository, productOrphanReconcileModule: makeProductOrphanReconcileModule(), logger: makeLogger(), clock: () => 5000 })
    const seeded = await m.ensureSeeded()
    expect(seeded).toBe(true)
    expect(jobRepository.existsActive).toHaveBeenCalledWith({ kind: JOB_KIND.PRODUCT_ORPHAN_RECONCILE })
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
  })

  it('ensureSeeded does nothing when an active product_orphan_reconcile job already exists', async () => {
    const jobRepository = makeJobRepository({ existsActive: true })
    const m = createProductOrphanReconcileJobModule({ jobRepository, productOrphanReconcileModule: makeProductOrphanReconcileModule(), logger: makeLogger() })
    const seeded = await m.ensureSeeded()
    expect(seeded).toBe(false)
    expect(jobRepository.create).not.toHaveBeenCalled()
  })

  it('startWorker seeds then starts the poller; stopWorker stops it', async () => {
    const jobRepository = makeJobRepository({ existsActive: false })
    const poller = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const m = createProductOrphanReconcileJobModule({ jobRepository, productOrphanReconcileModule: makeProductOrphanReconcileModule(), logger: makeLogger(), jobPoller: poller })
    await m.startWorker()
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
    expect(poller.start).toHaveBeenCalledTimes(1)
    await m.stopWorker()
    expect(poller.stop).toHaveBeenCalledTimes(1)
  })

  it('defaults the per-tick limit to 200 when not provided', async () => {
    const jobRepository = makeJobRepository()
    const productOrphanReconcileModule = makeProductOrphanReconcileModule()
    const m = createProductOrphanReconcileJobModule({
      jobRepository, productOrphanReconcileModule, logger: makeLogger(), tickIntervalMs: 86_400_000, clock: () => 1_000_000
    })
    await m.processProductOrphanReconcileJob(makeJob())
    expect(productOrphanReconcileModule.run).toHaveBeenCalledWith({ limit: 200 })
  })
})
