import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { OdooTargetGateway, resolveIncotermFromQuote } = require('../../../src/adapters/outbound/odoo/OdooTargetGateway.js')
const { hashPayload } = require('../../../src/core/shared/hash.js')

function makeApi({
  soSearch = [],
  soCreate = { id: 'SO-NEW', ref: 'S00001', state: 'draft', raw: {} },
  productMap = {},
  operationCosts = [],
  incoterms = []
} = {}) {
  return {
    searchSalesOrderByOrigin: vi.fn(async () => soSearch),
    createSalesOrder: vi.fn(async () => soCreate),
    updateSalesOrder: vi.fn(async (id, payload) => ({ id: String(id), ref: null, state: 'draft', raw: payload, rpcResult: true })),
    readPartnerCountries: vi.fn(async () => ({})),
    listOperationCosts: vi.fn(async () => operationCosts),
    listIncoterms: vi.fn(async () => incoterms),
    searchProductIdsByDefaultCodes: vi.fn(async () => productMap)
  }
}

const INCOTERMS = [
  { id: 11, name: 'DELIVERED DUTY PAID', code: 'DDP' },
  { id: 1, name: 'EX WORKS', code: 'EXW' }
]

describe('resolveIncotermFromQuote', () => {
  it('returns unresolved with quote_incoterm_unset when the property is the sin_definir sentinel', async () => {
    const api = makeApi({ incoterms: INCOTERMS })
    const r = await resolveIncotermFromQuote(
      { properties: { incoterm_cotizacion: 'sin_definir' } },
      { apiClient: api, incotermProperty: 'incoterm_cotizacion' }
    )
    expect(r).toEqual({ status: 'unresolved', id: null, code: null, reason: 'quote_incoterm_unset' })
    expect(api.listIncoterms).not.toHaveBeenCalled()
  })

  it('returns unresolved with quote_incoterm_unset when the property is absent', async () => {
    const api = makeApi({ incoterms: INCOTERMS })
    const r = await resolveIncotermFromQuote(
      { properties: {} },
      { apiClient: api, incotermProperty: 'incoterm_cotizacion' }
    )
    expect(r.reason).toBe('quote_incoterm_unset')
  })

  it('resolves a positive-integer id against listIncoterms', async () => {
    const api = makeApi({ incoterms: INCOTERMS })
    const r = await resolveIncotermFromQuote(
      { properties: { incoterm_cotizacion: '11' } },
      { apiClient: api, incotermProperty: 'incoterm_cotizacion' }
    )
    expect(r).toEqual({ status: 'resolved', id: 11, code: 'DDP', reason: 'quote_incoterm_id' })
  })

  it('returns quote_incoterm_value_unrecognized for a non-numeric value', async () => {
    const api = makeApi({ incoterms: INCOTERMS })
    const logger = { warn: vi.fn() }
    const r = await resolveIncotermFromQuote(
      { properties: { incoterm_cotizacion: 'DDP' } },
      { apiClient: api, incotermProperty: 'incoterm_cotizacion', logger }
    )
    expect(r.status).toBe('unresolved')
    expect(r.reason).toBe('quote_incoterm_value_unrecognized')
    expect(logger.warn).toHaveBeenCalled()
    expect(api.listIncoterms).not.toHaveBeenCalled()
  })

  it('returns incoterm_id_not_found when no record matches the id', async () => {
    const api = makeApi({ incoterms: INCOTERMS })
    const r = await resolveIncotermFromQuote(
      { properties: { incoterm_cotizacion: '999' } },
      { apiClient: api, incotermProperty: 'incoterm_cotizacion' }
    )
    expect(r.reason).toBe('incoterm_id_not_found')
  })

  it('returns listIncoterms_not_supported when apiClient lacks the method', async () => {
    const api = makeApi()
    delete api.listIncoterms
    const r = await resolveIncotermFromQuote(
      { properties: { incoterm_cotizacion: '11' } },
      { apiClient: api, incotermProperty: 'incoterm_cotizacion' }
    )
    expect(r.reason).toBe('listIncoterms_not_supported')
  })

  it('returns incoterms_lookup_failed when listIncoterms throws', async () => {
    const api = makeApi({ incoterms: INCOTERMS })
    api.listIncoterms = vi.fn(async () => { throw new Error('boom') })
    const logger = { warn: vi.fn() }
    const r = await resolveIncotermFromQuote(
      { properties: { incoterm_cotizacion: '11' } },
      { apiClient: api, incotermProperty: 'incoterm_cotizacion', logger }
    )
    expect(r.reason).toBe('incoterms_lookup_failed')
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('OdooTargetGateway.upsert — incoterm + tipo de documento wiring', () => {
  const record = (quoteProps) => ({
    id: 'D-1:qQ-1',
    dealId: 'D-1',
    quoteId: 'Q-1',
    properties: { id_cliente_odoo: '42' },
    quote: { id: 'Q-1', properties: quoteProps }
  })
  const refs = { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }

  it('writes saleOrder.incoterm and saleOrder.operation_type_sv on create when both are set on the quote', async () => {
    const api = makeApi({
      productMap: { 'SKU-1': 17 },
      operationCosts: [{ id: 78, name: 'DDP Costa Rica', countryId: 50, countryName: 'Costa Rica' }],
      incoterms: INCOTERMS
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, requireProductMatch: false })
    await gw.upsert({
      record: record({ pais_de_destino: '78', incoterm_cotizacion: '11', tipo_documento_cotizacion: '01' }),
      references: refs
    })
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload.incoterm).toBe(11)
    expect(soPayload.operation_type_sv).toBe('01')
  })

  it('omits saleOrder.incoterm/operation_type_sv when both are unset on the quote', async () => {
    const api = makeApi({
      productMap: { 'SKU-1': 17 },
      operationCosts: [{ id: 78, name: 'DDP Costa Rica', countryId: 50, countryName: 'Costa Rica' }],
      incoterms: INCOTERMS
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, requireProductMatch: false })
    await gw.upsert({
      record: record({ pais_de_destino: '78' }),
      references: refs
    })
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload).not.toHaveProperty('incoterm')
    expect(soPayload).not.toHaveProperty('operation_type_sv')
  })

  it('re-sends incoterm/operation_type_sv on every update, unlike country_expense which is set-once', async () => {
    const api = makeApi({
      productMap: { 'SKU-1': 17 },
      operationCosts: [{ id: 78, name: 'DDP Costa Rica', countryId: 50, countryName: 'Costa Rica' }],
      incoterms: INCOTERMS,
      soSearch: [{ id: 500, name: 'S00500', state: 'draft', countryExpenseId: 78, note: null, hasShippingExpense: false }]
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, requireProductMatch: false })
    await gw.upsert({
      record: record({ pais_de_destino: '78', incoterm_cotizacion: '11', tipo_documento_cotizacion: '01' }),
      references: refs
    })
    const updatePayload = api.updateSalesOrder.mock.calls[0][1]
    // country_expense is NOT resent (already set on the existing SO)...
    expect(updatePayload).not.toHaveProperty('country_expense')
    // ...but incoterm/operation_type_sv always are, since the salesperson may
    // correct their choice before the SO is finalized.
    expect(updatePayload.incoterm).toBe(11)
    expect(updatePayload.operation_type_sv).toBe('01')
  })

  it('honors custom propertyQuoteIncoterm/propertyQuoteDocumentType names', async () => {
    const api = makeApi({
      productMap: { 'SKU-1': 17 },
      operationCosts: [{ id: 78, name: 'DDP Costa Rica', countryId: 50, countryName: 'Costa Rica' }],
      incoterms: INCOTERMS
    })
    const gw = new OdooTargetGateway({
      apiClient: api,
      hashPayload,
      requireProductMatch: false,
      propertyQuoteIncoterm: 'incoterm_custom',
      propertyQuoteDocumentType: 'tipo_doc_custom'
    })
    await gw.upsert({
      record: record({ pais_de_destino: '78', incoterm_custom: '11', tipo_doc_custom: '01' }),
      references: refs
    })
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload.incoterm).toBe(11)
    expect(soPayload.operation_type_sv).toBe('01')
  })
})
