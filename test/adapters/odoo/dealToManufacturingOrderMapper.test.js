import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { mapDealToManufacturingOrder } = require('../../../src/adapters/outbound/odoo/dealToManufacturingOrderMapper.js')

describe('mapDealToManufacturingOrder', () => {
  it('produces a payload with origin, partner, line items', () => {
    const payload = mapDealToManufacturingOrder({
      hsDeal: { id: 'D-1', properties: { dealname: 'Cool deal' } },
      odooCustomerId: '42',
      hsLineItems: [{ hs_sku: 'SKU-1', quantity: 2, price: 9.99 }]
    })
    expect(payload.origin).toBe('hs:D-1')
    expect(payload.partner_id).toBe(42)
    expect(payload.product_id).toBe('SKU-1')
    expect(payload.product_qty).toBe(2)
    expect(payload.line_items).toHaveLength(1)
  })

  it('throws transient error when odooCustomerId missing', () => {
    expect(() => mapDealToManufacturingOrder({ hsDeal: { id: 'D-1', properties: {} }, odooCustomerId: null })).toThrow(/odooCustomerId/)
  })

  it('requires hsDeal', () => {
    expect(() => mapDealToManufacturingOrder({ odooCustomerId: '1' })).toThrow(/hsDeal/)
  })
})
