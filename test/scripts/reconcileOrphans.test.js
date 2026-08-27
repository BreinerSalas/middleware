import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

// Reconciles HubSpot products that exist with NEITHER hs_sku NOR id_producto_odoo (orphans
// left over from a pre-existing sync run that never left a product_mapping trace — see
// openspec/hubspot-product-odoo-id-key, docs/todo-sku-sintetico.md). Uses the same D6 dual-
// system uniqueness rule as Phase B: promote only when the name matches exactly one Odoo
// product AND one HubSpot product.
const script = require('../../scripts/backfill-product-odoo-id.js')
const { reconcileOrphans } = script

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function makeHubspotApi({ orphans = [] } = {}) {
  return {
    searchProducts: vi.fn(async ({ filterGroups }) => {
      const isOrphanQuery = filterGroups.some((g) =>
        g.filters.some((f) => f.propertyName === 'id_producto_odoo' && f.operator === 'NOT_HAS_PROPERTY')
      )
      if (isOrphanQuery) return { results: orphans, paging: null }
      return { results: [], total: 0 }
    }),
    batchUpdateProducts: vi.fn(async () => ({ results: [], errors: [], numErrors: 0 }))
  }
}

function makeOdooApi(map = {}) {
  return { searchProductIdsByNames: vi.fn(async () => map) }
}

function makeMappingRepo({ findByOdooId = null } = {}) {
  return {
    upsert: vi.fn(async () => null),
    findByOdooId: vi.fn(async (odooId) => (findByOdooId ? findByOdooId(odooId) : null))
  }
}

describe('reconcileOrphans (openspec/hubspot-product-odoo-id-key, orphan-reconciliation fix)', () => {
  it('fetches orphans filtered by hs_sku NOT_HAS_PROPERTY AND id_producto_odoo NOT_HAS_PROPERTY', async () => {
    const hubspotApi = makeHubspotApi({ orphans: [] })
    const odooApi = makeOdooApi({})
    const mappingRepo = makeMappingRepo()
    await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
    const call = hubspotApi.searchProducts.mock.calls[0][0]
    const props = call.filterGroups[0].filters.map((f) => f.propertyName)
    expect(props).toEqual(expect.arrayContaining(['hs_sku', 'id_producto_odoo']))
    expect(call.filterGroups[0].filters.every((f) => f.operator === 'NOT_HAS_PROPERTY')).toBe(true)
  })

  // (sdd/hubspot-product-reverse-discovery, Phase 1) Track A/B need `price` and
  // `id_producto_odoo` on every orphan row, not just `name`, to disambiguate and to guard
  // against a race where the orphan gets an id_producto_odoo between the initial filtered
  // search and processing.
  it('requests name, price and id_producto_odoo properties on the orphan search', async () => {
    const hubspotApi = makeHubspotApi({ orphans: [] })
    const odooApi = makeOdooApi({})
    const mappingRepo = makeMappingRepo()
    await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
    const call = hubspotApi.searchProducts.mock.calls[0][0]
    expect(call.properties).toEqual(expect.arrayContaining(['name', 'price', 'id_producto_odoo']))
  })

  it('promotes an orphan whose name matches exactly one Odoo product AND one HubSpot product', async () => {
    const hubspotApi = makeHubspotApi({
      orphans: [{ id: '46671077999', properties: { name: 'WALMART QUAD - CON PUSHERS' } }]
    })
    hubspotApi.searchProducts = vi.fn(async ({ filterGroups }) => {
      const isOrphanQuery = filterGroups.some((g) => g.filters.some((f) => f.propertyName === 'id_producto_odoo'))
      if (isOrphanQuery) return { results: [{ id: '46671077999', properties: { name: 'WALMART QUAD - CON PUSHERS' } }], paging: null }
      // uniqueness check by name
      return { results: [{ id: '46671077999' }], total: 1 }
    })
    const odooApi = makeOdooApi({ 'walmart quad - con pushers': { id: 9758, matches: 1, ids: [9758] } })
    const mappingRepo = makeMappingRepo()
    const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
    expect(result.promoted).toContainEqual(expect.objectContaining({ odooId: 9758, hubspotId: '46671077999' }))
    expect(hubspotApi.batchUpdateProducts).toHaveBeenCalledWith({
      inputs: [{ id: '46671077999', properties: { id_producto_odoo: '9758' } }]
    })
    expect(mappingRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ odooId: 9758, hubspotId: '46671077999', hsSku: null, action: 'backfilled' })
    )
  })

  // (sdd/hubspot-product-reverse-discovery, Phase 2) Superseded by Track A price
  // disambiguation: odooMatches >= 2 no longer quarantines flatly as `ambiguous_in_odoo` —
  // it falls through to a price compare first (see test/composition/productOrphanReconcileModule.test.js
  // for the full Track A matrix). With no price data available to disambiguate (this fake
  // odooApi has no `readProductPrices`), zero candidates match and it quarantines
  // `price_no_match_in_odoo` — still never writes.
  it('quarantines when the name is ambiguous in Odoo (matches > 1) and price cannot disambiguate — never writes', async () => {
    const hubspotApi = makeHubspotApi({
      orphans: [{ id: 'HUB-1', properties: { name: 'COMMON NAME' } }]
    })
    const odooApi = makeOdooApi({ 'common name': { id: 1, matches: 2, ids: [1, 2] } })
    const mappingRepo = makeMappingRepo()
    const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
    expect(result.quarantined).toContainEqual(expect.objectContaining({ hubspotId: 'HUB-1', reason: 'price_no_match_in_odoo' }))
    expect(hubspotApi.batchUpdateProducts).not.toHaveBeenCalled()
    expect(mappingRepo.upsert).not.toHaveBeenCalled()
  })

  it('quarantines when unique in Odoo but ambiguous in HubSpot — never writes', async () => {
    const hubspotApi = makeHubspotApi({
      orphans: [{ id: 'HUB-2', properties: { name: 'SHARED NAME' } }]
    })
    hubspotApi.searchProducts = vi.fn(async ({ filterGroups }) => {
      const isOrphanQuery = filterGroups.some((g) => g.filters.some((f) => f.propertyName === 'id_producto_odoo'))
      if (isOrphanQuery) return { results: [{ id: 'HUB-2', properties: { name: 'SHARED NAME' } }], paging: null }
      return { results: [{ id: 'HUB-2' }, { id: 'HUB-3' }], total: 2 }
    })
    const odooApi = makeOdooApi({ 'shared name': { id: 5, matches: 1, ids: [5] } })
    const mappingRepo = makeMappingRepo()
    const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
    expect(result.quarantined).toContainEqual(expect.objectContaining({ hubspotId: 'HUB-2', reason: 'ambiguous_in_hubspot' }))
    expect(hubspotApi.batchUpdateProducts).not.toHaveBeenCalled()
  })

  it('quarantines with not_found_in_odoo when the name has zero Odoo matches', async () => {
    const hubspotApi = makeHubspotApi({
      orphans: [{ id: 'HUB-4', properties: { name: 'NOWHERE' } }]
    })
    const odooApi = makeOdooApi({})
    const mappingRepo = makeMappingRepo()
    const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
    expect(result.quarantined).toContainEqual(expect.objectContaining({ hubspotId: 'HUB-4', reason: 'not_found_in_odoo' }))
  })

  it('dryRun issues zero writes but still reports scanned/promoted/quarantined counts', async () => {
    const hubspotApi = makeHubspotApi({
      orphans: [{ id: '46671077999', properties: { name: 'WALMART QUAD - CON PUSHERS' } }]
    })
    hubspotApi.searchProducts = vi.fn(async ({ filterGroups }) => {
      const isOrphanQuery = filterGroups.some((g) => g.filters.some((f) => f.propertyName === 'id_producto_odoo'))
      if (isOrphanQuery) return { results: [{ id: '46671077999', properties: { name: 'WALMART QUAD - CON PUSHERS' } }], paging: null }
      return { results: [{ id: '46671077999' }], total: 1 }
    })
    const odooApi = makeOdooApi({ 'walmart quad - con pushers': { id: 9758, matches: 1, ids: [9758] } })
    const mappingRepo = makeMappingRepo()
    const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: true })
    expect(hubspotApi.batchUpdateProducts).not.toHaveBeenCalled()
    expect(mappingRepo.upsert).not.toHaveBeenCalled()
    expect(result.scanned).toBe(1)
    expect(result.promoted).toContainEqual(expect.objectContaining({ odooId: 9758 }))
  })

  it('escapes literal double quotes in the name before using it as a HubSpot search filter value', async () => {
    const rawName = 'PRECIADOR AMJ MARVEL+ALASKA 3X3"'
    const hubspotApi = makeHubspotApi({
      orphans: [{ id: 'HUB-QUOTE', properties: { name: rawName } }]
    })
    hubspotApi.searchProducts = vi.fn(async ({ filterGroups }) => {
      const isOrphanQuery = filterGroups.some((g) => g.filters.some((f) => f.propertyName === 'id_producto_odoo'))
      if (isOrphanQuery) return { results: [{ id: 'HUB-QUOTE', properties: { name: rawName } }], paging: null }
      return { results: [{ id: 'HUB-QUOTE' }], total: 1 }
    })
    const odooApi = makeOdooApi({ [rawName.trim().toLowerCase()]: { id: 42, matches: 1, ids: [42] } })
    const mappingRepo = makeMappingRepo()
    const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })

    const uniquenessCall = hubspotApi.searchProducts.mock.calls.find(
      ([{ filterGroups }]) => !filterGroups.some((g) => g.filters.some((f) => f.propertyName === 'id_producto_odoo'))
    )
    const sentValue = uniquenessCall[0].filterGroups[0].filters[0].value
    expect(sentValue).toBe('PRECIADOR AMJ MARVEL+ALASKA 3X3\\"')
    expect(result.promoted).toContainEqual(expect.objectContaining({ odooId: 42, hubspotId: 'HUB-QUOTE' }))
  })

  it('quarantines when the odooId was already claimed by a different hubspotId (write-time collision) instead of attempting the write', async () => {
    const hubspotApi = makeHubspotApi({
      orphans: [{ id: 'HUB-DUP', properties: { name: 'BANDEJA DUTY  PEQUEÑA' } }]
    })
    hubspotApi.searchProducts = vi.fn(async ({ filterGroups }) => {
      const isOrphanQuery = filterGroups.some((g) => g.filters.some((f) => f.propertyName === 'id_producto_odoo'))
      if (isOrphanQuery) return { results: [{ id: 'HUB-DUP', properties: { name: 'BANDEJA DUTY  PEQUEÑA' } }], paging: null }
      return { results: [{ id: 'HUB-DUP' }], total: 1 }
    })
    const odooApi = makeOdooApi({ 'bandeja duty pequeña': { id: 9538, matches: 1, ids: [9538] } })
    const mappingRepo = makeMappingRepo({
      findByOdooId: (odooId) => (odooId === 9538 ? { odooId: 9538, hubspotId: 'HUB-ALREADY-MAPPED' } : null)
    })
    const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })
    expect(result.quarantined).toContainEqual(
      expect.objectContaining({ hubspotId: 'HUB-DUP', reason: 'odoo_id_already_claimed' })
    )
    expect(hubspotApi.batchUpdateProducts).not.toHaveBeenCalled()
    expect(mappingRepo.upsert).not.toHaveBeenCalled()
  })

  // (sdd/hubspot-product-reverse-discovery, design D6) Write order inverted: mappingRepo.upsert
  // now runs BEFORE the HubSpot write. A HubSpot failure no longer means "nothing happened" —
  // the Mongo mapping is already durable (self-healing: a later run's findByOdooId collision
  // guard sees `existing.hubspotId === hubspotId` and retries the HubSpot write cleanly). The
  // reason code changed from `hubspot_write_conflict` to `hubspot_write_pending` to reflect that.
  it('quarantines hubspot_write_pending on a HubSpot write failure, keeps the Mongo mapping (self-healing), and keeps processing remaining orphans', async () => {
    const orphans = [
      { id: 'HUB-CONFLICT', properties: { name: 'CONFLICT PRODUCT' } },
      { id: 'HUB-OK', properties: { name: 'FINE PRODUCT' } }
    ]
    const hubspotApi = makeHubspotApi({ orphans })
    hubspotApi.searchProducts = vi.fn(async ({ filterGroups }) => {
      const isOrphanQuery = filterGroups.some((g) => g.filters.some((f) => f.propertyName === 'id_producto_odoo'))
      if (isOrphanQuery) return { results: orphans, paging: null }
      const value = filterGroups[0].filters[0].value
      if (value === 'CONFLICT PRODUCT') return { results: [{ id: 'HUB-CONFLICT' }], total: 1 }
      return { results: [{ id: 'HUB-OK' }], total: 1 }
    })
    hubspotApi.batchUpdateProducts = vi.fn(async ({ inputs }) => {
      if (inputs[0].id === 'HUB-CONFLICT') {
        throw new Error('Cannot set PropertyValueCoordinates{...} on HUB-CONFLICT. HUB-OTHER already has that value.')
      }
      return { results: [], errors: [], numErrors: 0 }
    })
    const odooApi = makeOdooApi({
      'conflict product': { id: 1, matches: 1, ids: [1] },
      'fine product': { id: 2, matches: 1, ids: [2] }
    })
    const mappingRepo = makeMappingRepo()
    const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: false })

    expect(result.quarantined).toContainEqual(
      expect.objectContaining({ hubspotId: 'HUB-CONFLICT', reason: 'hubspot_write_pending' })
    )
    expect(result.promoted).toContainEqual(expect.objectContaining({ odooId: 2, hubspotId: 'HUB-OK' }))
    // Mongo-first: the mapping was written even though the HubSpot call failed afterwards.
    expect(mappingRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ odooId: 1, hubspotId: 'HUB-CONFLICT', action: 'backfilled' })
    )
  })

  it('--limit caps how many orphans are fetched/processed', async () => {
    const orphans = Array.from({ length: 10 }, (_, i) => ({ id: `HUB-${i}`, properties: { name: `NAME ${i}` } }))
    const hubspotApi = makeHubspotApi({ orphans })
    const odooApi = makeOdooApi({})
    const mappingRepo = makeMappingRepo()
    const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger: makeLogger(), dryRun: true, limit: 3 })
    expect(result.scanned).toBe(3)
  })
})
