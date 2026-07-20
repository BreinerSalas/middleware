import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { MongoMemoryServer } = require('mongodb-memory-server')
const mongoose = require('mongoose')

const { MongoAuditTrail } = require('../../../src/adapters/outbound/mongo/MongoAuditTrail.js')
const { SyncAuditEntry } = require('../../../src/core/domain/SyncAuditEntry.js')

let mongoServer
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
})

describe('MongoAuditTrail', () => {
  it('records entries', async () => {
    const t = new MongoAuditTrail()
    await t.record(new SyncAuditEntry({ sourceId: 'D-1', event: 'job.completed' }))
    await t.record(new SyncAuditEntry({ sourceId: 'D-1', event: 'job.skipped', success: false }))
    const { AuditModel } = require('../../../src/adapters/outbound/mongo/schemas/audit.schema.js')
    const all = await AuditModel.find().sort({ createdAt: 1 }).lean()
    expect(all).toHaveLength(2)
    expect(all[0].event).toBe('job.completed')
    expect(all[1].event).toBe('job.skipped')
    expect(all[1].success).toBe(false)
  })
})
