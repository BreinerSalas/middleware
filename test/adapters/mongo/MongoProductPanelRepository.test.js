import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const mongoose = require('mongoose')
const { MongoMemoryServer } = require('mongodb-memory-server')

const { ProductOrphanQuarantineModel } = require('../../../src/adapters/outbound/mongo/schemas/productOrphanQuarantine.schema.js')
const { ProductOrphanArchiveModel } = require('../../../src/adapters/outbound/mongo/schemas/productOrphanArchive.schema.js')
const { MongoProductPanelRepository } = require('../../../src/adapters/outbound/mongo/MongoProductPanelRepository.js')

// (sdd/hubspot-product-reverse-discovery, Phase 4) Panel read-only surface for the quarantine
// and archive audit collections written in Phase 3. Reuses the same clamp()/escaped-regex `q`
// convention as listProductMappings (design: "reuse clamp").

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
  await ProductOrphanQuarantineModel.deleteMany({})
  await ProductOrphanArchiveModel.deleteMany({})
})

describe('MongoProductPanelRepository.listOrphanQuarantine', () => {
  it('returns paginated quarantine docs sorted by lastSeenAt desc', async () => {
    for (let i = 0; i < 5; i += 1) {
      await ProductOrphanQuarantineModel.create({
        hubspotId: `HUB-${i}`,
        name: `Widget ${i}`,
        reason: 'no_name',
        firstSeenAt: new Date(`2026-01-0${i + 1}T00:00:00Z`),
        lastSeenAt: new Date(`2026-01-0${i + 1}T00:00:00Z`)
      })
    }
    const repo = new MongoProductPanelRepository()
    const result = await repo.listOrphanQuarantine({ page: 1, pageSize: 3 })
    expect(result.items).toHaveLength(3)
    expect(result.total).toBe(5)
    expect(result.page).toBe(1)
    expect(result.pageSize).toBe(3)
    expect(result.items[0].hubspotId).toBe('HUB-4')
  })

  it('filters by escaped-regex q across hubspotId/name/reason', async () => {
    await ProductOrphanQuarantineModel.create({
      hubspotId: 'HUB-1', name: 'Special (Widget)', reason: 'no_name', firstSeenAt: new Date(), lastSeenAt: new Date()
    })
    await ProductOrphanQuarantineModel.create({
      hubspotId: 'HUB-2', name: 'Other', reason: 'ambiguous_in_hubspot', firstSeenAt: new Date(), lastSeenAt: new Date()
    })
    const repo = new MongoProductPanelRepository()
    const result = await repo.listOrphanQuarantine({ q: 'Special (Widget)' })
    expect(result.total).toBe(1)
    expect(result.items[0].hubspotId).toBe('HUB-1')
  })

  it('clamps page/pageSize to sane bounds', async () => {
    const repo = new MongoProductPanelRepository()
    const result = await repo.listOrphanQuarantine({ page: -5, pageSize: 10000 })
    expect(result.page).toBe(1)
    expect(result.pageSize).toBe(100)
  })
})

describe('MongoProductPanelRepository.listOrphanArchives', () => {
  it('returns paginated archive docs sorted by requestedAt desc', async () => {
    for (let i = 0; i < 3; i += 1) {
      await ProductOrphanArchiveModel.create({
        hubspotId: `HUB-A-${i}`,
        name: `Dup ${i}`,
        status: 'archived',
        requestedAt: new Date(`2026-01-0${i + 1}T00:00:00Z`)
      })
    }
    const repo = new MongoProductPanelRepository()
    const result = await repo.listOrphanArchives({ page: 1, pageSize: 2 })
    expect(result.items).toHaveLength(2)
    expect(result.total).toBe(3)
    expect(result.items[0].hubspotId).toBe('HUB-A-2')
  })

  it('filters by escaped-regex q across hubspotId/name/status', async () => {
    await ProductOrphanArchiveModel.create({ hubspotId: 'HUB-A-1', name: 'Dup', status: 'archived', requestedAt: new Date() })
    await ProductOrphanArchiveModel.create({ hubspotId: 'HUB-A-2', name: 'Other', status: 'failed', requestedAt: new Date() })
    const repo = new MongoProductPanelRepository()
    const result = await repo.listOrphanArchives({ q: 'failed' })
    expect(result.total).toBe(1)
    expect(result.items[0].hubspotId).toBe('HUB-A-2')
  })

  it('clamps page/pageSize to sane bounds', async () => {
    const repo = new MongoProductPanelRepository()
    const result = await repo.listOrphanArchives({ page: 0, pageSize: -1 })
    expect(result.page).toBe(1)
    expect(result.pageSize).toBe(1)
  })
})
