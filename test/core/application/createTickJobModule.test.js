import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const require = createRequire(import.meta.url)
const { JOB_STATUS } = require('../../../src/core/domain/SyncJob.js')

const factoryPath = resolve(__dirname, '../../../src/core/application/createTickJobModule.js')
const factorySource = readFileSync(factoryPath, 'utf8')
const { createTickJobModule: tickFactory } = require(factoryPath)
const buildTick = (args) => tickFactory(args)

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

function makeRun({ impl = async () => ({ created: 1, updated: 2 }) } = {}) {
  return vi.fn(impl)
}

function makeJob(overrides = {}) {
  return { _id: 'JOB-1', sourceId: 'fixture-loop', kind: 'fixture_kind', attempts: 1, maxAttempts: 8, ...overrides }
}

const REQUIRED = {
  kind: 'fixture_kind',
  seedSourceId: 'fixture-loop',
  run: makeRun(),
  logPrefix: 'fixture-job',
  jobRepository: makeJobRepository()
}

function makeFactoryArgs(overrides = {}) {
  return { ...REQUIRED, ...overrides }
}

describe('createTickJobModule', () => {
  it('requires kind', () => {
    const { kind, ...rest } = REQUIRED
    expect(() => buildTick(rest)).toThrow(/kind/)
  })

  it('requires seedSourceId', () => {
    const { seedSourceId, ...rest } = REQUIRED
    expect(() => buildTick(rest)).toThrow(/seedSourceId/)
  })

  it('requires run', () => {
    const { run, ...rest } = REQUIRED
    expect(() => buildTick(rest)).toThrow(/run/)
  })

  it('requires jobRepository', () => {
    const { jobRepository, ...rest } = REQUIRED
    expect(() => buildTick(rest)).toThrow(/jobRepository/)
  })

  it('requires logPrefix', () => {
    const { logPrefix, ...rest } = REQUIRED
    expect(() => buildTick(rest)).toThrow(/logPrefix/)
  })

  it('processTickJob seeds a job with the exact kind/sourceId and schedules on success', async () => {
    let now = 1_000_000
    const jobRepository = makeJobRepository()
    const run = makeRun()
    const logger = makeLogger()
    const tick = buildTick(makeFactoryArgs({
      kind: 'fixture_kind',
      seedSourceId: 'fixture-loop',
      run, jobRepository, logger, tickIntervalMs: 60_000, clock: () => now
    }))
    await tick.processTickJob(makeJob())
    expect(run).toHaveBeenCalledTimes(1)
    expect(jobRepository.markCompleted).toHaveBeenCalledWith('JOB-1', new Date(now))
    expect(jobRepository.markFailed).not.toHaveBeenCalled()
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
    const scheduled = jobRepository.create.mock.calls[0][0]
    expect(scheduled.kind).toBe('fixture_kind')
    expect(scheduled.sourceId).toBe('fixture-loop')
    expect(scheduled.status).toBe(JOB_STATUS.RETRY_PENDING)
    expect(scheduled.attempts).toBe(0)
    expect(scheduled.maxAttempts).toBe(Number.MAX_SAFE_INTEGER)
    expect(scheduled.nextRetryAt).toEqual(new Date(now + 60_000))
  })

  it('default buildTickLogDetail is a pass-through; success log uses it on ${logPrefix}.tick.completed', async () => {
    let now = 1_000_000
    const jobRepository = makeJobRepository()
    const run = makeRun({ impl: async () => ({ found: 3, stillPending: 1, extra: 'x' }) })
    const logger = makeLogger()
    const tick = buildTick(makeFactoryArgs({
      kind: 'fixture_kind',
      seedSourceId: 'fixture-loop',
      run, jobRepository, logger, tickIntervalMs: 60_000, clock: () => now
    }))
    await tick.processTickJob(makeJob())
    expect(logger.info).toHaveBeenCalledWith('fixture-job.tick.completed', { found: 3, stillPending: 1, extra: 'x' })
  })

  it('custom buildTickLogDetail projects result fields', async () => {
    let now = 1_000_000
    const jobRepository = makeJobRepository()
    const run = makeRun({ impl: async () => ({ created: 5, updated: 6, failed: 0, skipped: 0, archived: 0, cursorAdvanced: true }) })
    const logger = makeLogger()
    const tick = buildTick(makeFactoryArgs({
      kind: 'fixture_kind',
      seedSourceId: 'fixture-loop',
      run, jobRepository, logger, tickIntervalMs: 60_000, clock: () => now,
      buildTickLogDetail: (r) => ({ created: r.created, updated: r.updated, failed: r.failed })
    }))
    await tick.processTickJob(makeJob())
    expect(logger.info).toHaveBeenCalledWith('fixture-job.tick.completed', { created: 5, updated: 6, failed: 0 })
  })

  it('failure path marks failed (retry_pending) and routes through calculateNextRetry with baseMs:5000 and maxDelayMs:300000', async () => {
    const jobRepository = makeJobRepository()
    const run = makeRun({ impl: async () => { throw new Error('odoo unreachable') } })
    const logger = makeLogger()
    const tick = buildTick(makeFactoryArgs({
      kind: 'fixture_kind',
      seedSourceId: 'fixture-loop',
      run, jobRepository, logger, tickIntervalMs: 60_000, clock: () => 1_000_000
    }))
    await tick.processTickJob(makeJob({ attempts: 1, maxAttempts: 8 }))
    expect(jobRepository.markCompleted).not.toHaveBeenCalled()
    expect(jobRepository.markFailed).toHaveBeenCalledTimes(1)
    const failArgs = jobRepository.markFailed.mock.calls[0][1]
    expect(failArgs.deadLetter).toBe(false)
    expect(failArgs.nextRetryAt).toBeInstanceOf(Date)
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
  })

  it('dead-letters when attempts already reached maxAttempts', async () => {
    const jobRepository = makeJobRepository()
    const run = makeRun({ impl: async () => { throw new Error('odoo unreachable') } })
    const logger = makeLogger()
    const tick = buildTick(makeFactoryArgs({
      kind: 'fixture_kind',
      seedSourceId: 'fixture-loop',
      run, jobRepository, logger, tickIntervalMs: 60_000, clock: () => 1_000_000
    }))
    await tick.processTickJob(makeJob({ attempts: 8, maxAttempts: 8 }))
    const failArgs = jobRepository.markFailed.mock.calls[0][1]
    expect(failArgs.deadLetter).toBe(true)
    expect(failArgs.nextRetryAt).toBeNull()
  })

  it('finally reschedules on success, retry-pending failure, and dead-letter failure', async () => {
    const cases = [
      { label: 'success', attempts: 1, throws: false, expectedCreates: 1 },
      { label: 'retry-pending', attempts: 1, throws: true, expectedCreates: 1 },
      { label: 'dead-letter', attempts: 8, throws: true, expectedCreates: 1 }
    ]
    for (const c of cases) {
      const jobRepository = makeJobRepository()
      const run = makeRun({ impl: c.throws ? (async () => { throw new Error('odoo unreachable') }) : (async () => ({ ok: 1 })) })
      const logger = makeLogger()
      const tick = buildTick(makeFactoryArgs({
        kind: 'fixture_kind',
        seedSourceId: 'fixture-loop',
        run, jobRepository, logger, tickIntervalMs: 60_000, clock: () => 1_000_000
      }))
      await tick.processTickJob(makeJob({ attempts: c.attempts, maxAttempts: 8 }))
      expect(jobRepository.create).toHaveBeenCalledTimes(c.expectedCreates)
    }
  })

  it('ensureSeeded returns true and creates when existsActive is false', async () => {
    const jobRepository = makeJobRepository({ existsActive: false })
    const tick = buildTick(makeFactoryArgs({
      kind: 'fixture_kind', seedSourceId: 'fixture-loop',
      run: makeRun(), jobRepository, logger: makeLogger(), clock: () => 5_000
    }))
    const seeded = await tick.ensureSeeded()
    expect(seeded).toBe(true)
    expect(jobRepository.existsActive).toHaveBeenCalledWith({ kind: 'fixture_kind' })
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
  })

  it('ensureSeeded returns false and skips create when existsActive is true', async () => {
    const jobRepository = makeJobRepository({ existsActive: true })
    const tick = buildTick(makeFactoryArgs({
      kind: 'fixture_kind', seedSourceId: 'fixture-loop',
      run: makeRun(), jobRepository, logger: makeLogger()
    }))
    const seeded = await tick.ensureSeeded()
    expect(seeded).toBe(false)
    expect(jobRepository.create).not.toHaveBeenCalled()
  })

  it('uses default tickIntervalMs=60000 and orphanWatchdogMs=1800000 when not supplied', async () => {
    let now = 1_000_000
    const jobRepository = makeJobRepository()
    const run = makeRun()
    const tick = buildTick(makeFactoryArgs({
      kind: 'fixture_kind',
      seedSourceId: 'fixture-loop',
      run, jobRepository, logger: makeLogger(), clock: () => now
    }))
    await tick.processTickJob(makeJob())
    const scheduled = jobRepository.create.mock.calls[0][0]
    expect(scheduled.nextRetryAt).toEqual(new Date(now + 60_000))
    expect(tick._internals.jobPoller.orphanWatchdogMs).toBe(30 * 60 * 1000)
  })

  it('does not require config/constants in the factory module', () => {
    expect(factorySource).not.toMatch(/require\(['"]\.\.\/\.\.\/config\/constants['"]\)/)
    expect(factorySource).not.toMatch(/require\(['"]\.\.\/\.\.\/\.\.\/config\/constants['"]\)/)
  })

  it('exposes startWorker/stopWorker that drive the underlying JobPoller', async () => {
    const jobRepository = makeJobRepository({ existsActive: false })
    const poller = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const tick = buildTick(makeFactoryArgs({
      kind: 'fixture_kind', seedSourceId: 'fixture-loop',
      run: makeRun(), jobRepository, logger: makeLogger(), jobPoller: poller
    }))
    await tick.startWorker()
    expect(jobRepository.create).toHaveBeenCalledTimes(1)
    expect(poller.start).toHaveBeenCalledTimes(1)
    await tick.stopWorker()
    expect(poller.stop).toHaveBeenCalledTimes(1)
  })

  it('builds a JobPoller with kind and orphanWatchdogMs when no jobPoller is injected', () => {
    const jobRepository = makeJobRepository()
    const tick = buildTick(makeFactoryArgs({
      kind: 'fixture_kind', seedSourceId: 'fixture-loop',
      run: makeRun(), jobRepository, logger: makeLogger(), orphanWatchdogMs: 7777
    }))
    const poller = tick._internals.jobPoller
    expect(poller).toBeTruthy()
    expect(poller.kind).toBe('fixture_kind')
    expect(poller.orphanWatchdogMs).toBe(7777)
  })
})