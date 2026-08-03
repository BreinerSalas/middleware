import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  HubspotSourceGateway,
  parseSourceId,
  isEligibleQuote,
  listEligibleQuotes
} = require('../../../src/adapters/outbound/hubspot/HubspotSourceGateway.js')

function makeApiClient({
  get = async () => ({ id: 'D-1', properties: {} }),
  getDeal = get,
  getQuote = async () => ({ id: 'Q-1', properties: {} }),
  patch = async () => ({}),
  updateDeal = patch,
  updateQuote = patch,
  getDealLineItems = async () => [],
  getQuoteLineItems = async () => [],
  getDealQuotes = async () => []
} = {}) {
  return {
    getDeal: vi.fn(getDeal),
    getQuote: vi.fn(getQuote),
    getDealAssociations: vi.fn(async () => ({ results: [{ toObjectId: 'C-1' }] })),
    getDealLineItems: vi.fn(getDealLineItems),
    getQuoteLineItems: vi.fn(getQuoteLineItems),
    getDealQuotes: vi.fn(getDealQuotes),
    updateDeal: vi.fn(updateDeal),
    updateQuote: vi.fn(updateQuote)
  }
}

describe('parseSourceId', () => {
  it('returns dealId only when sourceId is a plain deal id', () => {
    expect(parseSourceId('D-1')).toEqual({ dealId: 'D-1', quoteId: null })
  })

  it('returns dealId + quoteId when sourceId is the composed form', () => {
    expect(parseSourceId('D-1:qQ-42')).toEqual({ dealId: 'D-1', quoteId: 'Q-42' })
  })

  it('returns quoteId null when the suffix is malformed', () => {
    expect(parseSourceId('D-1:q')).toEqual({ dealId: 'D-1:q', quoteId: null })
    expect(parseSourceId('D-1:notaQ')).toEqual({ dealId: 'D-1:notaQ', quoteId: null })
  })

  it('returns quoteId null when sourceId is empty / null', () => {
    expect(parseSourceId(null)).toEqual({ dealId: null, quoteId: null })
    expect(parseSourceId('')).toEqual({ dealId: '', quoteId: null })
  })

  it('only splits on the first :q and never splits on : elsewhere', () => {
    expect(parseSourceId('deal-with:colon:qQ-1')).toEqual({ dealId: 'deal-with:colon', quoteId: 'Q-1' })
  })
})

describe('isEligibleQuote', () => {
  const countryProperty = 'pais_de_destino'
  const allowedStatuses = ['APPROVAL_NOT_NEEDED', 'APPROVED']

  it('returns eligible=true when status is allowed AND country is set', () => {
    const r = isEligibleQuote(
      { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', [countryProperty]: 'GT' } },
      { countryProperty, allowedStatuses }
    )
    expect(r).toEqual({ eligible: true, reason: 'ok' })
  })

  it('returns eligible=false with reason=status when status is not allowed', () => {
    const r = isEligibleQuote(
      { id: 'Q-1', properties: { hs_status: 'DRAFT', [countryProperty]: 'GT' } },
      { countryProperty, allowedStatuses }
    )
    expect(r.eligible).toBe(false)
    expect(r.reason).toBe('status_not_eligible')
    expect(r.detail).toMatchObject({ status: 'DRAFT', allowed: allowedStatuses })
  })

  it('returns eligible=false with reason=missing_country when country not set', () => {
    const r = isEligibleQuote(
      { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED' } },
      { countryProperty, allowedStatuses }
    )
    expect(r.eligible).toBe(false)
    expect(r.reason).toBe('missing_country')
  })

  it('returns eligible=false with reason=missing_country when country is empty string', () => {
    const r = isEligibleQuote(
      { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', [countryProperty]: '' } },
      { countryProperty, allowedStatuses }
    )
    expect(r.eligible).toBe(false)
    expect(r.reason).toBe('missing_country')
  })

  it('returns eligible=false with reason=missing_status when status is missing', () => {
    const r = isEligibleQuote(
      { id: 'Q-1', properties: { [countryProperty]: 'GT' } },
      { countryProperty, allowedStatuses }
    )
    expect(r.eligible).toBe(false)
    expect(r.reason).toBe('missing_status')
  })

  it('returns eligible=false with reason=missing_properties when quote.properties is missing', () => {
    const r = isEligibleQuote({ id: 'Q-1' }, { countryProperty, allowedStatuses })
    expect(r.eligible).toBe(false)
    expect(r.reason).toBe('missing_properties')
  })
})

describe('listEligibleQuotes', () => {
  it('partitions the deal quotes into eligible and skipped lists with reasons', async () => {
    const api = makeApiClient({
      getDealQuotes: async () => [
        { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'GT' } },
        { id: 'Q-2', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'HN' } },
        { id: 'Q-3', properties: { hs_status: 'APPROVAL_NOT_NEEDED' } },
        { id: 'Q-4', properties: { hs_status: 'DRAFT', pais_de_destino: 'SV' } },
        { id: 'Q-5', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'MX' } }
      ]
    })
    const gw = new HubspotSourceGateway({
      apiClient: api,
      propertyOdooCustomerId: 'id_cliente_odoo',
      propertyOdooOrderId: 'id_orden_odoo',
      propertyOdooQuoteId: 'id_presupuesto_odoo',
      propertyQuoteCountry: 'pais_de_destino',
      quoteEligibleStatuses: ['APPROVAL_NOT_NEEDED']
    })
    const { eligible, skipped, currencies } = await listEligibleQuotes({ dealId: 'D-1', sourceGateway: gw })
    expect(eligible.map((q) => q.id)).toEqual(['Q-1', 'Q-2', 'Q-5'])
    expect(skipped).toEqual([
      { quoteId: 'Q-3', reason: 'missing_country' },
      { quoteId: 'Q-4', reason: 'status_not_eligible' }
    ])
    expect(currencies).toEqual([]) // none of the test quotes have hs_currency set
  })

  it('returns currencies distinct list when hs_currency differs across eligible quotes', async () => {
    const api = makeApiClient({
      getDealQuotes: async () => [
        { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'GT', hs_currency: 'USD' } },
        { id: 'Q-2', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'HN', hs_currency: 'GTQ' } }
      ]
    })
    const gw = new HubspotSourceGateway({
      apiClient: api,
      propertyOdooCustomerId: 'a',
      propertyOdooOrderId: 'b',
      propertyOdooQuoteId: 'c',
      propertyQuoteCountry: 'pais_de_destino',
      quoteEligibleStatuses: ['APPROVAL_NOT_NEEDED']
    })
    const { eligible, currencies } = await listEligibleQuotes({ dealId: 'D-1', sourceGateway: gw })
    expect(eligible).toHaveLength(2)
    expect(currencies.sort()).toEqual(['GTQ', 'USD'])
  })

  it('returns empty eligible + empty skipped when the deal has no quotes', async () => {
    const api = makeApiClient({ getDealQuotes: async () => [] })
    const gw = new HubspotSourceGateway({
      apiClient: api,
      propertyOdooCustomerId: 'a',
      propertyOdooOrderId: 'b',
      propertyOdooQuoteId: 'c',
      propertyQuoteCountry: 'pais_de_destino',
      quoteEligibleStatuses: ['APPROVAL_NOT_NEEDED']
    })
    const { eligible, skipped, currencies } = await listEligibleQuotes({ dealId: 'D-1', sourceGateway: gw })
    expect(eligible).toEqual([])
    expect(skipped).toEqual([])
    expect(currencies).toEqual([])
  })
})

describe('HubspotSourceGateway — composed sourceId', () => {
  it('fetchRecord with composed sourceId fetches deal + quote and returns both', async () => {
    const api = makeApiClient({
      getDeal: async () => ({ id: 'D-1', properties: { dealname: 'X' } }),
      getQuote: async () => ({ id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'GT' } })
    })
    const gw = new HubspotSourceGateway({
      apiClient: api,
      propertyOdooCustomerId: 'a',
      propertyOdooOrderId: 'b',
      propertyOdooQuoteId: 'c',
      propertyQuoteCountry: 'pais_de_destino'
    })
    const rec = await gw.fetchRecord('D-1:qQ-1')
    expect(rec.id).toBe('D-1:qQ-1')
    expect(rec.dealId).toBe('D-1')
    expect(rec.quoteId).toBe('Q-1')
    expect(rec.properties.dealname).toBe('X')
    expect(rec.quote).toEqual({ id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'GT' } })
    expect(api.getDeal).toHaveBeenCalledWith('D-1', expect.any(Array))
    expect(api.getQuote).toHaveBeenCalledWith('Q-1', expect.any(Array))
  })

  it('fetchRecord without quoteId keeps the legacy shape (no quote field)', async () => {
    const api = makeApiClient({ get: async () => ({ id: 'D-1', properties: { dealname: 'X' } }) })
    const gw = new HubspotSourceGateway({
      apiClient: api,
      propertyOdooCustomerId: 'a',
      propertyOdooOrderId: 'b',
      propertyOdooQuoteId: 'c'
    })
    const rec = await gw.fetchRecord('D-1')
    expect(rec.id).toBe('D-1')
    expect(rec.dealId).toBe('D-1')
    expect(rec.quoteId).toBeNull()
    expect(rec.quote).toBeUndefined()
    expect(api.getDeal).toHaveBeenCalledWith('D-1', expect.any(Array))
    expect(api.getQuote).not.toHaveBeenCalled()
  })

  it('resolveReferences uses getQuoteLineItems when the record has a quoteId', async () => {
    const api = makeApiClient({
      getDealLineItems: vi.fn(async () => [{ id: 'L-DEAL', hs_sku: 'SKU-DEAL', quantity: 1, price: 0, name: 'Deal L' }]),
      getQuoteLineItems: vi.fn(async () => [{ id: 'L-Q', hs_sku: 'SKU-Q', quantity: 2, price: 9.99, name: 'Quote L' }])
    })
    const gw = new HubspotSourceGateway({
      apiClient: api,
      propertyOdooCustomerId: 'a',
      propertyOdooOrderId: 'b',
      propertyOdooQuoteId: 'c'
    })
    const refs = await gw.resolveReferences({ id: 'D-1:qQ-1', dealId: 'D-1', quoteId: 'Q-1', properties: {}, quote: { id: 'Q-1', properties: {} } })
    expect(api.getQuoteLineItems).toHaveBeenCalledWith('Q-1')
    expect(api.getDealLineItems).not.toHaveBeenCalled()
    expect(refs.lineItems).toEqual([{ id: 'L-Q', hs_sku: 'SKU-Q', quantity: 2, price: 9.99, name: 'Quote L' }])
  })

  it('resolveReferences keeps legacy behavior when the record has no quoteId', async () => {
    const api = makeApiClient({
      getDealLineItems: vi.fn(async () => [{ id: 'L-DEAL', hs_sku: 'SKU-DEAL', quantity: 1, price: 0, name: 'X' }])
    })
    const gw = new HubspotSourceGateway({
      apiClient: api,
      propertyOdooCustomerId: 'a',
      propertyOdooOrderId: 'b',
      propertyOdooQuoteId: 'c'
    })
    const refs = await gw.resolveReferences({ id: 'D-1', properties: {} })
    expect(api.getDealLineItems).toHaveBeenCalledWith('D-1')
    expect(api.getQuoteLineItems).not.toHaveBeenCalled()
    expect(refs.lineItems).toEqual([{ id: 'L-DEAL', hs_sku: 'SKU-DEAL', quantity: 1, price: 0, name: 'X' }])
  })

  it('writeBack uses updateQuote when the sourceId is composed', async () => {
    const api = makeApiClient()
    const gw = new HubspotSourceGateway({
      apiClient: api,
      propertyOdooCustomerId: 'cust',
      propertyOdooOrderId: 'order',
      propertyOdooQuoteId: 'id_presupuesto_odoo'
    })
    await gw.writeBack('D-1:qQ-1', { id_presupuesto_odoo: 'S06613' })
    expect(api.updateQuote).toHaveBeenCalledWith('Q-1', { id_presupuesto_odoo: 'S06613' })
    expect(api.updateDeal).not.toHaveBeenCalled()
  })

  it('writeBack keeps legacy deal-update path when the sourceId is plain deal', async () => {
    const api = makeApiClient()
    const gw = new HubspotSourceGateway({
      apiClient: api,
      propertyOdooCustomerId: 'cust',
      propertyOdooOrderId: 'order',
      propertyOdooQuoteId: 'id_presupuesto_odoo'
    })
    await gw.writeBack('D-1', { id_presupuesto_odoo: 'S06613' })
    expect(api.updateDeal).toHaveBeenCalledWith('D-1', { id_presupuesto_odoo: 'S06613' })
    expect(api.updateQuote).not.toHaveBeenCalled()
  })

  it('writeBack echo guard keys by the (possibly composed) sourceId', async () => {
    const api = makeApiClient()
    const { createEchoGuard } = require('../../../src/core/shared/echoGuard.js')
    const echo = createEchoGuard({ ttlMs: 5000 })
    const gw = new HubspotSourceGateway({
      apiClient: api,
      propertyOdooCustomerId: 'cust',
      propertyOdooOrderId: 'order',
      propertyOdooQuoteId: 'id_presupuesto_odoo',
      echoGuard: echo
    })
    await gw.writeBack('D-1:qQ-1', { id_presupuesto_odoo: 'S06613' })
    await gw.writeBack('D-1:qQ-1', { id_presupuesto_odoo: 'S06613' })
    expect(api.updateQuote).toHaveBeenCalledTimes(1)
  })
})
