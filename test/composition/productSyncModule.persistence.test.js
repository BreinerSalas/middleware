import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createProductSyncModule } = require('../../src/composition/productSyncModule.js')

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}
function makeSource({ count = 0, listAll = async () => [] } = {}) {
  return { count: vi.fn(async () => count), listAll: vi.fn(listAll) }
}
function makeGateway({
  batchUpsertBySkus = async () => ({ results: [], errors: [], skipped: [] }),
  upsertBySku = async () => ({ id: 'X', created: true })
} = {}) {
  return { batchUpsertBySkus: vi.fn(batchUpsertBySkus), upsertBySku: vi.fn(upsertBySku) }
}
function p(id, sku, name = `P-${id}`, price = 10) {
  return { id, name, default_code: sku, list_price: price }
}

function makeMappingRepo() {
  return {
    upsert: vi.fn(async () => null),
    bulkUpsertMany: vi.fn(async () => ({ upsertedCount: 0 })),
    findByOdooId: vi.fn(async () => null),
    listAll: vi.fn(async () => []),
    listPaginated: vi.fn(async () => ({ items: [], total: 0, page: 1, limit: 20 }))
  }
}
function makeRunRepo() {
  return {
    start: vi.fn(async (args) => ({ _id: 'RUN-1', ...args })),
    complete: vi.fn(async () => null),
    listRecent: vi.fn(async () => [])
  }
}

describe('productSyncModule - persistence', () => {
  it('starts a run on runOnce and completes it at the end', async () => {
    const odooSource = makeSource({ count: 0, listAll: async () => [] })
    const gateway = makeGateway()
    const mappingRepo = makeMappingRepo()
    const runRepo = makeRunRepo()
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway: gateway,
      mappingRepo, runRepo, logger: makeLogger()
    })
    await m.runOnce({})
    expect(runRepo.start).toHaveBeenCalledTimes(1)
    expect(runRepo.complete).toHaveBeenCalledTimes(1)
    const completeArgs = runRepo.complete.mock.calls[0][0]
    expect(['completed', 'failed']).toContain(completeArgs.status)
  })

  it('persists with-SKU products as ProductMapping records via bulkUpsertMany', async () => {
    const odooSource = makeSource({ count: 3, listAll: async () => [
      p(1, 'A-1'),
      p(2, 'A-2'),
      p(3, false, 'NoSku', 5)
    ] })
    const gateway = makeGateway({
      batchUpsertBySkus: async () => ({
        results: [
          { id: 'HUB-1', properties: { hs_sku: 'A-1' }, new: true, createdAt: 'T', updatedAt: 'T' },
          { id: 'HUB-2', properties: { hs_sku: 'A-2' }, new: false, createdAt: 'T1', updatedAt: 'T2' }
        ],
        errors: [],
        skipped: []
      }),
      upsertBySku: async () => ({ id: 'HUB-3', created: true })
    })
    const mappingRepo = makeMappingRepo()
    const runRepo = makeRunRepo()
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway: gateway,
      mappingRepo, runRepo, logger: makeLogger()
    })
    await m.runOnce({})
    expect(mappingRepo.bulkUpsertMany).toHaveBeenCalledTimes(1)
    const items = mappingRepo.bulkUpsertMany.mock.calls[0][0].items
    expect(items).toHaveLength(2)
    expect(items).toContainEqual(expect.objectContaining({ odooId: 1, hsSku: 'A-1', hubspotId: 'HUB-1', action: 'created' }))
    expect(items).toContainEqual(expect.objectContaining({ odooId: 2, hsSku: 'A-2', hubspotId: 'HUB-2', action: 'updated' }))
  })

  it('marks run as failed and skips mapping persistence when a top-level error occurs', async () => {
    const odooSource = makeSource({ count: 2, listAll: async () => [p(1, 'A-1'), p(2, 'A-2')] })
    const gateway = makeGateway({
      batchUpsertBySkus: async () => { throw new Error('big-boom') }
    })
    const mappingRepo = makeMappingRepo()
    const runRepo = makeRunRepo()
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway: gateway,
      mappingRepo, runRepo, logger: makeLogger()
    })
    await m.runOnce({})
    expect(runRepo.complete).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
    expect(mappingRepo.upsert).not.toHaveBeenCalled()
  })

  it('does not require repos (works without persistence for backwards compat)', async () => {
    const odooSource = makeSource({ count: 1, listAll: async () => [p(1, 'A-1')] })
    const gateway = makeGateway({
      batchUpsertBySkus: async () => ({
        results: [{ id: 'HUB-1', properties: { hs_sku: 'A-1' }, new: true }],
        errors: [],
        skipped: []
      })
    })
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway: gateway, logger: makeLogger()
    })
    const out = await m.runOnce({})
    expect(out.every((r) => !r.failed)).toBe(true)
  })

  it('dryRun=true does not persist any mappings', async () => {
    const odooSource = makeSource({ count: 2, listAll: async () => [p(1, 'A-1'), p(2, 'A-2')] })
    const gateway = makeGateway()
    const mappingRepo = makeMappingRepo()
    const runRepo = makeRunRepo()
    const m = createProductSyncModule({
      config: {}, odooSource, hubspotGateway: gateway,
      mappingRepo, runRepo, logger: makeLogger()
    })
    await m.runOnce({ dryRun: true })
    expect(mappingRepo.bulkUpsertMany).not.toHaveBeenCalled()
    expect(runRepo.start).not.toHaveBeenCalled()
  })
})
