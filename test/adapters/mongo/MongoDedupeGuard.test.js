import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { MongoMemoryServer } = require('mongodb-memory-server')
const mongoose = require('mongoose')

const { MongoDedupeGuard } = require('../../../src/adapters/outbound/mongo/MongoDedupeGuard.js')

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

describe('MongoDedupeGuard', () => {
  it('markSeen + isDuplicate round-trip', async () => {
    const g = new MongoDedupeGuard()
    expect(await g.isDuplicate('k1')).toBe(false)
    await g.markSeen('k1')
    expect(await g.isDuplicate('k1')).toBe(true)
  })

  it('markSeen is idempotent (no error on duplicate)', async () => {
    const g = new MongoDedupeGuard()
    await g.markSeen('k1')
    await g.markSeen('k1')
    expect(await g.isDuplicate('k1')).toBe(true)
  })
})
