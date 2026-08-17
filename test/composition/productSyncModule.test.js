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

function makeGateway({ upsertByOdooId = async () => ({ id: 'X', created: true }), batchUpsertByOdooIds } = {}) {
  const gateway = {
    batchUpsertByOdooIds: vi.fn(batchUpsertByOdooIds || (async (products) => ({
      results: products.map((p) => ({ id: `BATCH-${p.id}`, properties: { id_producto_odoo: String(p.id) } })),
      errors: [],
      skipped: []
    }))),
    upsertByOdooId: vi.fn(upsertByOdooId)
  }
  return gateway
}

describe('productSyncModule (openspec/hubspot-product-odoo-id-key — Odoo-id key)', () => {
  it('runOnce fetches all from odooSource and dispatches ONE batch call (no SKU partition)', async () => {
    const odooSource = makeSource({ count: 3, listAll: async () => [
      { id: 1, name: 'A', default_code: 'A', list_price: 1 },
      { id: 2, name: 'B', default_code: false, list_price: 2 },
      { id: 3, name: 'C', default_code: 'C', list_price: 3 }
    ] })
    const hubspotGateway = makeGateway()
    const logger = makeLogger()
    const m = createProductSyncModule({
      config: { logging: { level: 'info' } },
      odooSource, hubspotGateway, logger, concurrency: 10
    })
    const out = await m.runOnce({})
    expect(odooSource.count).toHaveBeenCalledTimes(1)
    // Default is now includeNoSku: true (full-catalog sync)
    expect(odooSource.listAll).toHaveBeenCalledWith({ includeNoSku: true })
    expect(hubspotGateway.batchUpsertByOdooIds).toHaveBeenCalledTimes(1)
    expect(hubspotGateway.batchUpsertByOdooIds.mock.calls[0][0]).toHaveLength(3)
    // No single-item path anymore — single upsert only used for incremental pages with chunks <1
    expect(hubspotGateway.upsertByOdooId).not.toHaveBeenCalled()
    expect(out).toHaveLength(3)
    expect(logger.info).toHaveBeenCalledWith('product-sync.start', expect.objectContaining({ total: 3 }))
    expect(logger.info).toHaveBeenCalledWith('product-sync.done', expect.objectContaining({ count: 3 }))
  })

  it('runOnce with limit passes through to source', async () => {
    const odooSource = makeSource({ count: 100, listAll: async () => [
      { id: 1, name: 'A', default_code: 'A', list_price: 1 },
      { id: 2, name: 'B', default_code: 'B', list_price: 2 }
    ] })
    const hubspotGateway = makeGateway()
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway, logger: makeLogger(), concurrency: 10
    })
    await m.runOnce({ limit: 2 })
    expect(odooSource.listAll).toHaveBeenCalledWith({ limit: 2, includeNoSku: true })
  })

  it('runOnce with dryRun=true makes 0 gateway calls', async () => {
    const odooSource = makeSource({ count: 2, listAll: async () => [
      { id: 1, name: 'A', default_code: 'A', list_price: 1 },
      { id: 2, name: 'B', default_code: false, list_price: 2 }
    ] })
    const hubspotGateway = makeGateway()
    const logger = makeLogger()
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway, logger, concurrency: 10
    })
    const out = await m.runOnce({ dryRun: true })
    expect(hubspotGateway.batchUpsertByOdooIds).not.toHaveBeenCalled()
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ id: 1, dryRun: true, created: false, skipped: true })
  })

  it('runOnce continues when a chunk fails (per-item errors propagated)', async () => {
    const odooSource = makeSource({ count: 3, listAll: async () => [
      { id: 1, name: 'A', default_code: 'A', list_price: 1 },
      { id: 2, name: 'B', default_code: 'B', list_price: 2 },
      { id: 3, name: 'C', default_code: 'C', list_price: 3 }
    ] })
    const hubspotGateway = makeGateway({
      batchUpsertByOdooIds: async (products) => ({
        results: [products[0]].map((p) => ({ id: 'BATCH-P1', properties: { id_producto_odoo: String(p.id) } })),
        errors: products.slice(1).map((p) => ({ id: String(p.id), message: 'bad-batch', category: 'X' })),
        skipped: []
      })
    })
    const logger = makeLogger()
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway, logger, concurrency: 1
    })
    const out = await m.runOnce({})
    const failed = out.filter((r) => r.failed)
    expect(failed).toHaveLength(2)
    expect(failed[0].error).toBe('bad-batch')
    expect(logger.error).toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith('product-sync.done', expect.objectContaining({ failed: 2, succeeded: 1 }))
  })

  it('runOnce counts created vs updated from batch results (correlation by sent Odoo id)', async () => {
    const odooSource = makeSource({ count: 2, listAll: async () => [
      { id: 1, name: 'A', default_code: 'A', list_price: 1 },
      { id: 2, name: 'B', default_code: 'B', list_price: 2 }
    ] })
    const hubspotGateway = makeGateway({
      batchUpsertByOdooIds: async () => ({
        results: [
          { id: 'P-1', properties: { id_producto_odoo: '1' }, createdAt: 'T', updatedAt: 'T' },
          { id: 'P-2', properties: { id_producto_odoo: '2' }, createdAt: 'T', updatedAt: 'T2' }
        ],
        errors: [],
        skipped: []
      })
    })
    const logger = makeLogger()
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway, logger, concurrency: 10
    })
    await m.runOnce({})
    expect(logger.info).toHaveBeenCalledWith('product-sync.done', expect.objectContaining({ created: 1, updated: 1 }))
  })

  it('correlates batch results by sent Odoo id even when the echo is absent/mismatched', async () => {
    const odooSource = makeSource({ count: 2, listAll: async () => [
      { id: 42, name: 'A', default_code: 'AC-1170', list_price: 1 },
      { id: 99, name: 'B', default_code: 'OTHER', list_price: 2 }
    ] })
    const hubspotGateway = makeGateway({
      batchUpsertByOdooIds: async () => ({
        results: [
          { id: 'P-1', properties: { id_producto_odoo: '42' }, createdAt: 'T', updatedAt: 'T' },
          // No id_producto_odoo echo on the second — correlation must still work via inputs[i].id
          { id: 'P-2', properties: {}, createdAt: 'T', updatedAt: 'T' }
        ],
        errors: [],
        skipped: []
      })
    })
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway, logger: makeLogger(), concurrency: 10
    })
    const out = await m.runOnce({})
    const succeeded = out.filter((r) => !r.failed && !r.dryRun && !r.skipped)
    expect(succeeded).toHaveLength(2)
    expect(succeeded.find((r) => r.sourceId === 42)).toMatchObject({ hubspotId: 'P-1', action: 'created' })
    expect(succeeded.find((r) => r.sourceId === 99)).toMatchObject({ hubspotId: 'P-2', action: 'created' })
  })

  it('requires odooSource', () => {
    expect(() => createProductSyncModule({ config: {}, odooSource: null, hubspotGateway: makeGateway() })).toThrow(/odooSource/)
  })

  it('requires hubspotGateway', () => {
    expect(() => createProductSyncModule({ config: {}, odooSource: makeSource(), hubspotGateway: null })).toThrow(/hubspotGateway/)
  })

  it('runOnce({ includeNoSku: false }) forwards to source (opt-out still works)', async () => {
    const odooSource = makeSource({ count: 5848, listAll: async () => [
      { id: 1, name: 'A', default_code: 'A', list_price: 1 },
      { id: 2, name: 'B', default_code: false, list_price: 2 }
    ] })
    const hubspotGateway = makeGateway()
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway, logger: makeLogger(), concurrency: 10
    })
    await m.runOnce({ includeNoSku: false })
    expect(odooSource.count).toHaveBeenCalledWith({ includeNoSku: false })
    expect(odooSource.listAll).toHaveBeenCalledWith(expect.objectContaining({ includeNoSku: false }))
  })
})
