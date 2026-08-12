import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createPartnerSyncModule } = require('../../src/composition/partnerSyncModule.js')

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
  batchUpsertByOdooIds = async (partners) => ({
    results: partners.map((p) => ({ id: `HUB-${p.id}`, properties: { id_contacto_odoo: String(p.id) }, new: true })),
    errors: [],
    skipped: []
  }),
  idProperty = 'id_contacto_odoo'
} = {}) {
  return { idProperty, batchUpsertByOdooIds: vi.fn(batchUpsertByOdooIds), upsertByOdooId: vi.fn(async () => ({ id: 'X', created: true })) }
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
  return { get: vi.fn(async () => watermark), set: vi.fn(async () => null) }
}

function p(id, writeDate, opts = {}) {
  return { id, name: `P-${id}`, is_company: false, parent_id: false, write_date: writeDate, active: true, ...opts }
}

describe('partnerSyncModule.runIncremental', () => {
  it('requires cursorRepo', async () => {
    const odooSource = makeSource({ pages: [] })
    const m = createPartnerSyncModule({ config: {}, odooSource, hubspotGateway: makeGateway(), logger: makeLogger() })
    await expect(m.runIncremental({})).rejects.toThrow(/cursorRepo/)
  })

  it('uses a far-past default watermark when the cursor has never been set', async () => {
    const odooSource = makeSource({ pages: [] })
    const cursorRepo = makeCursorRepo({ watermark: null })
    const m = createPartnerSyncModule({ config: {}, odooSource, hubspotGateway: makeGateway(), cursorRepo, logger: makeLogger() })
    await m.runIncremental({})
    expect(odooSource.listChangedSince).toHaveBeenCalledWith(expect.objectContaining({ writeDateGte: expect.stringMatching(/^19|^20/) }))
  })

  it('passes the existing cursor watermark through to listChangedSince', async () => {
    const odooSource = makeSource({ pages: [] })
    const cursorRepo = makeCursorRepo({ watermark: '2026-08-05 09:00:00' })
    const m = createPartnerSyncModule({ config: {}, odooSource, hubspotGateway: makeGateway(), cursorRepo, logger: makeLogger() })
    await m.runIncremental({})
    expect(odooSource.listChangedSince).toHaveBeenCalledWith({ writeDateGte: '2026-08-05 09:00:00' })
  })

  it('batch-upserts every partner across multiple pages', async () => {
    const odooSource = makeSource({
      pages: [
        [p(1, '2026-08-05 09:00:00'), p(2, '2026-08-05 09:01:00')],
        [p(3, '2026-08-05 09:02:00')]
      ]
    })
    const gateway = makeGateway()
    const cursorRepo = makeCursorRepo()
    const m = createPartnerSyncModule({ config: {}, odooSource, hubspotGateway: gateway, cursorRepo, logger: makeLogger() })
    const out = await m.runIncremental({})
    expect(gateway.batchUpsertByOdooIds).toHaveBeenCalledTimes(2)
    expect(out.results).toHaveLength(3)
    expect(out.failed).toBe(0)
  })

  it('advances the cursor to (max write_date seen - overlapMs) when there are zero failures', async () => {
    const odooSource = makeSource({
      pages: [[p(1, '2026-08-05 09:00:00'), p(2, '2026-08-05 09:05:00')]]
    })
    const cursorRepo = makeCursorRepo()
    const m = createPartnerSyncModule({ config: {}, odooSource, hubspotGateway: makeGateway(), cursorRepo, logger: makeLogger() })
    const out = await m.runIncremental({ overlapMs: 60_000 })
    expect(out.cursorAdvanced).toBe(true)
    expect(cursorRepo.set).toHaveBeenCalledWith('partner-sync', '2026-08-05 09:04:00')
  })

  it('does NOT advance the cursor when any item failed', async () => {
    const odooSource = makeSource({ pages: [[p(1, '2026-08-05 09:00:00')]] })
    const gateway = makeGateway({
      batchUpsertByOdooIds: async () => ({ results: [], errors: [{ id: '1', message: 'boom', category: 'X' }], skipped: [] })
    })
    const cursorRepo = makeCursorRepo()
    const m = createPartnerSyncModule({ config: {}, odooSource, hubspotGateway: gateway, cursorRepo, logger: makeLogger() })
    const out = await m.runIncremental({})
    expect(out.failed).toBeGreaterThan(0)
    expect(out.cursorAdvanced).toBe(false)
    expect(cursorRepo.set).not.toHaveBeenCalled()
  })

  it('advances the cursor when the only outcome is a permanently-skipped invalid email (not a failure)', async () => {
    // Regression: a single permanently-bad email (HubSpot INVALID_EMAIL/VALIDATION_ERROR) must
    // be classified as `skipped`, not `failed`, or it would wedge the incremental watermark
    // forever and block every partner after it in write_date order on every tick.
    const odooSource = makeSource({
      pages: [[p(1, '2026-08-05 09:05:00')]]
    })
    const gateway = makeGateway({
      batchUpsertByOdooIds: async () => ({
        results: [],
        errors: [],
        skipped: [{ sourceId: 1, reason: 'invalid_property_value' }]
      })
    })
    const cursorRepo = makeCursorRepo()
    const m = createPartnerSyncModule({ config: {}, odooSource, hubspotGateway: gateway, cursorRepo, logger: makeLogger() })
    const out = await m.runIncremental({ overlapMs: 60_000 })
    expect(out.failed).toBe(0)
    expect(out.skipped).toBe(1)
    expect(out.cursorAdvanced).toBe(true)
    expect(cursorRepo.set).toHaveBeenCalledWith('partner-sync', '2026-08-05 09:04:00')
  })

  it('excludes archived (active=false) rows from sync and counts them separately', async () => {
    const odooSource = makeSource({
      pages: [[p(1, '2026-08-05 09:00:00'), p(2, '2026-08-05 09:00:00', { active: false })]]
    })
    const gateway = makeGateway()
    const cursorRepo = makeCursorRepo()
    const m = createPartnerSyncModule({ config: {}, odooSource, hubspotGateway: gateway, cursorRepo, logger: makeLogger() })
    const out = await m.runIncremental({})
    expect(out.archived).toBe(1)
    expect(gateway.batchUpsertByOdooIds.mock.calls[0][0]).toHaveLength(1)
    expect(gateway.batchUpsertByOdooIds.mock.calls[0][0][0].id).toBe(1)
  })

  it('persists mappings via mappingRepo.bulkUpsertMany', async () => {
    const odooSource = makeSource({ pages: [[p(1, '2026-08-05 09:00:00')]] })
    const gateway = makeGateway()
    const mappingRepo = makeMappingRepo()
    const cursorRepo = makeCursorRepo()
    const m = createPartnerSyncModule({ config: {}, odooSource, hubspotGateway: gateway, mappingRepo, cursorRepo, logger: makeLogger() })
    await m.runIncremental({})
    expect(mappingRepo.bulkUpsertMany).toHaveBeenCalledTimes(1)
    expect(mappingRepo.bulkUpsertMany.mock.calls[0][0].items).toContainEqual(
      expect.objectContaining({ odooId: 1, hubspotId: 'HUB-1' })
    )
  })

  it('does not persist mappings when the batch call throws', async () => {
    const odooSource = makeSource({ pages: [[p(1, '2026-08-05 09:00:00')]] })
    const gateway = makeGateway({ batchUpsertByOdooIds: async () => { throw new Error('hubspot-down') } })
    const mappingRepo = makeMappingRepo()
    const cursorRepo = makeCursorRepo()
    const m = createPartnerSyncModule({ config: {}, odooSource, hubspotGateway: gateway, mappingRepo, cursorRepo, logger: makeLogger() })
    const out = await m.runIncremental({})
    expect(mappingRepo.bulkUpsertMany).not.toHaveBeenCalled()
    expect(out.cursorAdvanced).toBe(false)
  })

  it('starts and completes a run via runRepo, recording the archived counter', async () => {
    const odooSource = makeSource({
      pages: [[p(1, '2026-08-05 09:00:00'), p(2, '2026-08-05 09:00:00', { active: false })]]
    })
    const runRepo = makeRunRepo()
    const cursorRepo = makeCursorRepo()
    const m = createPartnerSyncModule({ config: {}, odooSource, hubspotGateway: makeGateway(), runRepo, cursorRepo, logger: makeLogger() })
    await m.runIncremental({})
    expect(runRepo.start).toHaveBeenCalledTimes(1)
    expect(runRepo.complete).toHaveBeenCalledTimes(1)
    expect(runRepo.complete.mock.calls[0][0]).toMatchObject({ archived: 1 })
  })
})
