import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createPartnerSyncJobModule } = require('../../src/composition/partnerSyncJobModule.js')
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

function makePartnerSyncModule({
  runIncremental = async () => ({ created: 0, updated: 0, failed: 0, skipped: 0, archived: 0, cursorAdvanced: true })
} = {}) {
  return { runIncremental: vi.fn(runIncremental) }
}

function makeJob(overrides = {}) {
  return { _id: 'JOB-1', sourceId: 'partner-sync-loop', kind: JOB_KIND.PARTNER_SYNC, attempts: 1, maxAttempts: 8, ...overrides }
}

describe('partnerSyncJobModule', () => {
  it('requires jobRepository', () => {
    expect(() => createPartnerSyncJobModule({ partnerSyncModule: makePartnerSyncModule() })).toThrow(/jobRepository/)
  })

  it('requires partnerSyncModule', () => {
    expect(() => createPartnerSyncJobModule({ jobRepository: makeJobRepository() })).toThrow(/partnerSyncModule/)
  })

  it('processPartnerSyncJob runs runIncremental, marks the job completed, and schedules the next tick', async () => {
    let now = 1_000_000
    const jobRepository = makeJobRepository()
    const partnerSyncModule = makePartnerSyncModule()
    const m = createPartnerSyncJobModule({
      jobRepository, partnerSyncModule, logger: makeLogger(), tickIntervalMs: 60_000, clock: () => now
    })
    await m.processPartnerSyncJob(makeJob())
    expect(partnerSyncModule.runIncremental).toHaveBeenCalledTimes(1)
    expect(jobRepository.markCompleted).toHaveBeenCalledWith('JOB-1', new Date(now))
    expect(jobRepository.markFailed).not.toHaveBeenCalled()
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
    const scheduled = jobRepository.create.mock.calls[0][0]
    expect(scheduled.kind).toBe(JOB_KIND.PARTNER_SYNC)
    expect(scheduled.status).toBe(JOB_STATUS.RETRY_PENDING)
    expect(scheduled.nextRetryAt).toEqual(new Date(now + 60_000))
  })

  it('marks the job failed (retry_pending) when runIncremental throws, but still schedules the next tick', async () => {
    const jobRepository = makeJobRepository()
    const partnerSyncModule = makePartnerSyncModule({ runIncremental: async () => { throw new Error('odoo unreachable') } })
    const m = createPartnerSyncJobModule({
      jobRepository, partnerSyncModule, logger: makeLogger(), tickIntervalMs: 60_000, clock: () => 1_000_000
    })
    await m.processPartnerSyncJob(makeJob({ attempts: 1, maxAttempts: 8 }))
    expect(jobRepository.markCompleted).not.toHaveBeenCalled()
    expect(jobRepository.markFailed).toHaveBeenCalledTimes(1)
    const failArgs = jobRepository.markFailed.mock.calls[0][1]
    expect(failArgs.deadLetter).toBe(false)
    expect(failArgs.nextRetryAt).toBeInstanceOf(Date)
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
  })

  it('dead-letters when attempts already reached maxAttempts, but still schedules the next tick', async () => {
    const jobRepository = makeJobRepository()
    const partnerSyncModule = makePartnerSyncModule({ runIncremental: async () => { throw new Error('odoo unreachable') } })
    const m = createPartnerSyncJobModule({
      jobRepository, partnerSyncModule, logger: makeLogger(), tickIntervalMs: 60_000, clock: () => 1_000_000
    })
    await m.processPartnerSyncJob(makeJob({ attempts: 8, maxAttempts: 8 }))
    const failArgs = jobRepository.markFailed.mock.calls[0][1]
    expect(failArgs.deadLetter).toBe(true)
    expect(failArgs.nextRetryAt).toBeNull()
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
  })

  it('ensureSeeded schedules a tick when no active partner_sync job exists', async () => {
    const jobRepository = makeJobRepository({ existsActive: false })
    const m = createPartnerSyncJobModule({ jobRepository, partnerSyncModule: makePartnerSyncModule(), logger: makeLogger(), clock: () => 5000 })
    const seeded = await m.ensureSeeded()
    expect(seeded).toBe(true)
    expect(jobRepository.existsActive).toHaveBeenCalledWith({ kind: JOB_KIND.PARTNER_SYNC })
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
  })

  it('ensureSeeded does nothing when an active partner_sync job already exists', async () => {
    const jobRepository = makeJobRepository({ existsActive: true })
    const m = createPartnerSyncJobModule({ jobRepository, partnerSyncModule: makePartnerSyncModule(), logger: makeLogger() })
    const seeded = await m.ensureSeeded()
    expect(seeded).toBe(false)
    expect(jobRepository.create).not.toHaveBeenCalled()
  })

  it('startWorker seeds then starts the poller; stopWorker stops it', async () => {
    const jobRepository = makeJobRepository({ existsActive: false })
    const poller = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const m = createPartnerSyncJobModule({ jobRepository, partnerSyncModule: makePartnerSyncModule(), logger: makeLogger(), jobPoller: poller })
    await m.startWorker()
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
    expect(poller.start).toHaveBeenCalledTimes(1)
    await m.stopWorker()
    expect(poller.stop).toHaveBeenCalledTimes(1)
  })
})
