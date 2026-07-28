import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const mongoose = require('mongoose')
const { MongoMemoryServer } = require('mongodb-memory-server')

const { ProductMappingModel } = require('../../../src/adapters/outbound/mongo/schemas/productMapping.schema.js')
const { ProductSyncRunModel } = require('../../../src/adapters/outbound/mongo/schemas/productSyncRun.schema.js')
const { MongoProductMappingRepository } = require('../../../src/adapters/outbound/mongo/MongoProductMappingRepository.js')
const { MongoProductSyncRunRepository } = require('../../../src/adapters/outbound/mongo/MongoProductSyncRunRepository.js')

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
  await ProductMappingModel.deleteMany({})
  await ProductSyncRunModel.deleteMany({})
})

describe('MongoProductMappingRepository', () => {
  it('upserts a mapping on odooId (idempotent)', async () => {
    const repo = new MongoProductMappingRepository()
    await repo.upsert({ odooId: 1, hsSku: 'AC-1', hubspotId: 'H-1', action: 'created', now: () => '2026-01-01T00:00:00.000Z' })
    await repo.upsert({ odooId: 1, hsSku: 'AC-1', hubspotId: 'H-1', action: 'updated', now: () => '2026-01-02T00:00:00.000Z' })
    const all = await repo.listAll()
    expect(all).toHaveLength(1)
    expect(all[0].odooId).toBe(1)
    expect(all[0].lastAction).toBe('updated')
    expect(all[0].lastSyncedAt.toISOString()).toBe('2026-01-02T00:00:00.000Z')
    expect(all[0].firstSyncedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('bulkUpsertMany inserts/updates many in one call', async () => {
    const repo = new MongoProductMappingRepository()
    const result = await repo.bulkUpsertMany({
      items: [
        { odooId: 1, hsSku: 'A', hubspotId: 'H-1', action: 'created' },
        { odooId: 2, hsSku: 'B', hubspotId: 'H-2', action: 'updated' },
        { odooId: 3, hsSku: 'C', hubspotId: 'H-3', action: 'created' }
      ],
      now: () => '2026-03-01T00:00:00.000Z'
    })
    expect(result.upsertedCount).toBe(3)
    expect((await repo.listAll()).length).toBe(3)
  })

  it('findByOdooId returns one mapping or null', async () => {
    const repo = new MongoProductMappingRepository()
    await repo.upsert({ odooId: 99, hsSku: 'X', hubspotId: 'H', action: 'created', now: () => 'T' })
    const found = await repo.findByOdooId(99)
    expect(found).not.toBeNull()
    expect(found.odooId).toBe(99)
    const missing = await repo.findByOdooId(123)
    expect(missing).toBeNull()
  })

  it('listAll returns sorted by lastSyncedAt desc', async () => {
    const repo = new MongoProductMappingRepository()
    await repo.upsert({ odooId: 1, hsSku: 'A', hubspotId: 'H-1', action: 'created', now: () => '2026-01-01T00:00:00.000Z' })
    await repo.upsert({ odooId: 2, hsSku: 'B', hubspotId: 'H-2', action: 'updated', now: () => '2026-03-01T00:00:00.000Z' })
    await repo.upsert({ odooId: 3, hsSku: 'C', hubspotId: 'H-3', action: 'created', now: () => '2026-02-01T00:00:00.000Z' })
    const all = await repo.listAll()
    expect(all.map((m) => m.odooId)).toEqual([2, 3, 1])
  })

  it('listPaginated supports page+limit', async () => {
    const repo = new MongoProductMappingRepository()
    for (let i = 0; i < 25; i += 1) {
      await repo.upsert({ odooId: i + 1, hsSku: `S${i}`, hubspotId: `H${i}`, action: 'created', now: () => 'T' })
    }
    const page1 = await repo.listPaginated({ page: 1, limit: 10 })
    const page2 = await repo.listPaginated({ page: 2, limit: 10 })
    expect(page1.items).toHaveLength(10)
    expect(page2.items).toHaveLength(10)
    expect(page1.total).toBe(25)
  })
})

describe('MongoProductSyncRunRepository', () => {
  it('creates a run, updates it on completion, and lists recent runs', async () => {
    const repo = new MongoProductSyncRunRepository()
    const run = await repo.start({ total: 100, includeNoSku: false, dryRun: false, now: () => '2026-04-01T10:00:00.000Z' })
    expect(run.status).toBe('running')
    expect(run.total).toBe(100)
    await repo.complete({
      runId: run._id,
      created: 50,
      updated: 50,
      skipped: 0,
      failed: 0,
      uniqueSkus: 50,
      duplicatesInInput: 0,
      now: () => '2026-04-01T10:05:00.000Z'
    })
    const recent = await repo.listRecent({ limit: 5 })
    expect(recent).toHaveLength(1)
    expect(recent[0].status).toBe('completed')
    expect(recent[0].created).toBe(50)
    expect(recent[0].updated).toBe(50)
    expect(recent[0].endedAt.toISOString()).toBe('2026-04-01T10:05:00.000Z')
  })

  it('marks a run as failed when complete() is called with status=failed', async () => {
    const repo = new MongoProductSyncRunRepository()
    const run = await repo.start({ total: 10, dryRun: false, now: () => 'T' })
    await repo.complete({ runId: run._id, created: 0, updated: 0, skipped: 0, failed: 10, uniqueSkus: 10, duplicatesInInput: 0, status: 'failed', now: () => 'T2' })
    const found = await repo.listRecent({ limit: 1 })
    expect(found[0].status).toBe('failed')
    expect(found[0].failed).toBe(10)
  })
})
