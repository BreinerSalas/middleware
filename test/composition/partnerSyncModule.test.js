import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createPartnerSyncModule } = require('../../src/composition/partnerSyncModule.js')

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function makeSource({ count = 0, listAll = async () => [] } = {}) {
  return {
    count: vi.fn(async () => count),
    listAll: vi.fn(listAll)
  }
}

function makeGateway({
  batchUpsertByOdooIds = async (partners) => ({
    results: partners.map((p) => ({ id: `BATCH-${p.id}`, properties: { id_contacto_odoo: String(p.id) }, new: true })),
    errors: [],
    skipped: []
  }),
  upsertByOdooId = async () => ({ id: 'X', created: true }),
  idProperty = 'id_contacto_odoo'
} = {}) {
  return {
    idProperty,
    batchUpsertByOdooIds: vi.fn(batchUpsertByOdooIds),
    upsertByOdooId: vi.fn(upsertByOdooId)
  }
}

describe('partnerSyncModule', () => {
  it('requires odooSource', () => {
    expect(() => createPartnerSyncModule({ config: {}, odooSource: null, hubspotGateway: makeGateway() })).toThrow(/odooSource/)
  })

  it('requires hubspotGateway', () => {
    expect(() => createPartnerSyncModule({ config: {}, odooSource: makeSource(), hubspotGateway: null })).toThrow(/hubspotGateway/)
  })

  it('runOnce fetches all from odooSource and batch-upserts every partner (no partition)', async () => {
    const odooSource = makeSource({
      count: 2,
      listAll: async () => [
        { id: 1, name: 'Ana', is_company: false, parent_id: false },
        { id: 2, name: 'Beto', is_company: false, parent_id: false }
      ]
    })
    const hubspotGateway = makeGateway()
    const logger = makeLogger()
    const m = createPartnerSyncModule({ config: {}, odooSource, hubspotGateway, logger, concurrency: 10 })
    const out = await m.runOnce({})
    expect(odooSource.count).toHaveBeenCalledTimes(1)
    expect(odooSource.listAll).toHaveBeenCalledWith({})
    expect(hubspotGateway.batchUpsertByOdooIds).toHaveBeenCalledTimes(1)
    expect(hubspotGateway.batchUpsertByOdooIds.mock.calls[0][0]).toHaveLength(2)
    expect(out).toHaveLength(2)
    expect(logger.info).toHaveBeenCalledWith('partner-sync.start', expect.objectContaining({ total: 2 }))
    expect(logger.info).toHaveBeenCalledWith('partner-sync.done', expect.objectContaining({ count: 2 }))
  })

  it('runOnce with limit passes through to source', async () => {
    const odooSource = makeSource({
      count: 100,
      listAll: async () => [{ id: 1, name: 'Ana', is_company: false, parent_id: false }]
    })
    const hubspotGateway = makeGateway()
    const m = createPartnerSyncModule({ config: {}, odooSource, hubspotGateway, logger: makeLogger() })
    await m.runOnce({ limit: 1 })
    expect(odooSource.listAll).toHaveBeenCalledWith({ limit: 1 })
  })

  it('runOnce with dryRun=true makes zero gateway calls and returns dry-run entries per partner', async () => {
    const odooSource = makeSource({
      count: 2,
      listAll: async () => [
        { id: 1, name: 'Ana', is_company: false, parent_id: false },
        { id: 2, name: 'Beto', is_company: false, parent_id: false }
      ]
    })
    const hubspotGateway = makeGateway()
    const logger = makeLogger()
    const m = createPartnerSyncModule({ config: {}, odooSource, hubspotGateway, logger })
    const out = await m.runOnce({ dryRun: true })
    expect(hubspotGateway.batchUpsertByOdooIds).not.toHaveBeenCalled()
    expect(hubspotGateway.upsertByOdooId).not.toHaveBeenCalled()
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ sourceId: 1, dryRun: true, created: false, skipped: true })
  })

  it('runOnce counts created vs failed from batch results', async () => {
    const odooSource = makeSource({
      count: 2,
      listAll: async () => [
        { id: 1, name: 'Ana', is_company: false, parent_id: false },
        { id: 2, name: 'Beto', is_company: false, parent_id: false }
      ]
    })
    const hubspotGateway = makeGateway({
      batchUpsertByOdooIds: async () => ({
        results: [
          { id: 'C-1', properties: { id_contacto_odoo: '1' }, new: true },
          { id: 'C-2', properties: { id_contacto_odoo: '2' }, createdAt: 'T', updatedAt: 'T2' }
        ],
        errors: [],
        skipped: []
      })
    })
    const logger = makeLogger()
    const m = createPartnerSyncModule({ config: {}, odooSource, hubspotGateway, logger })
    await m.runOnce({})
    expect(logger.info).toHaveBeenCalledWith('partner-sync.done', expect.objectContaining({ created: 1, failed: 0 }))
  })

  it('runOnce continues past per-item batch errors and reports them as failed', async () => {
    const odooSource = makeSource({
      count: 2,
      listAll: async () => [
        { id: 1, name: 'Ana', is_company: false, parent_id: false },
        { id: 2, name: 'Beto', is_company: false, parent_id: false }
      ]
    })
    const hubspotGateway = makeGateway({
      batchUpsertByOdooIds: async () => ({
        results: [{ id: 'C-1', properties: { id_contacto_odoo: '1' }, new: true }],
        errors: [{ id: '2', message: 'bad-request', category: 'VALIDATION_ERROR' }],
        skipped: []
      })
    })
    const logger = makeLogger()
    const m = createPartnerSyncModule({ config: {}, odooSource, hubspotGateway, logger })
    const out = await m.runOnce({})
    const failed = out.filter((r) => r.failed)
    expect(failed).toHaveLength(1)
    expect(failed[0].sourceId).toBe(2)
    expect(logger.error).toHaveBeenCalled()
  })

  it('runOnce reports a partner only present in batchSummary.skipped as skipped (not also as assumed-updated)', async () => {
    const odooSource = makeSource({
      count: 2,
      listAll: async () => [
        { id: 1, name: 'Ana', is_company: false, parent_id: false },
        { id: 2, name: 'Duplicate Email Co', is_company: false, parent_id: false }
      ]
    })
    const hubspotGateway = makeGateway({
      batchUpsertByOdooIds: async () => ({
        results: [{ id: 'C-1', properties: { id_contacto_odoo: '1' }, new: true }],
        errors: [],
        skipped: [{ sourceId: 2, reason: 'duplicate_in_hubspot' }]
      })
    })
    const logger = makeLogger()
    const m = createPartnerSyncModule({ config: {}, odooSource, hubspotGateway, logger })
    const out = await m.runOnce({})
    const forPartner2 = out.filter((r) => r.sourceId === 2)
    expect(forPartner2).toHaveLength(1)
    expect(forPartner2[0]).toMatchObject({ skipped: true, reason: 'duplicate_in_hubspot' })
    expect(logger.info).toHaveBeenCalledWith('partner-sync.done', expect.objectContaining({ created: 1, failed: 0, skipped: 1 }))
  })

  it('syncOneItem delegates to hubspotGateway.upsertByOdooId when not dryRun', async () => {
    const hubspotGateway = makeGateway({ upsertByOdooId: async () => ({ id: 'Z', created: false }) })
    const m = createPartnerSyncModule({ config: {}, odooSource: makeSource(), hubspotGateway, logger: makeLogger() })
    const r = await m.syncOneItem({ id: 9, name: 'X' }, { dryRun: false })
    expect(hubspotGateway.upsertByOdooId).toHaveBeenCalledWith({ id: 9, name: 'X' })
    expect(r).toEqual({ id: 'Z', created: false })
  })

  it('syncOneItem returns a dry-run entry without calling the gateway when dryRun=true', async () => {
    const hubspotGateway = makeGateway()
    const m = createPartnerSyncModule({ config: {}, odooSource: makeSource(), hubspotGateway, logger: makeLogger() })
    const r = await m.syncOneItem({ id: 9, name: 'X' }, { dryRun: true })
    expect(hubspotGateway.upsertByOdooId).not.toHaveBeenCalled()
    expect(r).toMatchObject({ id: 9, dryRun: true, created: false, skipped: true })
  })
})
