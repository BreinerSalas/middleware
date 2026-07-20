import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { MongoMemoryServer } = require('mongodb-memory-server')
const mongoose = require('mongoose')

const { MongoPanelRepository } = require('../../../src/adapters/outbound/mongo/MongoPanelRepository.js')
const { MappingModel } = require('../../../src/adapters/outbound/mongo/schemas/mapping.schema.js')
const { AuditModel } = require('../../../src/adapters/outbound/mongo/schemas/audit.schema.js')

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
  repo = new MongoPanelRepository()
})

function seedMapping(sourceId, targetId = 'T-1', extra = {}) {
  return MappingModel.create({
    sourceId,
    targetId,
    targetRef: extra.targetRef || null,
    payloadHash: extra.payloadHash || 'h',
    lastSyncedAt: extra.lastSyncedAt || new Date(),
    metadata: extra.metadata || {},
    createdAt: extra.createdAt || new Date(),
    updatedAt: extra.updatedAt || new Date()
  })
}

function seedAudit(sourceId, event, success = true, detail = null, createdAt = null) {
  return AuditModel.create({
    jobId: 'J-1',
    sourceId,
    correlationId: 'C-1',
    event,
    success,
    detail,
    createdAt: createdAt || new Date()
  })
}

describe('MongoPanelRepository', () => {
  describe('listMappings', () => {
    it('returns empty list when no mappings exist', async () => {
      const res = await repo.listMappings({ page: 1, pageSize: 25 })
      expect(res.items).toEqual([])
      expect(res.total).toBe(0)
      expect(res.page).toBe(1)
      expect(res.pageSize).toBe(25)
    })

    it('returns paginated mappings sorted by updatedAt desc', async () => {
      const now = Date.now()
      await seedMapping('D-1', 'T-1', { updatedAt: new Date(now - 3000) })
      await seedMapping('D-2', 'T-2', { updatedAt: new Date(now - 1000) })
      await seedMapping('D-3', 'T-3', { updatedAt: new Date(now - 2000) })

      const res = await repo.listMappings({ page: 1, pageSize: 10 })
      expect(res.total).toBe(3)
      expect(res.items.map((m) => m.sourceId)).toEqual(['D-2', 'D-3', 'D-1'])
    })

    it('applies pagination (page/pageSize)', async () => {
      for (let i = 0; i < 7; i += 1) await seedMapping(`D-${i}`)
      const page1 = await repo.listMappings({ page: 1, pageSize: 3 })
      const page2 = await repo.listMappings({ page: 2, pageSize: 3 })
      const page3 = await repo.listMappings({ page: 3, pageSize: 3 })
      expect(page1.items).toHaveLength(3)
      expect(page2.items).toHaveLength(3)
      expect(page3.items).toHaveLength(1)
      expect(page1.total).toBe(7)
    })

    it('filters by sourceId substring', async () => {
      await seedMapping('hubspot-deal-1', 'T-1')
      await seedMapping('hubspot-deal-2', 'T-2')
      await seedMapping('other', 'T-3')
      const res = await repo.listMappings({ page: 1, pageSize: 10, q: 'hubspot' })
      expect(res.total).toBe(2)
    })

    it('filters by targetId substring', async () => {
      await seedMapping('D-1', 'PO-AAA')
      await seedMapping('D-2', 'PO-BBB')
      await seedMapping('D-3', 'STUB-CCC')
      const res = await repo.listMappings({ page: 1, pageSize: 10, q: 'PO-' })
      expect(res.total).toBe(2)
    })

    it('clamps page/pageSize to safe minimums', async () => {
      await seedMapping('D-1')
      const res = await repo.listMappings({ page: 0, pageSize: 0 })
      expect(res.page).toBe(1)
      expect(res.pageSize).toBeGreaterThanOrEqual(1)
    })
  })

  describe('deleteMapping', () => {
    it('removes a mapping by id', async () => {
      const m = await seedMapping('D-1')
      const ok = await repo.deleteMapping(String(m._id))
      expect(ok).toBe(true)
      const remaining = await repo.listMappings({ page: 1, pageSize: 10 })
      expect(remaining.total).toBe(0)
    })

    it('returns false when id does not exist', async () => {
      const ok = await repo.deleteMapping('000000000000000000000000')
      expect(ok).toBe(false)
    })
  })

  describe('clearMappings', () => {
    it('removes all mappings', async () => {
      await seedMapping('D-1'); await seedMapping('D-2'); await seedMapping('D-3')
      const removed = await repo.clearMappings()
      expect(removed).toBe(3)
      const remaining = await repo.listMappings({ page: 1, pageSize: 10 })
      expect(remaining.total).toBe(0)
    })

    it('returns 0 when there are no mappings', async () => {
      const removed = await repo.clearMappings()
      expect(removed).toBe(0)
    })
  })

  describe('listLogs', () => {
    it('returns paginated audits sorted by createdAt desc', async () => {
      const now = Date.now()
      await seedAudit('D-1', 'job.completed', true, null, new Date(now - 3000))
      await seedAudit('D-1', 'job.skipped', false, null, new Date(now - 1000))
      await seedAudit('D-1', 'job.retry_scheduled', false, null, new Date(now - 2000))

      const res = await repo.listLogs({ page: 1, pageSize: 10 })
      expect(res.total).toBe(3)
      expect(res.items.map((a) => a.event)).toEqual(['job.skipped', 'job.retry_scheduled', 'job.completed'])
      expect(res.items[0].success).toBe(false)
    })

    it('filters by event name', async () => {
      await seedAudit('D-1', 'job.completed', true)
      await seedAudit('D-1', 'job.skipped', false)
      await seedAudit('D-1', 'job.completed', true)
      const res = await repo.listLogs({ page: 1, pageSize: 10, event: 'job.completed' })
      expect(res.total).toBe(2)
    })

    it('filters by success boolean', async () => {
      await seedAudit('D-1', 'job.completed', true)
      await seedAudit('D-1', 'job.skipped', false)
      const failed = await repo.listLogs({ page: 1, pageSize: 10, success: false })
      const passed = await repo.listLogs({ page: 1, pageSize: 10, success: true })
      expect(failed.total).toBe(1)
      expect(failed.items[0].success).toBe(false)
      expect(passed.total).toBe(1)
      expect(passed.items[0].success).toBe(true)
    })

    it('filters by sourceId substring', async () => {
      await seedAudit('hubspot-deal-1', 'job.completed', true)
      await seedAudit('hubspot-deal-2', 'job.completed', true)
      await seedAudit('other', 'job.completed', true)
      const res = await repo.listLogs({ page: 1, pageSize: 10, q: 'hubspot' })
      expect(res.total).toBe(2)
    })
  })

  describe('getLogById', () => {
    it('returns full audit including detail', async () => {
      const created = await seedAudit('D-1', 'job.processing.start', true, { foo: 'bar' })
      const got = await repo.getLogById(String(created._id))
      expect(got.event).toBe('job.processing.start')
      expect(got.detail).toEqual({ foo: 'bar' })
      expect(got.sourceId).toBe('D-1')
    })

    it('returns null when not found', async () => {
      const got = await repo.getLogById('000000000000000000000000')
      expect(got).toBeNull()
    })
  })

  describe('deleteLog', () => {
    it('removes an audit by id', async () => {
      const a = await seedAudit('D-1', 'job.completed', true)
      const ok = await repo.deleteLog(String(a._id))
      expect(ok).toBe(true)
      const remaining = await repo.listLogs({ page: 1, pageSize: 10 })
      expect(remaining.total).toBe(0)
    })
  })

  describe('clearLogs', () => {
    it('removes all audits', async () => {
      await seedAudit('D-1', 'a'); await seedAudit('D-1', 'b'); await seedAudit('D-1', 'c')
      const removed = await repo.clearLogs()
      expect(removed).toBe(3)
      const remaining = await repo.listLogs({ page: 1, pageSize: 10 })
      expect(remaining.total).toBe(0)
    })
  })

  describe('getCounts', () => {
    it('returns counts for mappings, audits, jobs grouped by status', async () => {
      await seedMapping('D-1')
      await seedAudit('D-1', 'job.completed')
      const { JobModel } = require('../../../src/adapters/outbound/mongo/schemas/job.schema.js')
      await JobModel.create({ sourceId: 'D-1', status: 'COMPLETED', payload: null, dedupeKey: null, maxAttempts: 8 })
      await JobModel.create({ sourceId: 'D-2', status: 'PENDING', payload: null, dedupeKey: null, maxAttempts: 8 })

      const counts = await repo.getCounts()
      expect(counts.mappings).toBe(1)
      expect(counts.audits).toBe(1)
      expect(counts.jobsByStatus).toMatchObject({ COMPLETED: 1, PENDING: 1 })
    })
  })
})
