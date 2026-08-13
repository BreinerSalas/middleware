import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  OdooTargetGateway,
  resolveCountryIdFromIsoCode,
  resolveCountryIdFromPartner
} = require('../../../src/adapters/outbound/odoo/OdooTargetGateway.js')
const { hashPayload } = require('../../../src/core/shared/hash.js')

function makeApi({
  soSearch = [],
  soCreate = { id: 'SO-NEW', ref: 'S00001', state: 'draft', raw: {} },
  productMap = {},
  partnerCountry = {},
  operationCosts = [],
  searchCountryIdsByCodes = null
} = {}) {
  const api = {
    searchSalesOrderByOrigin: vi.fn(async () => soSearch),
    createSalesOrder: vi.fn(async () => soCreate),
    updateSalesOrder: vi.fn(async (id, payload) => ({ id: String(id), ref: null, state: 'draft', raw: payload, rpcResult: true })),
    readPartnerCountries: vi.fn(async (ids) => {
      const map = {}
      for (const id of ids) if (partnerCountry[id]) map[id] = partnerCountry[id]
      return map
    }),
    listOperationCosts: vi.fn(async () => operationCosts),
    searchProductIdsByDefaultCodes: vi.fn(async () => productMap)
  }
  if (searchCountryIdsByCodes) {
    api.searchCountryIdsByCodes = vi.fn(async (codes) => {
      const map = { CR: { id: 50, name: 'Costa Rica' }, GT: { id: 90, name: 'Guatemala' }, HN: { id: 96, name: 'Honduras' } }
      const out = {}
      for (const c of codes || []) if (map[c]) out[c] = map[c]
      return out
    })
  }
  return api
}

const DEAL_RECORD = { id: 'D-1', properties: { id_cliente_odoo: '42' } }
const DEAL_REFS = { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 9.99, name: 'X' }] }

describe('resolveCountryIdFromIsoCode', () => {
  it('returns {countryId, countryName} when the ISO is found', async () => {
    const api = makeApi({ searchCountryIdsByCodes: true })
    const r = await resolveCountryIdFromIsoCode('GT', { apiClient: api })
    expect(r).toEqual({ countryId: 90, countryName: 'Guatemala' })
  })

  it('returns {countryId: null, countryName: null, reason: quote_country_iso_not_found} when missing', async () => {
    const api = makeApi({ searchCountryIdsByCodes: true })
    const r = await resolveCountryIdFromIsoCode('XX', { apiClient: api })
    expect(r).toEqual({ countryId: null, countryName: null, reason: 'quote_country_iso_not_found' })
  })

  it('returns the not_supported reason when apiClient lacks the method', async () => {
    const api = makeApi()
    const r = await resolveCountryIdFromIsoCode('GT', { apiClient: api })
    expect(r).toEqual({ countryId: null, countryName: null, reason: 'searchCountryIdsByCodes_not_supported' })
  })

  it('returns missing_iso reason when iso is falsy', async () => {
    const api = makeApi({ searchCountryIdsByCodes: true })
    const r = await resolveCountryIdFromIsoCode(null, { apiClient: api })
    expect(r.reason).toBe('missing_iso')
  })
})

describe('resolveCountryIdFromPartner', () => {
  it('returns the country for the partner directly', async () => {
    const api = makeApi({
      partnerCountry: { 42: { countryId: 49, countryName: 'Colombia', parentId: null } }
    })
    const r = await resolveCountryIdFromPartner(42, { apiClient: api })
    expect(r).toEqual({ countryId: 49, countryName: 'Colombia' })
  })

  it('walks up to parent when child has no country', async () => {
    const api = makeApi({
      partnerCountry: {
        42: { countryId: null, countryName: null, parentId: 7 },
        7: { countryId: 49, countryName: 'Colombia', parentId: null }
      }
    })
    const r = await resolveCountryIdFromPartner(42, { apiClient: api })
    expect(r).toEqual({ countryId: 49, countryName: 'Colombia' })
  })

  it('returns partner_has_no_country when no country is found in the walk', async () => {
    const api = makeApi({ partnerCountry: { 42: { countryId: null, countryName: null, parentId: null } } })
    const r = await resolveCountryIdFromPartner(42, { apiClient: api })
    expect(r).toEqual({ countryId: null, countryName: null, reason: 'partner_has_no_country' })
  })

  it('returns no_odoo_customer_id when odooCustomerId is missing', async () => {
    const api = makeApi()
    const r = await resolveCountryIdFromPartner(null, { apiClient: api })
    expect(r.reason).toBe('no_odoo_customer_id')
  })

  it('returns readPartnerCountries_not_supported when apiClient lacks the method', async () => {
    const api = makeApi()
    delete api.readPartnerCountries
    const r = await resolveCountryIdFromPartner(42, { apiClient: api })
    expect(r.reason).toBe('readPartnerCountries_not_supported')
  })
})

describe('OdooTargetGateway.upsert — ISO-driven country_expense', () => {
  const ocCR = [{ id: 78, name: 'DDP Costa Rica', countryId: 50, countryName: 'Costa Rica', productId: null }]
  const ocGT = [{ id: 79, name: 'DDP Guatemala', countryId: 90, countryName: 'Guatemala', productId: null }]

  it('prefers ISO from record.quote over the partner walk', async () => {
    const api = makeApi({
      productMap: { 'SKU-1': 17 },
      partnerCountry: { 42: { countryId: 49, countryName: 'Colombia', parentId: null } },
      operationCosts: ocCR,
      searchCountryIdsByCodes: true
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, requireProductMatch: false })
    const record = {
      id: 'D-1:qQ-1',
      dealId: 'D-1',
      quoteId: 'Q-1',
      properties: { id_cliente_odoo: '42' },
      quote: { id: 'Q-1', properties: { pais_de_destino: 'CR', hs_title: 'CR-Cotiz' } }
    }
    const result = await gw.upsert({ record, references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] } })
    expect(api.searchCountryIdsByCodes).toHaveBeenCalledWith(['CR'])
    expect(result.metadata.countryExpense.id).toBe(78)
    expect(result.metadata.countryExpense.countryId).toBe(50)
    expect(api.readPartnerCountries).not.toHaveBeenCalled()
  })

  it('wires origin/note from record.dealId+quoteId+quote explicitly, not derived from record.id', async () => {
    // record.id is deliberately NOT of the form "<dealId>:q<quoteId>" — if the
    // mapper were still deriving origin from hsDeal.id (the pre-fix bug), this
    // would produce a garbage origin and drop the quote note entirely.
    const api = makeApi({
      productMap: { 'SKU-1': 17 },
      partnerCountry: { 42: { countryId: 49, countryName: 'Colombia', parentId: null } },
      operationCosts: ocGT,
      searchCountryIdsByCodes: true
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, requireProductMatch: false })
    const record = {
      id: 'opaque-source-id-not-shaped-like-deal-colon-q-quote',
      dealId: 'D-9',
      quoteId: 'Q-9',
      properties: { id_cliente_odoo: '42', dealname: 'Fan-Out Demo' },
      quote: { id: 'Q-9', properties: { pais_de_destino: 'GT', hs_title: 'Cotiz GT' } }
    }
    await gw.upsert({ record, references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] } })
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload.origin).toBe('hs:D-9:qQ-9')
    expect(soPayload.note).toBe('Deal: Fan-Out Demo\nCotización: Cotiz GT (GT)')
  })

  it('degrades to partner walk when quote is missing', async () => {
    const api = makeApi({
      productMap: { 'SKU-1': 17 },
      partnerCountry: { 42: { countryId: 49, countryName: 'Colombia', parentId: null } },
      operationCosts: [{ id: 78, name: 'DDP Colombia', countryId: 49, countryName: 'Colombia', productId: null }]
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, requireProductMatch: false })
    const result = await gw.upsert({ record: DEAL_RECORD, references: DEAL_REFS })
    expect(api.readPartnerCountries).toHaveBeenCalled()
    expect(result.metadata.countryExpense.id).toBe(78)
  })

  it('falls back to partner walk when ISO does not resolve in Odoo', async () => {
    const api = makeApi({
      productMap: { 'SKU-1': 17 },
      partnerCountry: { 42: { countryId: 49, countryName: 'Colombia', parentId: null } },
      operationCosts: [{ id: 78, name: 'DDP Colombia', countryId: 49, countryName: 'Colombia', productId: null }]
    })
    api.searchCountryIdsByCodes = vi.fn(async () => ({}))
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, requireProductMatch: false })
    const record = {
      id: 'D-1:qQ-1',
      dealId: 'D-1',
      quoteId: 'Q-1',
      properties: { id_cliente_odoo: '42' },
      quote: { id: 'Q-1', properties: { pais_de_destino: 'XX' } }
    }
    const result = await gw.upsert({ record, references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] } })
    expect(result.metadata.countryExpense.id).toBe(78)
    expect(result.metadata.countryExpense.reason).toBe('partner_walk_after_iso_miss')
  })

  it('works without searchCountryIdsByCodes (back-compat stub api)', async () => {
    const api = makeApi({
      productMap: { 'SKU-1': 17 },
      partnerCountry: { 42: { countryId: 49, countryName: 'Colombia', parentId: null } },
      operationCosts: [{ id: 78, name: 'DDP Colombia', countryId: 49, countryName: 'Colombia', productId: null }]
    })
    // searchCountryIdsByCodes NOT defined on api -> must NOT throw
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, requireProductMatch: false })
    const record = {
      id: 'D-1:qQ-1',
      dealId: 'D-1',
      quoteId: 'Q-1',
      properties: { id_cliente_odoo: '42' },
      quote: { id: 'Q-1', properties: { pais_de_destino: 'XX' } }
    }
    const result = await gw.upsert({ record, references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] } })
    expect(result.metadata.countryExpense.id).toBe(78)
    expect(result.metadata.countryExpense.reason).toBe('partner_walk_after_iso_miss')
  })

  it('creates SO with status=unresolved and the SMARTFLOW_MARKER when ISO is unknown AND partner walk also fails', async () => {
    const api = makeApi({
      productMap: { 'SKU-1': 17 },
      partnerCountry: { 42: { countryId: null, countryName: null, parentId: null } },
      operationCosts: [{ id: 78, name: 'DDP X', countryId: 49, countryName: 'Colombia', productId: null }]
    })
    api.searchCountryIdsByCodes = vi.fn(async () => ({}))
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, requireProductMatch: false })
    const record = {
      id: 'D-1:qQ-1',
      dealId: 'D-1',
      quoteId: 'Q-1',
      properties: { id_cliente_odoo: '42' },
      quote: { id: 'Q-1', properties: { pais_de_destino: 'XX' } }
    }
    const result = await gw.upsert({ record, references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] } })
    expect(result.metadata.countryExpense.status).toBe('unresolved')
    expect(result.metadata.countryExpense.reason).toBe('quote_country_iso_not_found')
    expect(api.createSalesOrder).toHaveBeenCalledTimes(1)
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload.note).toContain('[smartflow]')
  })

  // Regression: an ambiguous pick (no exact "DDP <Country>" match, e.g. Venezuela's
  // real operation.costs) used to land as status:'resolved' with no visible signal
  // in Odoo — the sale order silently got whichever record had the lowest id, and
  // nobody reviewing it in Odoo could tell it was a guess.
  it('adds a distinct ambiguous-note marker when the country resolves but operation.costs has no exact DDP match', async () => {
    const api = makeApi({
      productMap: { 'SKU-1': 17 },
      operationCosts: [
        { id: 200, name: 'EXW Venezuela con Duca', countryId: 60, countryName: 'Venezuela', productId: null },
        { id: 201, name: 'EXW Venezuela sin Duca', countryId: 60, countryName: 'Venezuela', productId: null }
      ]
    })
    api.searchCountryIdsByCodes = vi.fn(async () => ({ VE: { id: 60, name: 'Venezuela' } }))
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, requireProductMatch: false })
    const record = {
      id: 'D-1:qQ-1',
      dealId: 'D-1',
      quoteId: 'Q-1',
      properties: { id_cliente_odoo: '42' },
      quote: { id: 'Q-1', properties: { pais_de_destino: 'VE' } }
    }
    const result = await gw.upsert({ record, references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] } })
    expect(result.metadata.countryExpense.status).toBe('resolved')
    expect(result.metadata.countryExpense.ambiguous).toBe(true)
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload.note).toContain('[smartflow]')
    expect(soPayload.note).toMatch(/ambigu/i)
  })

  it('adds no smartflow marker when the country resolves to an exact DDP match (unambiguous)', async () => {
    const api = makeApi({
      productMap: { 'SKU-1': 17 },
      operationCosts: ocCR,
      searchCountryIdsByCodes: true
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, requireProductMatch: false })
    const record = {
      id: 'D-1:qQ-1',
      dealId: 'D-1',
      quoteId: 'Q-1',
      properties: { id_cliente_odoo: '42' },
      quote: { id: 'Q-1', properties: { pais_de_destino: 'CR' } }
    }
    const result = await gw.upsert({ record, references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] } })
    expect(result.metadata.countryExpense.ambiguous).toBe(false)
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload.note || '').not.toContain('[smartflow]')
  })
})
