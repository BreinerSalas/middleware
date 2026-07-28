import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
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

describe('panel routes - product mappings + runs', () => {
  it('returns paginated product mappings and recent runs from /api/panel/product-status', async () => {
    const mappingRepo = new MongoProductMappingRepository()
    const runRepo = new MongoProductSyncRunRepository()
    for (let i = 0; i < 3; i += 1) {
      await mappingRepo.upsert({ odooId: i + 1, hsSku: `SKU-${i}`, hubspotId: `H-${i}`, action: 'created', now: () => `2026-01-0${i + 1}T00:00:00.000Z` })
    }
    const run = await runRepo.start({ total: 5, now: () => '2026-01-01T00:00:00.000Z' })
    await runRepo.complete({ runId: run._id, created: 3, updated: 0, skipped: 0, failed: 0, uniqueSkus: 3, duplicatesInInput: 0, now: () => '2026-01-01T00:05:00.000Z' })

    const mappings = await mappingRepo.listPaginated({ page: 1, limit: 10 })
    const runs = await runRepo.listRecent({ limit: 1 })
    expect(mappings.total).toBe(3)
    expect(runs.length).toBe(1)
    expect(runs[0].status).toBe('completed')
    expect(runs[0].created).toBe(3)
  })
})
