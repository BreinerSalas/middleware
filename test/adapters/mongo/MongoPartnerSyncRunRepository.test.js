import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const mongoose = require('mongoose')
const { MongoMemoryServer } = require('mongodb-memory-server')

const { PartnerSyncRunModel } = require('../../../src/adapters/outbound/mongo/schemas/partnerSyncRun.schema.js')
const { MongoPartnerSyncRunRepository } = require('../../../src/adapters/outbound/mongo/MongoPartnerSyncRunRepository.js')

let mongo

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  if (mongo) await mongo.stop()
}, 60_000)

beforeEach(async () => {
  await PartnerSyncRunModel.deleteMany({})
})

describe('MongoPartnerSyncRunRepository', () => {
  it('creates a run, updates it on completion, and lists recent runs', async () => {
    const repo = new MongoPartnerSyncRunRepository()
    const run = await repo.start({ total: 100, dryRun: false, now: () => '2026-04-01T10:00:00.000Z' })
    expect(run.status).toBe('running')
    expect(run.total).toBe(100)
    expect(run.dryRun).toBe(false)
    await repo.complete({
      runId: run._id,
      created: 50,
      updated: 50,
      skipped: 0,
      failed: 0,
      archived: 0,
      now: () => '2026-04-01T10:05:00.000Z'
    })
    const recent = await repo.listRecent({ limit: 5 })
    expect(recent).toHaveLength(1)
    expect(recent[0].status).toBe('completed')
    expect(recent[0].created).toBe(50)
    expect(recent[0].updated).toBe(50)
    expect(recent[0].skipped).toBe(0)
    expect(recent[0].failed).toBe(0)
    expect(recent[0].archived).toBe(0)
    expect(recent[0].endedAt.toISOString()).toBe('2026-04-01T10:05:00.000Z')
  })

  it('records the archived counter for partners excluded by the active=false domain', async () => {
    const repo = new MongoPartnerSyncRunRepository()
    const run = await repo.start({ total: 10, dryRun: false, now: () => 'T' })
    await repo.complete({
      runId: run._id,
      created: 5, updated: 5, skipped: 0, failed: 0,
      archived: 3,
      now: () => 'T2'
    })
    const found = await repo.listRecent({ limit: 1 })
    expect(found[0].archived).toBe(3)
  })

  it('marks a run as failed when complete() is called with status=failed', async () => {
    const repo = new MongoPartnerSyncRunRepository()
    const run = await repo.start({ total: 10, dryRun: false, now: () => 'T' })
    await repo.complete({
      runId: run._id, created: 0, updated: 0, skipped: 0, failed: 10,
      archived: 0, status: 'failed', now: () => 'T2'
    })
    const found = await repo.listRecent({ limit: 1 })
    expect(found[0].status).toBe('failed')
    expect(found[0].failed).toBe(10)
  })

  it('start() defaults dryRun=false and the schema does not include product-specific counters', async () => {
    const repo = new MongoPartnerSyncRunRepository()
    const run = await repo.start({ total: 0, now: () => 'T' })
    expect(run.dryRun).toBe(false)
    expect(run).not.toHaveProperty('uniqueSkus')
    expect(run).not.toHaveProperty('duplicatesInInput')
    expect(run).not.toHaveProperty('includeNoSku')
  })

  it('listRecent returns runs sorted by startedAt desc, capped to limit', async () => {
    const repo = new MongoPartnerSyncRunRepository()
    for (let i = 0; i < 5; i += 1) {
      await repo.start({ total: i, dryRun: false, now: () => `2026-04-0${i + 1}T10:00:00.000Z` })
    }
    const recent = await repo.listRecent({ limit: 3 })
    expect(recent).toHaveLength(3)
    // startedAt desc
    expect(new Date(recent[0].startedAt).getTime()).toBeGreaterThan(new Date(recent[2].startedAt).getTime())
  })

  it('the schema uses no __v (versionKey: false)', async () => {
    const repo = new MongoPartnerSyncRunRepository()
    const run = await repo.start({ total: 1, dryRun: false, now: () => 'T' })
    expect(run).not.toHaveProperty('__v')
  })
})
