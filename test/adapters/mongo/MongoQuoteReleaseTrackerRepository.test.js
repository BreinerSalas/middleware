import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const mongoose = require('mongoose')
const { MongoMemoryServer } = require('mongodb-memory-server')

const { QuoteReleaseTrackerModel } = require('../../../src/adapters/outbound/mongo/schemas/quoteReleaseTracker.schema.js')
const { MongoQuoteReleaseTrackerRepository } = require('../../../src/adapters/outbound/mongo/MongoQuoteReleaseTrackerRepository.js')
const { QuoteReleaseTracker, QUOTE_RELEASE_STAGE } = require('../../../src/core/domain/QuoteReleaseTracker.js')

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
  await QuoteReleaseTrackerModel.deleteMany({})
})

describe('MongoQuoteReleaseTrackerRepository', () => {
  it('returns null when no tracker exists for the quoteId', async () => {
    const repo = new MongoQuoteReleaseTrackerRepository()
    const found = await repo.findByQuoteId('quote-1')
    expect(found).toBeNull()
  })

  it('save() upserts a new tracker and findByQuoteId() rehydrates it as a domain instance', async () => {
    const repo = new MongoQuoteReleaseTrackerRepository()
    const tracker = new QuoteReleaseTracker({ quoteId: 'quote-1', dealId: 'deal-1' })
    const saved = await repo.save(tracker)
    expect(saved).toBeInstanceOf(QuoteReleaseTracker)
    expect(saved.quoteId).toBe('quote-1')
    expect(saved.dealId).toBe('deal-1')
    expect(saved.stage).toBe(QUOTE_RELEASE_STAGE.PENDING)

    const found = await repo.findByQuoteId('quote-1')
    expect(found).toBeInstanceOf(QuoteReleaseTracker)
    expect(found.quoteId).toBe('quote-1')
    expect(found.dealId).toBe('deal-1')
    expect(found.stage).toBe(QUOTE_RELEASE_STAGE.PENDING)
  })

  it('save() upserts (updates) an existing tracker by quoteId rather than creating a duplicate', async () => {
    const repo = new MongoQuoteReleaseTrackerRepository()
    const tracker = new QuoteReleaseTracker({ quoteId: 'quote-1', dealId: 'deal-1' })
    await repo.save(tracker)

    tracker.release()
    await repo.save(tracker)

    const count = await QuoteReleaseTrackerModel.countDocuments({ quoteId: 'quote-1' })
    expect(count).toBe(1)

    const found = await repo.findByQuoteId('quote-1')
    expect(found.stage).toBe(QUOTE_RELEASE_STAGE.RELEASED)
  })

  it('save() persists a cancelled stage', async () => {
    const repo = new MongoQuoteReleaseTrackerRepository()
    const tracker = new QuoteReleaseTracker({ quoteId: 'quote-2', dealId: 'deal-2' })
    tracker.cancel()
    await repo.save(tracker)
    const found = await repo.findByQuoteId('quote-2')
    expect(found.stage).toBe(QUOTE_RELEASE_STAGE.CANCELLED)
  })
})
