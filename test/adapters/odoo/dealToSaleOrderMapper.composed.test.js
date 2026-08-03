import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { mapDealToSaleOrder } = require('../../../src/adapters/outbound/odoo/dealToSaleOrderMapper.js')

describe('mapDealToSaleOrder — explicit origin', () => {
  it('uses explicit origin when provided (overrides hsDeal.id)', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-1:qQ-1', properties: { dealname: 'X' } },
      odooCustomerId: '5',
      origin: 'hs:D-1:qQ-1',
      hsLineItems: []
    })
    expect(payload.saleOrder.origin).toBe('hs:D-1:qQ-1')
  })

  it('builds composed origin from explicit dealId + quoteId when no origin is given', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-1:qQ-1', properties: { dealname: 'X' } },
      odooCustomerId: '5',
      dealId: 'D-1',
      quoteId: 'Q-1',
      hsLineItems: []
    })
    expect(payload.saleOrder.origin).toBe('hs:D-1:qQ-1')
  })

  it('builds plain origin from explicit dealId when no quoteId is given', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-1', properties: { dealname: 'X' } },
      odooCustomerId: '5',
      dealId: 'D-1',
      hsLineItems: []
    })
    expect(payload.saleOrder.origin).toBe('hs:D-1')
  })

  it('legacy fallback: builds origin from hsDeal.id when no explicit params', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-1', properties: { dealname: 'X' } },
      odooCustomerId: '5',
      hsLineItems: []
    })
    expect(payload.saleOrder.origin).toBe('hs:D-1')
  })

  it('does NOT produce hs:D-1:qQ-1 by accident when hsDeal.id is the composed sourceId', () => {
    // regression: prior bug was that origin = hs:${hsDeal.id} produced hs:D-1:qQ-1
    // when hsDeal.id was the composed sourceId. The explicit origin/dealId params
    // override that.
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-1:qQ-1', properties: { dealname: 'X' } },
      odooCustomerId: '5',
      dealId: 'D-1',
      quoteId: 'Q-1',
      hsLineItems: []
    })
    expect(payload.saleOrder.origin).toBe('hs:D-1:qQ-1')
    expect(payload.saleOrder.origin).not.toBe('hs:D-1:qQ-1:qQ-1') // sanity: no double-prefix
  })
})

describe('mapDealToSaleOrder — note with quote context', () => {
  it('appends quote title and ISO to the note when quote is provided', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-1', properties: { dealname: 'Cool deal' } },
      odooCustomerId: '5',
      dealId: 'D-1',
      quoteId: 'Q-1',
      quote: { id: 'Q-1', properties: { hs_title: 'Cotizacion GT', pais_de_destino: 'GT' } },
      countryCodeProperty: 'pais_de_destino',
      hsLineItems: [{ hs_sku: 'A', productId: 11, quantity: 1, price: 10, name: 'A' }]
    })
    expect(payload.saleOrder.note).toBe('Deal: Cool deal\nCotización: Cotizacion GT (GT)')
  })

  it('includes the quote title but no country when countryCodeProperty is missing on the quote', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-1', properties: { dealname: 'Cool deal' } },
      odooCustomerId: '5',
      dealId: 'D-1',
      quoteId: 'Q-1',
      quote: { id: 'Q-1', properties: { hs_title: 'Cotizacion HN' } },
      countryCodeProperty: 'pais_de_destino',
      hsLineItems: []
    })
    expect(payload.saleOrder.note).toBe('Deal: Cool deal\nCotización: Cotizacion HN')
  })

  it('keeps the legacy note shape when no quote is provided', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-1', properties: { dealname: 'Cool deal' } },
      odooCustomerId: '5',
      hsLineItems: []
    })
    expect(payload.saleOrder.note).toBe('Deal: Cool deal')
  })

  it('omits the note entirely when neither dealname nor quote are present', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-1', properties: {} },
      odooCustomerId: '5',
      hsLineItems: []
    })
    expect(payload.saleOrder.note).toBeUndefined()
  })
})
