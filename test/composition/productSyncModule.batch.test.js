import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createProductSyncModule } = require('../../src/composition/productSyncModule.js')

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}

function makeSource({ count = 0, listAll = async () => [] } = {}) {
  return {
    count: vi.fn(async () => count),
    listAll: vi.fn(listAll)
  }
}

function makeGateway({
  batchUpsertBySkus = async () => ({ results: [], errors: [], skipped: [] }),
  upsertBySku = async () => ({ id: 'X', created: true })
} = {}) {
  return {
    batchUpsertBySkus: vi.fn(batchUpsertBySkus),
    upsertBySku: vi.fn(upsertBySku)
  }
}

function p(id, sku, name = `P-${id}`, price = 10) {
  return { id, name, default_code: sku, list_price: price }
}

describe('productSyncModule - batch flow', () => {
  it('splits products into withSku and withoutSku, dispatches to batch + single', async () => {
    const odooSource = makeSource({
      count: 4,
      listAll: async () => [
        p(1, 'A-1', 'A'),
        p(2, false, 'NoSku1'),
        p(3, 'A-3', 'C'),
        p(4, false, 'NoSku2')
      ]
    })
    const gateway = makeGateway({
      batchUpsertBySkus: vi.fn(async (products) => {
        return {
          results: products.map((x) => ({ id: `batch-${x.id}`, properties: {} })),
          errors: [],
          skipped: []
        }
      })
    })
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway: gateway, logger: makeLogger()
    })
    await m.runOnce({})
    expect(gateway.batchUpsertBySkus).toHaveBeenCalledTimes(1)
    const batchArg = gateway.batchUpsertBySkus.mock.calls[0][0]
    expect(batchArg).toHaveLength(2)
    expect(batchArg.map((x) => x.id)).toEqual([1, 3])
    expect(gateway.upsertBySku).toHaveBeenCalledTimes(2)
    const singleArgs = gateway.upsertBySku.mock.calls.map((c) => c[0])
    expect(singleArgs.map((x) => x.id)).toEqual([2, 4])
  })

  it('with 250 products, makes 3 batch calls (chunkSize=100)', async () => {
    const allProducts = Array.from({ length: 250 }, (_, i) => p(i + 1, `A-${i + 1}`))
    const odooSource = makeSource({ count: 250, listAll: async () => allProducts })
    const gateway = makeGateway({
      batchUpsertBySkus: vi.fn(async (chunk) => ({
        results: chunk.map((x) => ({ id: `B-${x.id}`, properties: {} })),
        errors: [],
        skipped: []
      }))
    })
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway: gateway, logger: makeLogger()
    })
    await m.runOnce({})
    expect(gateway.batchUpsertBySkus).toHaveBeenCalledTimes(3)
    const sizes = gateway.batchUpsertBySkus.mock.calls.map((c) => c[0].length)
    expect(sizes).toEqual([100, 100, 50])
  })

  it('dryRun=true makes 0 gateway calls but still counts total', async () => {
    const odooSource = makeSource({ count: 5, listAll: async () => [p(1, 'A'), p(2, false)] })
    const gateway = makeGateway()
    const logger = makeLogger()
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway: gateway, logger
    })
    const out = await m.runOnce({ dryRun: true })
    expect(gateway.batchUpsertBySkus).not.toHaveBeenCalled()
    expect(gateway.upsertBySku).not.toHaveBeenCalled()
    expect(out).toHaveLength(2)
    expect(out.every((x) => x.dryRun === true)).toBe(true)
    expect(logger.info).toHaveBeenCalledWith('product-sync.done', expect.objectContaining({ dryRun: true }))
  })

  it('aggregates per-item errors from batch and continues', async () => {
    const odooSource = makeSource({ count: 4, listAll: async () => [
      p(1, 'A-1'),
      p(2, 'A-2'),
      p(3, 'A-3'),
      p(4, false, 'NoSku')
    ] })
    const gateway = makeGateway({
      batchUpsertBySkus: vi.fn(async () => ({
        results: [{ id: 'B-1', properties: { hs_sku: 'A-1' } }],
        errors: [
          { id: 'A-2', message: 'invalid', category: 'VALIDATION_ERROR' }
        ],
        skipped: []
      })),
      upsertBySku: vi.fn(async () => { throw new Error('network-boom') })
    })
    const logger = makeLogger()
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway: gateway, logger
    })
    const out = await m.runOnce({})
    const failed = out.filter((r) => r.failed)
    expect(failed).toHaveLength(3)
    expect(failed.map((f) => f.error)).toContain('network-boom')
    expect(failed.map((f) => f.error)).toContain('invalid')
    expect(failed.map((f) => f.error)).toContain('not_in_batch_response')
    expect(logger.error).toHaveBeenCalled()
  })

  it('chunkError from batch upsert is marked for the whole chunk', async () => {
    const odooSource = makeSource({ count: 2, listAll: async () => [p(1, 'A-1'), p(2, 'A-2')] })
    const gateway = makeGateway({
      batchUpsertBySkus: vi.fn(async () => { throw new Error('top-level batch-boom') })
    })
    const logger = makeLogger()
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway: gateway, logger
    })
    const out = await m.runOnce({})
    expect(out).toHaveLength(2)
    expect(out.every((r) => r.failed && r.error === 'top-level batch-boom')).toBe(true)
    expect(logger.error).toHaveBeenCalledWith('product-sync.chunk.failed', expect.any(Object))
  })
})
