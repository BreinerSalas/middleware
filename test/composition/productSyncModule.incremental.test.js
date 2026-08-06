import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createProductSyncModule } = require('../../src/composition/productSyncModule.js')

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function makeSource({ pages = [] } = {}) {
  return {
    count: vi.fn(async () => 0),
    listAll: vi.fn(async () => []),
    listChangedSince: vi.fn(async function * (opts) {
      for (const page of pages) yield page
    })
  }
}

function makeGateway({
  batchUpsertBySkus = async (products) => ({
    results: products.map((p) => ({ id: `HUB-${p.id}`, properties: { hs_sku: String(p.default_code).trim() }, new: true })),
    errors: [],
    skipped: []
  }),
  upsertBySku = async () => ({ id: 'X', created: true })
} = {}) {
  return { batchUpsertBySkus: vi.fn(batchUpsertBySkus), upsertBySku: vi.fn(upsertBySku) }
}

function makeMappingRepo() {
  return { bulkUpsertMany: vi.fn(async () => ({ upsertedCount: 0 })) }
}

function makeRunRepo() {
  return {
    start: vi.fn(async (args) => ({ _id: 'RUN-1', ...args })),
    complete: vi.fn(async () => null)
  }
}

function makeCursorRepo({ watermark = null } = {}) {
  return {
    get: vi.fn(async () => watermark),
    set: vi.fn(async () => null)
  }
}

function p(id, sku, writeDate, opts = {}) {
  return { id, name: `P-${id}`, default_code: sku, list_price: 10, write_date: writeDate, active: true, ...opts }
}

describe('productSyncModule.runIncremental (Fase 3 — docs/plan-cambios-2026-08-05.md)', () => {
  it('requires cursorRepo', async () => {
    const odooSource = makeSource({ pages: [] })
    const m = createProductSyncModule({ config: {}, odooSource, hubspotGateway: makeGateway(), logger: makeLogger() })
    await expect(m.runIncremental({})).rejects.toThrow(/cursorRepo/)
  })

  it('uses a far-past default watermark when the cursor has never been set', async () => {
    const odooSource = makeSource({ pages: [] })
    const cursorRepo = makeCursorRepo({ watermark: null })
    const m = createProductSyncModule({ config: {}, odooSource, hubspotGateway: makeGateway(), cursorRepo, logger: makeLogger() })
    await m.runIncremental({})
    expect(odooSource.listChangedSince).toHaveBeenCalledWith(expect.objectContaining({ writeDateGte: expect.stringMatching(/^19|^20/) }))
  })

  it('passes the existing cursor watermark through to listChangedSince', async () => {
    const odooSource = makeSource({ pages: [] })
    const cursorRepo = makeCursorRepo({ watermark: '2026-08-05 09:00:00' })
    const m = createProductSyncModule({ config: {}, odooSource, hubspotGateway: makeGateway(), cursorRepo, logger: makeLogger() })
    await m.runIncremental({ includeNoSku: true })
    expect(odooSource.listChangedSince).toHaveBeenCalledWith({ writeDateGte: '2026-08-05 09:00:00', includeNoSku: true })
  })

  it('dispatches with-SKU rows via batch and without-SKU rows via single, across multiple pages', async () => {
    const odooSource = makeSource({
      pages: [
        [p(1, 'A-1', '2026-08-05 09:00:00'), p(2, false, '2026-08-05 09:01:00')],
        [p(3, 'A-3', '2026-08-05 09:02:00')]
      ]
    })
    const gateway = makeGateway()
    const cursorRepo = makeCursorRepo()
    const m = createProductSyncModule({ config: {}, odooSource, hubspotGateway: gateway, cursorRepo, logger: makeLogger() })
    const out = await m.runIncremental({})
    expect(gateway.batchUpsertBySkus).toHaveBeenCalledTimes(2)
    expect(gateway.upsertBySku).toHaveBeenCalledTimes(1)
    expect(out.results).toHaveLength(3)
    expect(out.failed).toBe(0)
  })

  it('advances the cursor to (max write_date seen - overlapMs) when there are zero failures', async () => {
    const odooSource = makeSource({
      pages: [[p(1, 'A-1', '2026-08-05 09:00:00'), p(2, 'A-2', '2026-08-05 09:05:00')]]
    })
    const cursorRepo = makeCursorRepo()
    const m = createProductSyncModule({ config: {}, odooSource, hubspotGateway: makeGateway(), cursorRepo, logger: makeLogger() })
    const out = await m.runIncremental({ overlapMs: 60_000 })
    expect(out.cursorAdvanced).toBe(true)
    expect(cursorRepo.set).toHaveBeenCalledWith('product-sync', '2026-08-05 09:04:00')
  })

  it('does NOT advance the cursor when any item failed', async () => {
    const odooSource = makeSource({
      pages: [[p(1, 'A-1', '2026-08-05 09:00:00')]]
    })
    const gateway = makeGateway({
      batchUpsertBySkus: async () => ({ results: [], errors: [{ id: 'A-1', message: 'boom', category: 'X' }], skipped: [] })
    })
    const cursorRepo = makeCursorRepo()
    const m = createProductSyncModule({ config: {}, odooSource, hubspotGateway: gateway, cursorRepo, logger: makeLogger() })
    const out = await m.runIncremental({})
    expect(out.failed).toBeGreaterThan(0)
    expect(out.cursorAdvanced).toBe(false)
    expect(cursorRepo.set).not.toHaveBeenCalled()
  })

  it('excludes archived (active=false) rows from sync and counts them separately', async () => {
    const odooSource = makeSource({
      pages: [[p(1, 'A-1', '2026-08-05 09:00:00'), p(2, 'A-2', '2026-08-05 09:00:00', { active: false })]]
    })
    const gateway = makeGateway()
    const cursorRepo = makeCursorRepo()
    const m = createProductSyncModule({ config: {}, odooSource, hubspotGateway: gateway, cursorRepo, logger: makeLogger() })
    const out = await m.runIncremental({})
    expect(out.archived).toBe(1)
    expect(gateway.batchUpsertBySkus.mock.calls[0][0]).toHaveLength(1)
    expect(gateway.batchUpsertBySkus.mock.calls[0][0][0].id).toBe(1)
  })

  it('persists mappings via mappingRepo.bulkUpsertMany like runOnce', async () => {
    const odooSource = makeSource({ pages: [[p(1, 'A-1', '2026-08-05 09:00:00')]] })
    const gateway = makeGateway()
    const mappingRepo = makeMappingRepo()
    const cursorRepo = makeCursorRepo()
    const m = createProductSyncModule({ config: {}, odooSource, hubspotGateway: gateway, mappingRepo, cursorRepo, logger: makeLogger() })
    await m.runIncremental({})
    expect(mappingRepo.bulkUpsertMany).toHaveBeenCalledTimes(1)
    expect(mappingRepo.bulkUpsertMany.mock.calls[0][0].items).toContainEqual(
      expect.objectContaining({ odooId: 1, hsSku: 'A-1', hubspotId: 'HUB-1' })
    )
  })

  it('starts and completes a run via runRepo, same as runOnce', async () => {
    const odooSource = makeSource({ pages: [[p(1, 'A-1', '2026-08-05 09:00:00')]] })
    const runRepo = makeRunRepo()
    const cursorRepo = makeCursorRepo()
    const m = createProductSyncModule({ config: {}, odooSource, hubspotGateway: makeGateway(), runRepo, cursorRepo, logger: makeLogger() })
    await m.runIncremental({})
    expect(runRepo.start).toHaveBeenCalledTimes(1)
    expect(runRepo.complete).toHaveBeenCalledTimes(1)
  })
})
