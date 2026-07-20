import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { MongoMemoryServer } = require('mongodb-memory-server')
const mongoose = require('mongoose')

const { MongoJobRepository } = require('../../../src/adapters/outbound/mongo/MongoJobRepository.js')
const { JOB_STATUS } = require('../../../src/core/domain/SyncJob.js')

let mongoServer
let repo

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create()
  await mongoose.connect(mongoServer.getUri())
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  if (mongoServer) await mongoServer.stop()
}, 60_000)

beforeEach(async () => {
  const collections = await mongoose.connection.db.collections()
  await Promise.all(collections.map((c) => c.deleteMany({})))
  repo = new MongoJobRepository()
})

describe('MongoJobRepository', () => {
  it('creates a pending job and assigns id', async () => {
    const job = await repo.create({
      sourceId: 'D-1',
      correlationId: 'c-1',
      payload: { x: 1 },
      dedupeKey: 'k1',
      status: JOB_STATUS.PENDING,
      attempts: 0,
      maxAttempts: 8
    })
    expect(job._id).toBeTruthy()
    expect(job.sourceId).toBe('D-1')
    expect(job.status).toBe(JOB_STATUS.PENDING)
  })

  it('findClaimable only returns PENDING or RETRY_PENDING with nextRetryAt <= now', async () => {
    await repo.create({ sourceId: 'D-1', status: JOB_STATUS.PENDING, attempts: 0, maxAttempts: 8, payload: null, dedupeKey: null })
    await repo.create({ sourceId: 'D-2', status: JOB_STATUS.RETRY_PENDING, attempts: 1, maxAttempts: 8, nextRetryAt: new Date(Date.now() + 60_000), payload: null, dedupeKey: null })
    await repo.create({ sourceId: 'D-3', status: JOB_STATUS.RETRY_PENDING, attempts: 1, maxAttempts: 8, nextRetryAt: new Date(Date.now() - 60_000), payload: null, dedupeKey: null })
    await repo.create({ sourceId: 'D-4', status: JOB_STATUS.COMPLETED, attempts: 1, maxAttempts: 8, payload: null, dedupeKey: null })

    const claimed = await repo.findClaimable({ limit: 10 })
    const ids = claimed.map((j) => j.sourceId).sort()
    expect(ids).toEqual(['D-1', 'D-3'])
    for (const j of claimed) expect(j.status).toBe(JOB_STATUS.PROCESSING)
  })

  it('findClaimable atomically transitions to PROCESSING and increments attempts', async () => {
    const j = await repo.create({ sourceId: 'D-1', status: JOB_STATUS.PENDING, attempts: 0, maxAttempts: 8, payload: null, dedupeKey: null })
    const claimed = await repo.findClaimable({ limit: 5 })
    expect(claimed).toHaveLength(1)
    expect(claimed[0].attempts).toBe(1)
    // second claim should be a no-op (no eligible jobs)
    const second = await repo.findClaimable({ limit: 5 })
    expect(second).toHaveLength(0)
    expect(j._id).toBeTruthy()
  })

  it('markCompleted sets terminal state and clears nextRetryAt', async () => {
    const j = await repo.create({ sourceId: 'D-1', status: JOB_STATUS.PENDING, attempts: 0, maxAttempts: 8, payload: null, dedupeKey: null })
    await repo.findClaimable({ limit: 1 })
    const updated = await repo.markCompleted(j._id)
    expect(updated.status).toBe(JOB_STATUS.COMPLETED)
    expect(updated.completedAt).toBeInstanceOf(Date)
    expect(updated.nextRetryAt).toBeNull()
  })

  it('markSkipped accepts SkipSyncError and stores reason', async () => {
    const { SkipSyncError } = require('../../../src/core/domain/errors.js')
    const j = await repo.create({ sourceId: 'D-1', status: JOB_STATUS.PENDING, attempts: 0, maxAttempts: 8, payload: null, dedupeKey: null })
    await repo.findClaimable({ limit: 1 })
    const updated = await repo.markSkipped(j._id, new SkipSyncError('no line items'))
    expect(updated.status).toBe(JOB_STATUS.SKIPPED)
    expect(updated.lastError).toBe('no line items')
  })

  it('markFailed retry vs dead-letter', async () => {
    const a = await repo.create({ sourceId: 'D-A', status: JOB_STATUS.PENDING, attempts: 0, maxAttempts: 8, payload: null, dedupeKey: null })
    await repo.findClaimable({ limit: 1 })
    const aRetried = await repo.markFailed(a._id, { error: new Error('boom'), nextRetryAt: new Date(Date.now() + 5000), deadLetter: false })
    expect(aRetried.status).toBe(JOB_STATUS.RETRY_PENDING)
    expect(aRetried.nextRetryAt).toBeInstanceOf(Date)
    expect(aRetried.lastError).toBe('boom')

    const b = await repo.create({ sourceId: 'D-B', status: JOB_STATUS.PENDING, attempts: 0, maxAttempts: 8, payload: null, dedupeKey: null })
    await repo.findClaimable({ limit: 1 })
    const bDead = await repo.markFailed(b._id, { error: new Error('boom'), deadLetter: true })
    expect(bDead.status).toBe(JOB_STATUS.DEAD_LETTER)
    expect(bDead.nextRetryAt).toBeNull()
    expect(bDead.completedAt).toBeInstanceOf(Date)
  })

  it('recoverOrphans flips stale PROCESSING back to PENDING', async () => {
    const j = await repo.create({ sourceId: 'D-1', status: JOB_STATUS.PENDING, attempts: 0, maxAttempts: 8, payload: null, dedupeKey: null })
    await repo.findClaimable({ limit: 1 })
    // Manually backdate updatedAt so it looks stale
    const { JobModel } = require('../../../src/adapters/outbound/mongo/schemas/job.schema.js')
    await JobModel.updateOne({ _id: j._id }, { $set: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) } })
    const recovered = await repo.recoverOrphans(new Date(), 60_000)
    expect(recovered).toBe(1)
    const after = await repo.findById(j._id)
    expect(after.status).toBe(JOB_STATUS.PENDING)
  })
})
