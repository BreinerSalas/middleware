import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const mongoose = require('mongoose')
const { MongoMemoryServer } = require('mongodb-memory-server')

const { ProductOrphanQuarantineModel } = require('../../../src/adapters/outbound/mongo/schemas/productOrphanQuarantine.schema.js')
const { ProductOrphanArchiveModel } = require('../../../src/adapters/outbound/mongo/schemas/productOrphanArchive.schema.js')
const { MongoProductOrphanRepository } = require('../../../src/adapters/outbound/mongo/MongoProductOrphanRepository.js')

// (sdd/hubspot-product-reverse-discovery, Phase 3) Quarantine + archive audit persistence.
// D8: two new collections, not product_mapping (orphans have no odooId). D7: archive audit row
// written pending BEFORE the archive call, flipped to archived/failed after.

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

describe('MongoProductOrphanRepository.upsertQuarantine', () => {
  it('inserts a new quarantine doc with runCount=1 on first run', async () => {
    const repo = new MongoProductOrphanRepository()
    await repo.upsertQuarantine({
      hubspotId: 'HUB-1',
      name: 'Widget',
      reason: 'no_name',
      now: () => new Date('2026-01-01T00:00:00Z')
    })
    const doc = await ProductOrphanQuarantineModel.findOne({ hubspotId: 'HUB-1' }).lean()
    expect(doc).not.toBeNull()
    expect(doc.runCount).toBe(1)
    expect(doc.reason).toBe('no_name')
    expect(doc.normalizedName).toBe('widget')
    expect(doc.firstSeenAt.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('increments runCount and refreshes lastSeenAt without creating a duplicate doc across two runs', async () => {
    const repo = new MongoProductOrphanRepository()
    await repo.upsertQuarantine({
      hubspotId: 'HUB-2',
      name: 'Gadget',
      reason: 'not_found_in_odoo',
      now: () => new Date('2026-01-01T00:00:00Z')
    })
    await repo.upsertQuarantine({
      hubspotId: 'HUB-2',
      name: 'Gadget',
      reason: 'not_found_in_odoo',
      now: () => new Date('2026-01-02T00:00:00Z')
    })
    const docs = await ProductOrphanQuarantineModel.find({ hubspotId: 'HUB-2' }).lean()
    expect(docs).toHaveLength(1)
    expect(docs[0].runCount).toBe(2)
    expect(docs[0].lastSeenAt.toISOString()).toBe('2026-01-02T00:00:00.000Z')
    expect(docs[0].firstSeenAt.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('updates the reason when the pipeline outcome changes across runs', async () => {
    const repo = new MongoProductOrphanRepository()
    await repo.upsertQuarantine({ hubspotId: 'HUB-3', name: 'X', reason: 'ambiguous_in_hubspot' })
    await repo.upsertQuarantine({ hubspotId: 'HUB-3', name: 'X', reason: 'referenced_by_line_item' })
    const doc = await ProductOrphanQuarantineModel.findOne({ hubspotId: 'HUB-3' }).lean()
    expect(doc.reason).toBe('referenced_by_line_item')
    expect(doc.runCount).toBe(2)
  })
})

describe('MongoProductOrphanRepository.resolveQuarantine', () => {
  it('sets resolvedAt on an existing quarantine doc', async () => {
    const repo = new MongoProductOrphanRepository()
    await repo.upsertQuarantine({ hubspotId: 'HUB-4', name: 'Y', reason: 'no_name' })
    await repo.resolveQuarantine({ hubspotId: 'HUB-4', now: () => new Date('2026-01-03T00:00:00Z') })
    const doc = await ProductOrphanQuarantineModel.findOne({ hubspotId: 'HUB-4' }).lean()
    expect(doc.resolvedAt.toISOString()).toBe('2026-01-03T00:00:00.000Z')
  })

  it('is a no-op that creates nothing when the hubspotId has no quarantine doc', async () => {
    const repo = new MongoProductOrphanRepository()
    await expect(repo.resolveQuarantine({ hubspotId: 'NOT-THERE' })).resolves.not.toThrow()
    const doc = await ProductOrphanQuarantineModel.findOne({ hubspotId: 'NOT-THERE' }).lean()
    expect(doc).toBeNull()
  })
})

describe('MongoProductOrphanRepository archive audit (recordArchivePending -> markArchived / markArchiveFailed, design D7)', () => {
  it('records a pending archive row before the HubSpot call', async () => {
    const repo = new MongoProductOrphanRepository()
    await repo.recordArchivePending({
      hubspotId: 'HUB-5',
      name: 'Dup',
      price: '10.00',
      siblingHubspotId: 'HUB-6',
      siblingOdooId: '900'
    })
    const doc = await ProductOrphanArchiveModel.findOne({ hubspotId: 'HUB-5' }).lean()
    expect(doc).not.toBeNull()
    expect(doc.status).toBe('pending')
    expect(doc.siblingHubspotId).toBe('HUB-6')
    expect(doc.siblingOdooId).toBe('900')
    expect(doc.archivedAt).toBeNull()
  })

  it('transitions pending -> archived on markArchived, setting archivedAt', async () => {
    const repo = new MongoProductOrphanRepository()
    await repo.recordArchivePending({ hubspotId: 'HUB-7', name: 'Dup', price: '10.00', siblingHubspotId: 'HUB-8', siblingOdooId: '901' })
    await repo.markArchived({ hubspotId: 'HUB-7', now: () => new Date('2026-01-05T00:00:00Z') })
    const doc = await ProductOrphanArchiveModel.findOne({ hubspotId: 'HUB-7' }).lean()
    expect(doc.status).toBe('archived')
    expect(doc.archivedAt.toISOString()).toBe('2026-01-05T00:00:00.000Z')
  })

  it('transitions pending -> failed on markArchiveFailed, recording the error and leaving archivedAt null', async () => {
    const repo = new MongoProductOrphanRepository()
    await repo.recordArchivePending({ hubspotId: 'HUB-9', name: 'Dup', price: '10.00', siblingHubspotId: 'HUB-10', siblingOdooId: '902' })
    await repo.markArchiveFailed({ hubspotId: 'HUB-9', error: 'HubSpot 429' })
    const doc = await ProductOrphanArchiveModel.findOne({ hubspotId: 'HUB-9' }).lean()
    expect(doc.status).toBe('failed')
    expect(doc.error).toBe('HubSpot 429')
    expect(doc.archivedAt).toBeNull()
  })
})
