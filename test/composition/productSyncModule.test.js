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

function makeGateway({ upsertBySku = async () => ({ id: 'X', created: true }) } = {}) {
  return {
    upsertBySku: vi.fn(upsertBySku)
  }
}

describe('productSyncModule', () => {
  it('runOnce fetches all from odooSource and syncs each via gateway', async () => {
    const odooSource = makeSource({ count: 3, listAll: async () => [
      { id: 1, name: 'A', default_code: 'A', list_price: 1 },
      { id: 2, name: 'B', default_code: 'B', list_price: 2 },
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
    expect(odooSource.listAll).toHaveBeenCalledWith({ includeNoSku: false })
    expect(hubspotGateway.upsertBySku).toHaveBeenCalledTimes(3)
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
    expect(odooSource.listAll).toHaveBeenCalledWith({ limit: 2, includeNoSku: false })
  })

  it('runOnce with dryRun=true makes 0 gateway calls', async () => {
    const odooSource = makeSource({ count: 2, listAll: async () => [
      { id: 1, name: 'A', default_code: 'A', list_price: 1 },
      { id: 2, name: 'B', default_code: 'B', list_price: 2 }
    ] })
    const hubspotGateway = makeGateway()
    const logger = makeLogger()
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway, logger, concurrency: 10
    })
    const out = await m.runOnce({ dryRun: true })
    expect(hubspotGateway.upsertBySku).not.toHaveBeenCalled()
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ id: 1, dryRun: true, created: false })
  })

  it('runOnce continues when one product fails', async () => {
    const odooSource = makeSource({ count: 3, listAll: async () => [
      { id: 1, name: 'A', default_code: 'A', list_price: 1 },
      { id: 2, name: 'B', default_code: 'B', list_price: 2 },
      { id: 3, name: 'C', default_code: 'C', list_price: 3 }
    ] })
    let n = 0
    const hubspotGateway = makeGateway({
      upsertBySku: async () => {
        n += 1
        if (n === 2) throw new Error('boom')
        return { id: `P-${n}`, created: true }
      }
    })
    const logger = makeLogger()
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway, logger, concurrency: 1
    })
    const out = await m.runOnce({})
    expect(hubspotGateway.upsertBySku).toHaveBeenCalledTimes(3)
    const failed = out.filter((r) => r.failed)
    expect(failed).toHaveLength(1)
    expect(failed[0].error).toBe('boom')
    expect(logger.error).toHaveBeenCalledWith('product-sync.item.failed', expect.objectContaining({ sourceId: 2 }))
    expect(logger.info).toHaveBeenCalledWith('product-sync.done', expect.objectContaining({ failed: 1, succeeded: 2 }))
  })

  it('runOnce counts created vs updated', async () => {
    const odooSource = makeSource({ count: 2, listAll: async () => [
      { id: 1, name: 'A', default_code: 'A', list_price: 1 },
      { id: 2, name: 'B', default_code: 'B', list_price: 2 }
    ] })
    let n = 0
    const hubspotGateway = makeGateway({
      upsertBySku: async () => {
        n += 1
        return { id: `P-${n}`, created: n === 1 }
      }
    })
    const logger = makeLogger()
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway, logger, concurrency: 10
    })
    await m.runOnce({})
    expect(logger.info).toHaveBeenCalledWith('product-sync.done', expect.objectContaining({ created: 1, updated: 1 }))
  })

  it('requires odooSource', () => {
    expect(() => createProductSyncModule({ config: {}, odooSource: null, hubspotGateway: makeGateway() })).toThrow(/odooSource/)
  })

  it('requires hubspotGateway', () => {
    expect(() => createProductSyncModule({ config: {}, odooSource: makeSource(), hubspotGateway: null })).toThrow(/hubspotGateway/)
  })

  it('runOnce({ includeNoSku: true }) forwards to source', async () => {
    const odooSource = makeSource({ count: 11132, listAll: async () => [
      { id: 1, name: 'A', default_code: 'A', list_price: 1 },
      { id: 2, name: 'B', default_code: false, list_price: 2 }
    ] })
    const hubspotGateway = makeGateway()
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway, logger: makeLogger(), concurrency: 10
    })
    await m.runOnce({ includeNoSku: true })
    expect(odooSource.count).toHaveBeenCalledWith({ includeNoSku: true })
    expect(odooSource.listAll).toHaveBeenCalledWith(expect.objectContaining({ includeNoSku: true }))
  })
})
