import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const mongoose = require('mongoose')
const { MongoMemoryServer } = require('mongodb-memory-server')

const { MongoProductMappingRepository } = require('../../../src/adapters/outbound/mongo/MongoProductMappingRepository.js')

let mongo
let repo
let model

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
  const { ProductMappingModel } = require('../../../src/adapters/outbound/mongo/schemas/productMapping.schema.js')
  model = ProductMappingModel
  repo = new MongoProductMappingRepository({ model })
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  if (mongo) await mongo.stop()
}, 60_000)

beforeEach(async () => {
  await model.deleteMany({})
})

describe('MongoProductMappingRepository - run-level history', () => {
  it('persists multiple runs so the client can query history', async () => {
    await repo.upsert({ odooId: 1, hsSku: 'A', hubspotId: 'H-1', action: 'created', now: () => '2026-01-01T00:00:00.000Z' })
    await repo.upsert({ odooId: 2, hsSku: 'B', hubspotId: 'H-2', action: 'created', now: () => '2026-01-01T00:00:00.000Z' })
    await repo.upsert({ odooId: 1, hsSku: 'A', hubspotId: 'H-1', action: 'updated', now: () => '2026-01-02T00:00:00.000Z' })

    const recent = await repo.listAll()
    expect(recent.length).toBe(2)
    const odoo1 = recent.find((r) => r.odooId === 1)
    expect(odoo1.lastAction).toBe('updated')
    expect(odoo1.lastSyncedAt.toISOString()).toBe('2026-01-02T00:00:00.000Z')
    expect(odoo1.firstSyncedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('paginated list returns odooId, hsSku, hubspotId, lastAction, lastSyncedAt for panel', async () => {
    for (let i = 0; i < 5; i += 1) {
      await repo.upsert({ odooId: i + 1, hsSku: `SKU-${i}`, hubspotId: `HUB-${i}`, action: 'created', now: () => `2026-01-0${i + 1}T00:00:00.000Z` })
    }
    const page = await repo.listPaginated({ page: 1, limit: 3 })
    expect(page.items).toHaveLength(3)
    expect(page.total).toBe(5)
    for (const item of page.items) {
      expect(item).toHaveProperty('odooId')
      expect(item).toHaveProperty('hsSku')
      expect(item).toHaveProperty('hubspotId')
      expect(item).toHaveProperty('lastAction')
      expect(item).toHaveProperty('lastSyncedAt')
      expect(item).toHaveProperty('firstSyncedAt')
    }
  })
})
