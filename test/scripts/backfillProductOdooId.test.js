import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

// Testable backfill — load directly from the script module so we can inject mocks.
const script = require('../../scripts/backfill-product-odoo-id.js')
const { runBackfill } = script

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}

function makeApi() {
  return {
    batchUpdateProducts: vi.fn(async () => ({ results: [], errors: [], numErrors: 0 })),
    searchProducts: vi.fn(async () => ({ results: [], total: 0 }))
  }
}

function makeOdooApi() {
  return {
    searchProductIdsByNames: vi.fn(async () => ({}))
  }
}

function makeMappingRepo({ rows = [] } = {}) {
  return {
    findAllForBackfill: vi.fn(async () => rows),
    // For tests that want to assert promote-side effects:
    promoteQuarantinedRows: vi.fn(async () => ({ promotedCount: 0 })),
    recordQuarantine: vi.fn(async () => null)
  }
}

describe('backfill-product-odoo-id (openspec/hubspot-product-odoo-id-key)', () => {
  describe('4.1 idempotency', () => {
    it('running twice against the same fixtures leaves final state identical', async () => {
      const authoritativeRows = [
        { _id: 'm1', odooId: 42, hubspotId: 'HUB-42', hsSku: 'AC-1', lastAction: 'created', lastSyncedAt: new Date() },
        { _id: 'm2', odooId: 7, hubspotId: 'HUB-7', hsSku: 'AC-2', lastAction: 'updated', lastSyncedAt: new Date() }
      ]
      const mappingRepo = makeMappingRepo({ rows: authoritativeRows })
      const api = makeApi()
      const logger = makeLogger()
      const first = await runBackfill({ hubspotApi: api, mappingRepo, logger, dryRun: false })
      const second = await runBackfill({ hubspotApi: api, mappingRepo, logger, dryRun: false })
      // Both runs issue the same upserts; writing the same id_producto_odoo value is idempotent
      // (HubSpot treats an identical property value as a no-op update). Per-product input shape
      // MUST be identical across runs — no extra rows, no duplicate writes.
      expect(first.written).toBe(2)
      expect(second.written).toBe(2)
      const inputsFirst = api.batchUpdateProducts.mock.calls[0][0].inputs
      const inputsSecond = api.batchUpdateProducts.mock.calls[1][0].inputs
      expect(inputsSecond).toEqual(inputsFirst)
    })

    it('uses batchUpdateProducts (native hubspotId, no idProperty) — batch/upsert rejects inputs missing idProperty on the real API', async () => {
      const authoritativeRows = [
        { _id: 'm1', odooId: 42, hubspotId: 'HUB-42', hsSku: 'AC-1', lastAction: 'created', lastSyncedAt: new Date() }
      ]
      const api = makeApi()
      const mappingRepo = makeMappingRepo({ rows: authoritativeRows })
      await runBackfill({ hubspotApi: api, mappingRepo, logger: makeLogger(), dryRun: false })
      const call = api.batchUpdateProducts.mock.calls[0][0]
      expect('idProperty' in call).toBe(false)
      expect(call.inputs).toHaveLength(1)
      expect(call.inputs[0].id).toBe('HUB-42')
      expect('idProperty' in call.inputs[0]).toBe(false)
      expect(call.inputs[0].properties.id_producto_odoo).toBe('42')
    })
  })

  describe('4.2 quarantine of heuristic rows (D6)', () => {
    it('does NOT promote backfilled / no_sku_no_match rows — they are quarantined, never written to HubSpot', async () => {
      const heuristicRows = [
        { _id: 'h1', odooId: 99, hubspotId: 'HUB-99', hsSku: null, metadata: { name: 'WIDGET A' }, lastAction: 'backfilled', lastSyncedAt: new Date() },
        { _id: 'h2', odooId: 100, hubspotId: 'HUB-100', hsSku: null, metadata: { name: 'WIDGET B' }, lastAction: 'no_sku_no_match', lastSyncedAt: new Date() }
      ]
      const api = makeApi()
      const odooApi = makeOdooApi()
      // Ambiguous on both sides — neither is unique → both quarantined
      odooApi.searchProductIdsByNames = vi.fn(async () => ({
        'widget a': { id: 1, matches: 2, ids: [1, 2] },
        'widget b': { id: 3, matches: 2, ids: [3, 4] }
      }))
      api.searchProducts = vi.fn(async () => ({ results: [{ id: 'HUB-99' }, { id: 'HUB-100' }], total: 2 }))
      const mappingRepo = makeMappingRepo({ rows: heuristicRows })
      const result = await runBackfill({ hubspotApi: api, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
      expect(api.batchUpdateProducts).not.toHaveBeenCalled()
      expect(result.quarantined).toContainEqual(expect.objectContaining({ odooId: 99, hubspotId: 'HUB-99' }))
      expect(result.quarantined).toContainEqual(expect.objectContaining({ odooId: 100, hubspotId: 'HUB-100' }))
    })

    it('promotes a heuristic row ONLY when its name matches exactly one Odoo product AND one HubSpot product', async () => {
      const heuristicRows = [
        // Unique on both sides → promoted.
        { _id: 'h1', odooId: 99, hubspotId: 'HUB-99', hsSku: null, metadata: { name: 'UNIQUE WIDGET' }, lastAction: 'backfilled', lastSyncedAt: new Date() },
        // Unique in Odoo but ambiguous in HubSpot → must NOT be promoted.
        { _id: 'h2', odooId: 100, hubspotId: 'HUB-100', hsSku: null, metadata: { name: 'COMMON WIDGET' }, lastAction: 'no_sku_no_match', lastSyncedAt: new Date() }
      ]
      const api = makeApi()
      const odooApi = makeOdooApi()
      odooApi.searchProductIdsByNames = vi.fn(async () => ({
        'unique widget': { id: 99, matches: 1, ids: [99] },
        'common widget': { id: 100, matches: 1, ids: [100] }
      }))
      api.searchProducts = vi.fn(async ({ filterGroups }) => {
        const value = filterGroups[0].filters[0].value
        if (value === 'UNIQUE WIDGET') return { results: [{ id: 'HUB-99' }], total: 1 }
        if (value === 'COMMON WIDGET') return { results: [{ id: 'HUB-100' }, { id: 'HUB-101' }], total: 2 }
        return { results: [], total: 0 }
      })
      const mappingRepo = makeMappingRepo({ rows: heuristicRows })
      const result = await runBackfill({ hubspotApi: api, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
      expect(result.promoted).toContainEqual(expect.objectContaining({ odooId: 99 }))
      expect(result.quarantined).toContainEqual(expect.objectContaining({ odooId: 100 }))
      expect(api.batchUpdateProducts).toHaveBeenCalledTimes(1)
      const inputs = api.batchUpdateProducts.mock.calls[0][0].inputs
      expect(inputs[0].id).toBe('HUB-99')
      expect(inputs[0].properties.id_producto_odoo).toBe('99')
    })

    it('does NOT promote when the name is ambiguous in Odoo even though HubSpot has exactly one match (D6 dual-system guarantee, CRITICAL-1 regression case)', async () => {
      const heuristicRows = [
        { _id: 'h1', odooId: 200, hubspotId: 'HUB-200', hsSku: null, metadata: { name: 'AMBIGUOUS IN ODOO' }, lastAction: 'backfilled', lastSyncedAt: new Date() }
      ]
      const api = makeApi()
      const odooApi = makeOdooApi()
      // Two distinct Odoo products share this name — the exact failure mode D6 exists to prevent.
      odooApi.searchProductIdsByNames = vi.fn(async () => ({
        'ambiguous in odoo': { id: 200, matches: 2, ids: [200, 201] }
      }))
      // HubSpot side is (misleadingly) unique — must NOT be enough to promote on its own.
      api.searchProducts = vi.fn(async () => ({ results: [{ id: 'HUB-200' }], total: 1 }))
      const mappingRepo = makeMappingRepo({ rows: heuristicRows })
      const result = await runBackfill({ hubspotApi: api, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
      expect(api.batchUpdateProducts).not.toHaveBeenCalled()
      expect(result.promoted).toHaveLength(0)
      expect(result.quarantined).toContainEqual(expect.objectContaining({ odooId: 200, hubspotId: 'HUB-200' }))
      expect(odooApi.searchProductIdsByNames).toHaveBeenCalled()
    })
  })

  describe('4.3 --dry-run issues zero writes', () => {
    it('dryRun=true still scans mappings but never calls api.batchUpdateProducts', async () => {
      const rows = [
        { _id: 'm1', odooId: 42, hubspotId: 'HUB-42', hsSku: 'AC-1', lastAction: 'created', lastSyncedAt: new Date() },
        { _id: 'm2', odooId: 7, hubspotId: 'HUB-7', hsSku: 'AC-2', lastAction: 'updated', lastSyncedAt: new Date() }
      ]
      const api = makeApi()
      const mappingRepo = makeMappingRepo({ rows })
      const logger = makeLogger()
      const result = await runBackfill({ hubspotApi: api, mappingRepo, logger, dryRun: true })
      expect(api.batchUpdateProducts).not.toHaveBeenCalled()
      expect(result.written).toBe(0)
      expect(result.scanned).toBe(2)
    })

    it('dryRun=true on heuristic rows scans but writes no quarantine entries that would mutate state', async () => {
      const rows = [
        { _id: 'h1', odooId: 99, hubspotId: 'HUB-99', hsSku: null, lastAction: 'no_sku_no_match', lastSyncedAt: new Date() }
      ]
      const api = makeApi()
      const mappingRepo = makeMappingRepo({ rows })
      const result = await runBackfill({ hubspotApi: api, mappingRepo, logger: makeLogger(), dryRun: true })
      expect(api.batchUpdateProducts).not.toHaveBeenCalled()
      expect(api.searchProducts).not.toHaveBeenCalled() // dry-run short-circuits the heuristic lookup
      expect(result.quarantined).toHaveLength(0)
      expect(result.promoted).toHaveLength(0)
    })
  })

  describe('safety', () => {
    it('chunks inputs at 100 per call (business-hours safe under rps:15)', async () => {
      const rows = Array.from({ length: 250 }, (_, i) => ({
        _id: `m${i}`,
        odooId: i + 1,
        hubspotId: `HUB-${i + 1}`,
        hsSku: `SKU-${i + 1}`,
        lastAction: 'updated',
        lastSyncedAt: new Date()
      }))
      const api = makeApi()
      const mappingRepo = makeMappingRepo({ rows })
      await runBackfill({ hubspotApi: api, mappingRepo, logger: makeLogger(), dryRun: false, chunkSize: 100 })
      const sizes = api.batchUpdateProducts.mock.calls.map((c) => c[0].inputs.length)
      expect(sizes).toEqual([100, 100, 50])
    })
  })
})
