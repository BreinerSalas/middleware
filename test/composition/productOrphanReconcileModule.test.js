import { describe, it, expect, vi } from 'vitest'
import { createProductOrphanReconcileModule, reconcileOrphans } from '../../src/composition/productOrphanReconcileModule.js'

// (sdd/hubspot-product-reverse-discovery, Phase 2) Staged decision pipeline per design:
// D6 promote (unchanged) -> Track A (Odoo price disambiguation) -> Track B (HubSpot mapped-
// sibling archive) -> quarantine as terminal fallback. See design.md "Decision pipeline".

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function makeOdooApi({ nameMap = {}, prices = {} } = {}) {
  return {
    searchProductIdsByNames: vi.fn(async () => nameMap),
    readProductPrices: vi.fn(async () => prices)
  }
}

function makeMappingRepo({ findByOdooId = null } = {}) {
  return {
    upsert: vi.fn(async () => null),
    findByOdooId: vi.fn(async (odooId) => (findByOdooId ? findByOdooId(odooId) : null))
  }
}

function makeOrphanRepo() {
  return {
    recordArchivePending: vi.fn(async () => null),
    markArchived: vi.fn(async () => null),
    markArchiveFailed: vi.fn(async () => null),
    upsertQuarantine: vi.fn(async () => null)
  }
}

// `s2Responder(rawName)` controls what the S2 HubSpot uniqueness re-search returns.
function makeHubspotApi({ orphans = [], s2Responder = () => ({ results: [], total: 0 }) } = {}) {
  return {
    searchProducts: vi.fn(async ({ filterGroups }) => {
      const isOrphanQuery = filterGroups.some((g) =>
        g.filters.some((f) => f.propertyName === 'id_producto_odoo' && f.operator === 'NOT_HAS_PROPERTY')
      )
      if (isOrphanQuery) return { results: orphans, paging: null }
      const rawName = filterGroups[0].filters[0].value
      return s2Responder(rawName)
    }),
    batchUpdateProducts: vi.fn(async () => ({ results: [], errors: [], numErrors: 0 })),
    batchArchiveProducts: vi.fn(async () => ({ archived: 1, errors: [] })),
    searchLineItemsByProductId: vi.fn(async () => ({ total: 0, results: [] }))
  }
}

function orphan(id, name, price) {
  return { id, properties: { name, price: price != null ? String(price) : undefined } }
}

describe('createProductOrphanReconcileModule', () => {
  it('exposes a .run() method (factory contract per design)', () => {
    const mod = createProductOrphanReconcileModule({
      hubspotApi: makeHubspotApi(),
      odooApi: makeOdooApi(),
      mappingRepo: makeMappingRepo()
    })
    expect(typeof mod.run).toBe('function')
  })

  describe('D6 promote (unchanged)', () => {
    it('promotes when odooMatches===1 and hubspotMatches===1', async () => {
      const hubspotApi = makeHubspotApi({
        orphans: [orphan('HUB-1', 'UNIQUE ITEM', 10)],
        s2Responder: () => ({ results: [{ id: 'HUB-1', properties: { name: 'UNIQUE ITEM', price: '10', id_producto_odoo: null } }], total: 1 })
      })
      const odooApi = makeOdooApi({ nameMap: { 'unique item': { id: 501, matches: 1, ids: [501] } } })
      const mappingRepo = makeMappingRepo()
      const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
      expect(result.promoted).toContainEqual(expect.objectContaining({ odooId: 501, hubspotId: 'HUB-1' }))
      expect(hubspotApi.batchUpdateProducts).toHaveBeenCalledWith({
        inputs: [{ id: 'HUB-1', properties: { id_producto_odoo: '501' } }]
      })
    })
  })

  describe('Track A: Odoo price disambiguation (odooMatches >= 2)', () => {
    it('auto-links when exactly one Odoo candidate price matches the orphan price', async () => {
      const hubspotApi = makeHubspotApi({
        orphans: [orphan('HUB-2', 'AMBIGUOUS NAME', 25.5)],
        s2Responder: () => ({ results: [{ id: 'HUB-2', properties: { name: 'AMBIGUOUS NAME', price: '25.50' } }], total: 1 })
      })
      const odooApi = makeOdooApi({
        nameMap: { 'ambiguous name': { id: 10, matches: 2, ids: [10, 11] } },
        prices: { 10: 25.5, 11: 40.0 }
      })
      const mappingRepo = makeMappingRepo()
      const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
      expect(result.promoted).toContainEqual(expect.objectContaining({ odooId: 10, hubspotId: 'HUB-2' }))
      expect(result.quarantined).toEqual([])
    })

    it('quarantines price_no_match_in_odoo when zero candidates match the price', async () => {
      const hubspotApi = makeHubspotApi({ orphans: [orphan('HUB-3', 'AMBIGUOUS NAME', 99.99)] })
      const odooApi = makeOdooApi({
        nameMap: { 'ambiguous name': { id: 10, matches: 2, ids: [10, 11] } },
        prices: { 10: 25.5, 11: 40.0 }
      })
      const mappingRepo = makeMappingRepo()
      const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
      expect(result.quarantined).toContainEqual(expect.objectContaining({ hubspotId: 'HUB-3', reason: 'price_no_match_in_odoo' }))
      expect(hubspotApi.batchUpdateProducts).not.toHaveBeenCalled()
    })

    it('quarantines ambiguous_after_price when two or more candidates match the price (never guesses)', async () => {
      const hubspotApi = makeHubspotApi({ orphans: [orphan('HUB-4', 'AMBIGUOUS NAME', 25.5)] })
      const odooApi = makeOdooApi({
        nameMap: { 'ambiguous name': { id: 10, matches: 2, ids: [10, 11] } },
        prices: { 10: 25.5, 11: 25.5 }
      })
      const mappingRepo = makeMappingRepo()
      const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
      expect(result.quarantined).toContainEqual(expect.objectContaining({ hubspotId: 'HUB-4', reason: 'ambiguous_after_price' }))
      expect(hubspotApi.batchUpdateProducts).not.toHaveBeenCalled()
    })
  })

  describe('Track B: HubSpot mapped-sibling archive (hubspotMatches >= 2)', () => {
    function siblingSetup({ referencedTotal = 0 } = {}) {
      const orphans = [orphan('HUB-ORPHAN', 'DUPLICATED ITEM', 15)]
      const hubspotApi = makeHubspotApi({
        orphans,
        s2Responder: () => ({
          results: [
            { id: 'HUB-ORPHAN', properties: { name: 'DUPLICATED ITEM', price: '15', id_producto_odoo: null } },
            { id: 'HUB-SIBLING', properties: { name: 'DUPLICATED ITEM', price: '15', id_producto_odoo: '777' } }
          ],
          total: 2
        })
      })
      hubspotApi.searchLineItemsByProductId = vi.fn(async () => ({ total: referencedTotal, results: [] }))
      const odooApi = makeOdooApi({ nameMap: { 'duplicated item': { id: 1, matches: 1, ids: [1] } } })
      const mappingRepo = makeMappingRepo()
      return { hubspotApi, odooApi, mappingRepo }
    }

    it('archives the unreferenced duplicate and reports an archive audit row', async () => {
      const { hubspotApi, odooApi, mappingRepo } = siblingSetup({ referencedTotal: 0 })
      const orphanRepo = makeOrphanRepo()
      const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, orphanRepo, logger: makeLogger(), dryRun: false })
      expect(result.archived).toContainEqual(
        expect.objectContaining({ hubspotId: 'HUB-ORPHAN', siblingHubspotId: 'HUB-SIBLING', siblingOdooId: '777' })
      )
      expect(orphanRepo.recordArchivePending).toHaveBeenCalledWith(
        expect.objectContaining({ hubspotId: 'HUB-ORPHAN', siblingHubspotId: 'HUB-SIBLING', siblingOdooId: '777' })
      )
      expect(hubspotApi.batchArchiveProducts).toHaveBeenCalledWith({ inputs: [{ id: 'HUB-ORPHAN' }] })
      expect(orphanRepo.markArchived).toHaveBeenCalledWith({ hubspotId: 'HUB-ORPHAN' })
      expect(result.quarantined).toEqual([])
    })

    it('defers to quarantine instead of archiving blind when no orphanRepo is wired (no durable audit record yet)', async () => {
      const { hubspotApi, odooApi, mappingRepo } = siblingSetup({ referencedTotal: 0 })
      const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
      expect(result.quarantined).toContainEqual(
        expect.objectContaining({ hubspotId: 'HUB-ORPHAN', reason: 'archive_deferred_no_audit_repo' })
      )
      expect(hubspotApi.batchArchiveProducts).not.toHaveBeenCalled()
      expect(result.archived).toEqual([])
    })

    it('quarantines referenced_by_line_item instead of archiving when the orphan is referenced', async () => {
      const { hubspotApi, odooApi, mappingRepo } = siblingSetup({ referencedTotal: 1 })
      const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
      expect(result.quarantined).toContainEqual(expect.objectContaining({ hubspotId: 'HUB-ORPHAN', reason: 'referenced_by_line_item' }))
      expect(hubspotApi.batchArchiveProducts).not.toHaveBeenCalled()
      expect(result.archived).toEqual([])
    })

    it('quarantines ambiguous_in_hubspot when no mapped sibling matches name+price', async () => {
      const orphans = [orphan('HUB-NOSIB', 'DUPLICATED ITEM', 15)]
      const hubspotApi = makeHubspotApi({
        orphans,
        s2Responder: () => ({
          results: [
            { id: 'HUB-NOSIB', properties: { name: 'DUPLICATED ITEM', price: '15', id_producto_odoo: null } },
            { id: 'HUB-OTHER', properties: { name: 'DUPLICATED ITEM', price: '15', id_producto_odoo: null } }
          ],
          total: 2
        })
      })
      const odooApi = makeOdooApi({ nameMap: { 'duplicated item': { id: 1, matches: 1, ids: [1] } } })
      const mappingRepo = makeMappingRepo()
      const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
      expect(result.quarantined).toContainEqual(expect.objectContaining({ hubspotId: 'HUB-NOSIB', reason: 'ambiguous_in_hubspot' }))
      expect(hubspotApi.batchArchiveProducts).not.toHaveBeenCalled()
    })
  })

  describe('S2 zero-result edge case', () => {
    it('quarantines hubspot_self_missing when the S2 re-search returns zero results', async () => {
      const hubspotApi = makeHubspotApi({
        orphans: [orphan('HUB-GONE', 'VANISHED ITEM', 5)],
        s2Responder: () => ({ results: [], total: 0 })
      })
      const odooApi = makeOdooApi({ nameMap: { 'vanished item': { id: 3, matches: 1, ids: [3] } } })
      const mappingRepo = makeMappingRepo()
      const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
      expect(result.quarantined).toContainEqual(expect.objectContaining({ hubspotId: 'HUB-GONE', reason: 'hubspot_self_missing' }))
    })
  })

  describe('D6 write order (Mongo-first)', () => {
    it('calls mappingRepo.upsert BEFORE hubspotApi.batchUpdateProducts on the promote path', async () => {
      const callOrder = []
      const hubspotApi = makeHubspotApi({
        orphans: [orphan('HUB-ORDER', 'ORDER ITEM', 12)],
        s2Responder: () => ({ results: [{ id: 'HUB-ORDER', properties: { name: 'ORDER ITEM', price: '12' } }], total: 1 })
      })
      hubspotApi.batchUpdateProducts = vi.fn(async () => {
        callOrder.push('hubspot')
        return { results: [], errors: [], numErrors: 0 }
      })
      const odooApi = makeOdooApi({ nameMap: { 'order item': { id: 22, matches: 1, ids: [22] } } })
      const mappingRepo = makeMappingRepo()
      mappingRepo.upsert = vi.fn(async () => { callOrder.push('mongo') })
      await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
      expect(callOrder).toEqual(['mongo', 'hubspot'])
    })

    it('keeps the Mongo mapping and quarantines hubspot_write_pending when the HubSpot write fails (self-healing)', async () => {
      const hubspotApi = makeHubspotApi({
        orphans: [orphan('HUB-FAIL', 'FAIL ITEM', 12)],
        s2Responder: () => ({ results: [{ id: 'HUB-FAIL', properties: { name: 'FAIL ITEM', price: '12' } }], total: 1 })
      })
      hubspotApi.batchUpdateProducts = vi.fn(async () => { throw new Error('HubSpot rate limited') })
      const odooApi = makeOdooApi({ nameMap: { 'fail item': { id: 33, matches: 1, ids: [33] } } })
      const mappingRepo = makeMappingRepo()
      const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
      expect(mappingRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ odooId: 33, hubspotId: 'HUB-FAIL', action: 'backfilled' })
      )
      expect(result.quarantined).toContainEqual(expect.objectContaining({ hubspotId: 'HUB-FAIL', reason: 'hubspot_write_pending' }))
      expect(result.promoted).toEqual([])
    })
  })

  describe('dry-run guard', () => {
    it('makes zero HubSpot/Mongo mutating calls across the whole pipeline in dry-run', async () => {
      const orphans = [
        orphan('HUB-DRY-PROMOTE', 'DRY PROMOTE', 10),
        orphan('HUB-DRY-ARCHIVE', 'DRY ARCHIVE', 15)
      ]
      const hubspotApi = makeHubspotApi({
        orphans,
        s2Responder: (rawName) => {
          if (rawName === 'DRY PROMOTE') {
            return { results: [{ id: 'HUB-DRY-PROMOTE', properties: { name: 'DRY PROMOTE', price: '10' } }], total: 1 }
          }
          return {
            results: [
              { id: 'HUB-DRY-ARCHIVE', properties: { name: 'DRY ARCHIVE', price: '15', id_producto_odoo: null } },
              { id: 'HUB-DRY-SIBLING', properties: { name: 'DRY ARCHIVE', price: '15', id_producto_odoo: '900' } }
            ],
            total: 2
          }
        }
      })
      const odooApi = makeOdooApi({
        nameMap: {
          'dry promote': { id: 40, matches: 1, ids: [40] },
          'dry archive': { id: 41, matches: 1, ids: [41] }
        }
      })
      const mappingRepo = makeMappingRepo()
      const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: true })
      expect(hubspotApi.batchUpdateProducts).not.toHaveBeenCalled()
      expect(hubspotApi.batchArchiveProducts).not.toHaveBeenCalled()
      expect(mappingRepo.upsert).not.toHaveBeenCalled()
      expect(result.promoted).toContainEqual(expect.objectContaining({ hubspotId: 'HUB-DRY-PROMOTE' }))
      expect(result.archived).toContainEqual(expect.objectContaining({ hubspotId: 'HUB-DRY-ARCHIVE' }))
    })
  })
})
