import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { OdooTargetGateway, collectUnresolvedLines, describeUnresolved } = require('../../../src/adapters/outbound/odoo/OdooTargetGateway.js')
const { hashPayload } = require('../../../src/core/shared/hash.js')
const { TransientSyncError, SkipSyncError } = require('../../../src/core/domain/errors.js')

// Minimal stub of the Odoo apiClient — each test wires only the methods it exercises.
function makeApi({
  productByDefaultCode = {},
  productByName = null,
  productUoms = null,
  soSearch = [],
  soCreate = { id: 'SO-NEW', ref: 'S00001', state: 'draft' }
} = {}) {
  const api = {
    searchSalesOrderByOrigin: vi.fn(async () => soSearch),
    createSalesOrder: vi.fn(async () => soCreate),
    updateSalesOrder: vi.fn(async (id, payload) => ({ id: String(id), ref: null, state: 'draft', raw: payload })),
    searchProductIdsByDefaultCodes: vi.fn(async () => productByDefaultCode)
  }
  if (productByName !== null) api.searchProductIdsByNames = vi.fn(async () => productByName)
  if (productUoms !== null) api.readProductUoms = vi.fn(async () => productUoms)
  return api
}

describe('OdooTargetGateway.productResolution — tier 2 (hs_product_id via product_mapping)', () => {
  it('T1 wins over T2: non-numeric sku lookup resolves, lookupByHubspotProductId is NEVER invoked', async () => {
    const productMappingRepository = { findByHubspotId: vi.fn(async () => ({ odooId: 99 })) }
    const api = makeApi({ productByDefaultCode: { 'AC-1170': 42 } })
    const findByHubspotIdSpy = vi.spyOn(productMappingRepository, 'findByHubspotId')
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, productMappingRepository })

    // Non-numeric SKU → lookupByDefaultCode hits the api and returns 42; applySkuMatch sets productId.
    // Tier 2 is skipped because resolveProductId(li) is already non-null on entry.
    const out = await gw.resolveProductIds([
      { id: 'L-1', hs_sku: 'AC-1170', hs_product_id: 'HUB-1', quantity: 1, name: 'X' }
    ])

    expect(out[0].productId).toBe(42)
    expect(findByHubspotIdSpy).not.toHaveBeenCalled()
    expect(api.searchProductIdsByDefaultCodes).toHaveBeenCalledTimes(1)
  })

  it('T2 resolves when hs_sku is null and hs_product_id has a mapping; lookupByName is NEVER called', async () => {
    const productMappingRepository = { findByHubspotId: vi.fn(async () => ({ odooId: 99 })) }
    const api = makeApi({ productByName: { 'walmart quad - con pushers': { id: 1, matches: 1 } } })
    const searchProductIdsByNamesSpy = vi.spyOn(api, 'searchProductIdsByNames')
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, productMappingRepository })

    const out = await gw.resolveProductIds([
      { id: 'L-1', hs_sku: null, hs_product_id: '46671077999', quantity: 1, name: 'WALMART QUAD - CON PUSHERS' }
    ])

    expect(out[0].productId).toBe(99)
    expect(searchProductIdsByNamesSpy).not.toHaveBeenCalled()
  })

  it('unmapped hs_product_id falls through to T3 (name match) — no fabricated odooId', async () => {
    const productMappingRepository = { findByHubspotId: vi.fn(async () => null) }
    const api = makeApi({ productByName: { 'widget': { id: 7, matches: 1 } } })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, productMappingRepository })

    const out = await gw.resolveProductIds([
      { id: 'L-1', hs_sku: null, hs_product_id: '99999999999', quantity: 1, name: 'WIDGET' }
    ])

    expect(out[0].productId).toBe(7) // resolved by name
    expect(productMappingRepository.findByHubspotId).toHaveBeenCalledWith('99999999999')
  })

  it('all tiers fail: SkipSyncError raised with hsProductId in the unresolved detail', async () => {
    const productMappingRepository = { findByHubspotId: vi.fn(async () => null) }
    const api = makeApi({ productByName: {} })
    const logger = { warn: vi.fn(), info: vi.fn() }
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, productMappingRepository, logger })

    // resolveProductIds itself does NOT throw — the assertProductsResolved gate does.
    const enriched = await gw.resolveProductIds([
      { id: 'L-1', hs_sku: 'NOPE', hs_product_id: 'HUB-999', quantity: 1, name: 'MYSTERY' }
    ])
    expect(enriched[0].productId).toBeUndefined()

    // collectUnresolvedLines now carries hsProductId in the entry.
    const unresolved = collectUnresolvedLines(enriched)
    expect(unresolved[0]).toMatchObject({
      lineItemId: 'L-1',
      hsSku: 'NOPE',
      hsProductId: 'HUB-999',
      reason: 'not_found'
    })

    // describeUnresolved mentions hs_product_id when present.
    const desc = describeUnresolved(unresolved[0])
    expect(desc).toMatch(/hs_product_id "HUB-999"/)
    expect(desc).toMatch(/hs_sku "NOPE"/)

    // assertProductsResolved (the revenue-critical gate) throws SkipSyncError.
    let skipped = null
    try { gw.assertProductsResolved(enriched, { id: 'D-1' }) } catch (e) { skipped = e }
    expect(skipped).toBeInstanceOf(SkipSyncError)
    expect(skipped.code).toBe('SKIP_SYNC')
    expect(skipped.detail.code).toBe('ODOO_PRODUCT_NOT_FOUND')
    expect(skipped.detail.sourceId).toBe('D-1')
    expect(skipped.detail.unresolved[0].hsProductId).toBe('HUB-999')
  })

  it('repo absent (not injected) ⇒ byte-identical pre-change behavior: only SKU and name tiers run', async () => {
    const api = makeApi({ productByName: { 'widget': { id: 7, matches: 1 } } })
    // No productMappingRepository passed — D4 self-disable.
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    expect(gw.productMappingRepository).toBeNull()

    // The repo being absent means lookupByHubspotProductId short-circuits to {} — the same
    // input that would have flowed to tier 3 instead flows to tier 3 (unchanged path).
    const out = await gw.resolveProductIds([
      { id: 'L-1', hs_sku: null, hs_product_id: 'HUB-1', quantity: 1, name: 'WIDGET' },
      { id: 'L-2', hs_sku: null, hs_product_id: 'HUB-2', quantity: 1, name: 'NOPE-NAME' }
    ])
    // Tier 2 is a no-op (repo absent) — L-1 falls through to name match, resolves to 7.
    expect(out[0].productId).toBe(7)
    // L-2 has no name match either — stays unresolved, no fabricated id.
    expect(out[1].productId).toBeUndefined()

    // searchProductIdsByNames ran once (the single unique normalized name 'widget').
    expect(api.searchProductIdsByNames).toHaveBeenCalledTimes(1)
  })

  it('repo throws ⇒ TransientSyncError propagates, NO sale-order line created downstream', async () => {
    const productMappingRepository = {
      findByHubspotId: vi.fn(async () => { throw new Error('mongo down') })
    }
    const api = makeApi({
      productByDefaultCode: {},
      productByName: { 'widget': { id: 7, matches: 1 } }
    })
    const logger = { warn: vi.fn(), info: vi.fn() }
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, productMappingRepository, logger })

    // Resolve fails — TransientSyncError propagates up.
    let caught = null
    try {
      await gw.resolveProductIds([
        { id: 'L-1', hs_sku: null, hs_product_id: 'HUB-1', quantity: 1, name: 'WIDGET' }
      ])
    } catch (err) { caught = err }

    expect(caught).toBeInstanceOf(TransientSyncError)
    expect(caught.code).toBe('TRANSIENT_SYNC')
    expect(caught.message).toMatch(/product_mapping lookup by hubspotId failed/)
    expect(caught.cause).toBeTruthy()
    expect(caught.transient).toBe(true)
    // The name tier MUST NOT have run (T2 threw before reaching T3).
    expect(api.searchProductIdsByNames).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      'odoo.upsert.lookupByHubspotProductId failed',
      expect.objectContaining({ error: expect.stringMatching(/mongo down/) })
    )

    // End-to-end: a full upsert MUST NOT reach createSalesOrder when the repo throws.
    const api2 = makeApi({
      productByDefaultCode: {},
      productByName: { 'widget': { id: 7, matches: 1 } }
    })
    const logger2 = { warn: vi.fn(), info: vi.fn() }
    const gw2 = new OdooTargetGateway({
      apiClient: api2, hashPayload,
      productMappingRepository: { findByHubspotId: vi.fn(async () => { throw new Error('mongo down') }) },
      logger: logger2
    })
    let upsertErr = null
    try {
      await gw2.upsert({
        existingTargetId: null,
        record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
        references: {
          odooCustomerId: '42',
          lineItems: [{ id: 'L-1', hs_sku: null, hs_product_id: 'HUB-1', quantity: 1, name: 'WIDGET' }]
        }
      })
    } catch (err) { upsertErr = err }
    expect(upsertErr).toBeInstanceOf(TransientSyncError)
    expect(api2.createSalesOrder).not.toHaveBeenCalled()
    expect(api2.updateSalesOrder).not.toHaveBeenCalled()
  })

  it('UoM still filled after a T2 match: resolveProductUoms populates uom for tier-2-resolved items', async () => {
    const productMappingRepository = { findByHubspotId: vi.fn(async () => ({ odooId: 99 })) }
    const api = makeApi({
      productByDefaultCode: {},
      productByName: {},
      productUoms: { 99: 7 }
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, productMappingRepository })

    const resolved = await gw.resolveProductIds([
      { id: 'L-1', hs_sku: null, hs_product_id: 'HUB-1', quantity: 1, name: 'WIDGET' }
    ])
    expect(resolved[0].productId).toBe(99)

    const enriched = await gw.resolveProductUoms(resolved)
    expect(enriched[0].productId).toBe(99)
    expect(enriched[0].productUomId).toBe(7)
  })
})
