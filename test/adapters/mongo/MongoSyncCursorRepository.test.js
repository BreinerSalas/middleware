import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { MongoMemoryServer } = require('mongodb-memory-server')
const mongoose = require('mongoose')

const { MongoSyncCursorRepository } = require('../../../src/adapters/outbound/mongo/MongoSyncCursorRepository.js')

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
  repo = new MongoSyncCursorRepository()
})

describe('MongoSyncCursorRepository (Fase 3 — docs/plan-cambios-2026-08-05.md)', () => {
  it('get returns null for a key that was never set', async () => {
    expect(await repo.get('product-sync')).toBeNull()
  })

  it('set then get round-trips the watermark', async () => {
    await repo.set('product-sync', '2026-08-05 09:00:00')
    expect(await repo.get('product-sync')).toBe('2026-08-05 09:00:00')
  })

  it('set upserts (no duplicate-key error on repeated calls) and overwrites the prior value', async () => {
    await repo.set('product-sync', '2026-08-05 09:00:00')
    await repo.set('product-sync', '2026-08-05 10:00:00')
    expect(await repo.get('product-sync')).toBe('2026-08-05 10:00:00')
  })

  it('keeps separate watermarks per key', async () => {
    await repo.set('product-sync', '2026-08-05 09:00:00')
    await repo.set('other-cursor', '2026-01-01 00:00:00')
    expect(await repo.get('product-sync')).toBe('2026-08-05 09:00:00')
    expect(await repo.get('other-cursor')).toBe('2026-01-01 00:00:00')
  })
})
