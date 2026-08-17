import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const mongoose = require('mongoose')
const { MongoMemoryServer } = require('mongodb-memory-server')

const { ProductMappingModel } = require('../../../src/adapters/outbound/mongo/schemas/productMapping.schema.js')
const { MongoProductMappingRepository } = require('../../../src/adapters/outbound/mongo/MongoProductMappingRepository.js')

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
  await ProductMappingModel.deleteMany({})
})

describe('MongoProductMappingRepository.findByHubspotId (openspec/hubspot-product-odoo-id-key)', () => {
  it('returns the mapped odooId when a row exists for the hubspotId', async () => {
    const repo = new MongoProductMappingRepository()
    await repo.upsert({ odooId: 42, hsSku: 'AC-1', hubspotId: '46671077999', action: 'created', now: () => 'T' })
    const found = await repo.findByHubspotId('46671077999')
    expect(found).not.toBeNull()
    expect(found.odooId).toBe(42)
    expect(found.hubspotId).toBe('46671077999')
  })

  it('returns null when no row exists for the hubspotId (does NOT guess)', async () => {
    const repo = new MongoProductMappingRepository()
    await repo.upsert({ odooId: 1, hsSku: 'A', hubspotId: 'H-1', action: 'created', now: () => 'T' })
    const found = await repo.findByHubspotId('99999999999')
    expect(found).toBeNull()
  })

  it('returns null when hubspotId is null WITHOUT issuing a Mongo query', async () => {
    const repo = new MongoProductMappingRepository()
    const findOneSpy = vi.spyOn(ProductMappingModel, 'findOne')
    const result = await repo.findByHubspotId(null)
    expect(result).toBeNull()
    expect(findOneSpy).not.toHaveBeenCalled()
    findOneSpy.mockRestore()
  })

  it('returns null when hubspotId is undefined WITHOUT issuing a Mongo query', async () => {
    const repo = new MongoProductMappingRepository()
    const findOneSpy = vi.spyOn(ProductMappingModel, 'findOne')
    const result = await repo.findByHubspotId(undefined)
    expect(result).toBeNull()
    expect(findOneSpy).not.toHaveBeenCalled()
    findOneSpy.mockRestore()
  })

  it('returns null when hubspotId is empty string WITHOUT issuing a Mongo query', async () => {
    const repo = new MongoProductMappingRepository()
    const findOneSpy = vi.spyOn(ProductMappingModel, 'findOne')
    const result = await repo.findByHubspotId('')
    expect(result).toBeNull()
    expect(findOneSpy).not.toHaveBeenCalled()
    findOneSpy.mockRestore()
  })

  it('returns null when hubspotId is the string "null" WITHOUT issuing a Mongo query (pre-existing no_sku_no_match rows store hubspotId: null)', async () => {
    const repo = new MongoProductMappingRepository()
    const findOneSpy = vi.spyOn(ProductMappingModel, 'findOne')
    const result = await repo.findByHubspotId('null')
    expect(result).toBeNull()
    expect(findOneSpy).not.toHaveBeenCalled()
    findOneSpy.mockRestore()
  })
})
