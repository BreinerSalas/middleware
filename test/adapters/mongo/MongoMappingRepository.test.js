import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { MongoMemoryServer } = require('mongodb-memory-server')
const mongoose = require('mongoose')

const { MongoMappingRepository } = require('../../../src/adapters/outbound/mongo/MongoMappingRepository.js')

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

describe('MongoMappingRepository', () => {
  it('upsert is idempotent on sourceId', async () => {
    const repo = new MongoMappingRepository()
    await repo.upsert({ sourceId: 'D-1', targetId: 'T-1', targetRef: null, payloadHash: 'h1', metadata: {} })
    await repo.upsert({ sourceId: 'D-1', targetId: 'T-2', targetRef: null, payloadHash: 'h2', metadata: {} })
    const got = await repo.findBySourceId('D-1')
    expect(got.targetId).toBe('T-2')
    expect(got.payloadHash).toBe('h2')
  })

  it('findBySourceId returns null when missing', async () => {
    const repo = new MongoMappingRepository()
    expect(await repo.findBySourceId('nope')).toBeNull()
  })

  it('metadata is merged on upsert', async () => {
    const repo = new MongoMappingRepository()
    await repo.upsert({ sourceId: 'D-1', targetId: 'T-1', targetRef: null, payloadHash: 'h', metadata: { a: 1 } })
    await repo.upsert({ sourceId: 'D-1', targetId: 'T-2', targetRef: null, payloadHash: 'h', metadata: { b: 2 } })
    const got = await repo.findBySourceId('D-1')
    expect(got.metadata).toEqual({ a: 1, b: 2 })
  })
})
