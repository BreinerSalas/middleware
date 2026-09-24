import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const mongoose = require('mongoose')
const { MongoMemoryServer } = require('mongodb-memory-server')

const { PartnerMappingModel } = require('../../../src/adapters/outbound/mongo/schemas/partnerMapping.schema.js')
const { MongoPartnerMappingRepository } = require('../../../src/adapters/outbound/mongo/MongoPartnerMappingRepository.js')

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
  await PartnerMappingModel.deleteMany({})
})

describe('MongoPartnerMappingRepository', () => {
  it('upserts a mapping on odooId (idempotent across repeated calls)', async () => {
    const repo = new MongoPartnerMappingRepository()
    await repo.upsert({ odooId: 1, hubspotId: 'H-1', action: 'created', now: () => '2026-01-01T00:00:00.000Z' })
    await repo.upsert({ odooId: 1, hubspotId: 'H-1', action: 'updated', now: () => '2026-01-02T00:00:00.000Z' })
    const all = await repo.listAll()
    expect(all).toHaveLength(1)
    expect(all[0].odooId).toBe(1)
    expect(all[0].lastAction).toBe('updated')
    expect(all[0].lastSyncedAt.toISOString()).toBe('2026-01-02T00:00:00.000Z')
    expect(all[0].firstSyncedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('upsert derives odooPartnerId from String(odooId) so the property value is always in sync', async () => {
    const repo = new MongoPartnerMappingRepository()
    await repo.upsert({ odooId: 4242, hubspotId: 'H', action: 'created', now: () => 'T' })
    const all = await repo.listAll()
    expect(all[0].odooPartnerId).toBe('4242')
  })

  it('upsert coerces hubspotId to a string', async () => {
    const repo = new MongoPartnerMappingRepository()
    await repo.upsert({ odooId: 1, hubspotId: 46034128180, action: 'created', now: () => 'T' })
    const all = await repo.listAll()
    expect(typeof all[0].hubspotId).toBe('string')
    expect(all[0].hubspotId).toBe('46034128180')
  })

  it('bulkUpsertMany inserts/updates many in one call', async () => {
    const repo = new MongoPartnerMappingRepository()
    const result = await repo.bulkUpsertMany({
      items: [
        { odooId: 1, hubspotId: 'H-1', action: 'created' },
        { odooId: 2, hubspotId: 'H-2', action: 'updated' },
        { odooId: 3, hubspotId: 'H-3', action: 'created' }
      ],
      now: () => '2026-03-01T00:00:00.000Z'
    })
    expect(result.upsertedCount).toBe(3)
    expect((await repo.listAll()).length).toBe(3)
  })

  it('bulkUpsertMany derives odooPartnerId from String(odooId) on every item', async () => {
    const repo = new MongoPartnerMappingRepository()
    await repo.bulkUpsertMany({
      items: [
        { odooId: 11, hubspotId: 'A', action: 'created' },
        { odooId: 22, hubspotId: 'B', action: 'updated' }
      ],
      now: () => 'T'
    })
    const all = await repo.listAll()
    const byOdoo = Object.fromEntries(all.map((m) => [m.odooId, m]))
    expect(byOdoo[11].odooPartnerId).toBe('11')
    expect(byOdoo[22].odooPartnerId).toBe('22')
  })

  it('findByOdooId returns one mapping or null', async () => {
    const repo = new MongoPartnerMappingRepository()
    await repo.upsert({ odooId: 99, hubspotId: 'H', action: 'created', now: () => 'T' })
    const found = await repo.findByOdooId(99)
    expect(found).not.toBeNull()
    expect(found.odooId).toBe(99)
    const missing = await repo.findByOdooId(123)
    expect(missing).toBeNull()
  })

  it('listAll returns sorted by lastSyncedAt desc', async () => {
    const repo = new MongoPartnerMappingRepository()
    await repo.upsert({ odooId: 1, hubspotId: 'H-1', action: 'created', now: () => '2026-01-01T00:00:00.000Z' })
    await repo.upsert({ odooId: 2, hubspotId: 'H-2', action: 'updated', now: () => '2026-03-01T00:00:00.000Z' })
    await repo.upsert({ odooId: 3, hubspotId: 'H-3', action: 'created', now: () => '2026-02-01T00:00:00.000Z' })
    const all = await repo.listAll()
    expect(all.map((m) => m.odooId)).toEqual([2, 3, 1])
  })

  it('listPaginated supports page+limit', async () => {
    const repo = new MongoPartnerMappingRepository()
    for (let i = 0; i < 25; i += 1) {
      await repo.upsert({ odooId: i + 1, hubspotId: `H${i}`, action: 'created', now: () => 'T' })
    }
    const page1 = await repo.listPaginated({ page: 1, limit: 10 })
    const page2 = await repo.listPaginated({ page: 2, limit: 10 })
    const page3 = await repo.listPaginated({ page: 3, limit: 10 })
    expect(page1.items).toHaveLength(10)
    expect(page2.items).toHaveLength(10)
    expect(page3.items).toHaveLength(5)
    expect(page1.total).toBe(25)
    expect(page1.page).toBe(1)
    expect(page1.limit).toBe(10)
  })

  it('clear() removes every mapping', async () => {
    const repo = new MongoPartnerMappingRepository()
    await repo.upsert({ odooId: 1, hubspotId: 'H', action: 'created', now: () => 'T' })
    await repo.upsert({ odooId: 2, hubspotId: 'H', action: 'created', now: () => 'T' })
    expect((await repo.listAll())).toHaveLength(2)
    await repo.clear()
    expect((await repo.listAll())).toHaveLength(0)
  })

  describe('direction (sdd/hubspot-contact-inbound-sync, schema)', () => {
    it('defaults direction to null when not supplied on upsert (legacy/outbound path unaffected)', async () => {
      const repo = new MongoPartnerMappingRepository()
      await repo.upsert({ odooId: 1, hubspotId: 'H-1', action: 'created', now: () => 'T' })
      const found = await repo.findByOdooId(1)
      expect(found.direction).toBeNull()
    })

    it('upsert stores an explicit direction value', async () => {
      const repo = new MongoPartnerMappingRepository()
      await repo.upsert({ odooId: 1, hubspotId: 'H-1', action: 'linked', direction: 'hubspot_to_odoo', now: () => 'T' })
      const found = await repo.findByOdooId(1)
      expect(found.direction).toBe('hubspot_to_odoo')
    })

    it('rejects an invalid direction value at the schema level', async () => {
      await expect(
        PartnerMappingModel.create({
          odooId: 999, odooPartnerId: '999', hubspotId: 'H', lastAction: 'created', direction: 'sideways',
          lastSyncedAt: new Date(), firstSyncedAt: new Date()
        })
      ).rejects.toThrow()
    })

    it('bulkUpsertMany sets direction only on insert via $setOnInsert, never flipping an existing origin on update', async () => {
      const repo = new MongoPartnerMappingRepository()
      // First tick: outbound batch creates the row (direction defaults to odoo_to_hubspot on insert)
      await repo.bulkUpsertMany({
        items: [{ odooId: 1, hubspotId: 'H-1', action: 'created' }],
        now: () => 'T1'
      })
      const afterInsert = await repo.findByOdooId(1)
      expect(afterInsert.direction).toBe('odoo_to_hubspot')

      // Simulate the row having been created by the inbound flow instead (hubspot_to_odoo),
      // then run bulkUpsertMany again as an UPDATE — direction must not flip.
      await PartnerMappingModel.updateOne({ odooId: 1 }, { $set: { direction: 'hubspot_to_odoo' } })
      await repo.bulkUpsertMany({
        items: [{ odooId: 1, hubspotId: 'H-1', action: 'updated' }],
        now: () => 'T2'
      })
      const afterUpdate = await repo.findByOdooId(1)
      expect(afterUpdate.direction).toBe('hubspot_to_odoo')
    })
  })

  describe('lastAction "linked" (sdd/hubspot-contact-inbound-sync, schema)', () => {
    it('accepts "linked" as a valid lastAction value', async () => {
      const doc = await PartnerMappingModel.create({
        odooId: 500, odooPartnerId: '500', hubspotId: 'H-500', lastAction: 'linked',
        lastSyncedAt: new Date(), firstSyncedAt: new Date()
      })
      expect(doc.lastAction).toBe('linked')
    })
  })

  describe('hubspotId index is non-unique (sdd/hubspot-contact-inbound-sync, schema)', () => {
    it('allows two mapping rows with the same hubspotId (legacy rows may have duplicates)', async () => {
      const repo = new MongoPartnerMappingRepository()
      await repo.upsert({ odooId: 1, hubspotId: 'DUP', action: 'created', now: () => 'T' })
      await repo.upsert({ odooId: 2, hubspotId: 'DUP', action: 'created', now: () => 'T' })
      const all = await repo.listAll()
      expect(all.filter((m) => m.hubspotId === 'DUP')).toHaveLength(2)
    })
  })

  describe('findByHubspotId (sdd/hubspot-contact-inbound-sync)', () => {
    it('returns the mapped row when a row exists for the hubspotId', async () => {
      const repo = new MongoPartnerMappingRepository()
      await repo.upsert({ odooId: 42, hubspotId: '46671077999', action: 'created', now: () => 'T' })
      const found = await repo.findByHubspotId('46671077999')
      expect(found).not.toBeNull()
      expect(found.odooId).toBe(42)
      expect(found.hubspotId).toBe('46671077999')
    })

    it('returns null when no row exists for the hubspotId (does NOT guess)', async () => {
      const repo = new MongoPartnerMappingRepository()
      await repo.upsert({ odooId: 1, hubspotId: 'H-1', action: 'created', now: () => 'T' })
      const found = await repo.findByHubspotId('99999999999')
      expect(found).toBeNull()
    })

    it('returns null when hubspotId is null WITHOUT issuing a Mongo query', async () => {
      const repo = new MongoPartnerMappingRepository()
      const findOneSpy = vi.spyOn(PartnerMappingModel, 'findOne')
      const result = await repo.findByHubspotId(null)
      expect(result).toBeNull()
      expect(findOneSpy).not.toHaveBeenCalled()
      findOneSpy.mockRestore()
    })

    it('returns null when hubspotId is undefined WITHOUT issuing a Mongo query', async () => {
      const repo = new MongoPartnerMappingRepository()
      const findOneSpy = vi.spyOn(PartnerMappingModel, 'findOne')
      const result = await repo.findByHubspotId(undefined)
      expect(result).toBeNull()
      expect(findOneSpy).not.toHaveBeenCalled()
      findOneSpy.mockRestore()
    })

    it('returns null when hubspotId is empty string WITHOUT issuing a Mongo query', async () => {
      const repo = new MongoPartnerMappingRepository()
      const findOneSpy = vi.spyOn(PartnerMappingModel, 'findOne')
      const result = await repo.findByHubspotId('')
      expect(result).toBeNull()
      expect(findOneSpy).not.toHaveBeenCalled()
      findOneSpy.mockRestore()
    })

    it('returns null when hubspotId is the string "null" WITHOUT issuing a Mongo query', async () => {
      const repo = new MongoPartnerMappingRepository()
      const findOneSpy = vi.spyOn(PartnerMappingModel, 'findOne')
      const result = await repo.findByHubspotId('null')
      expect(result).toBeNull()
      expect(findOneSpy).not.toHaveBeenCalled()
      findOneSpy.mockRestore()
    })
  })
})
