import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { mapDealToSaleOrder } = require('../../../src/adapters/outbound/odoo/dealToSaleOrderMapper.js')

describe('mapDealToSaleOrder', () => {
  it('produces a saleOrder with partner_id and one order_line per hs line item', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-1', properties: { dealname: 'Cool deal' } },
      odooCustomerId: '42',
      hsLineItems: [{ hs_sku: 'SKU-1', productId: 17, quantity: 2, price: 9.99, name: 'Item 1' }]
    })
    expect(payload.saleOrder.origin).toBe('hs:D-1')
    expect(payload.saleOrder.partner_id).toBe(42)
    expect(payload.saleOrder.order_line).toHaveLength(1)
    expect(payload.saleOrder.order_line[0][2].product_id).toBe(17)
    expect(payload.saleOrder.order_line[0][2].product_uom_qty).toBe(2)
    expect(payload.saleOrder.order_line[0][2].price_unit).toBe(9.99)
    expect(payload.saleOrder.order_line[0][2].name).toBe('Item 1')
    expect(payload.saleOrder.note).toBe('Deal: Cool deal')
  })

  it('does not include a manufacturingOrder block', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-1' },
      odooCustomerId: '5',
      hsLineItems: [{ hs_sku: 'A', productId: 11, quantity: 1, price: 10, name: 'A' }]
    })
    expect(payload).not.toHaveProperty('manufacturingOrder')
  })

  it('maps every hs line item to a [0, 0, line] tuple in order_line', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-2' },
      odooCustomerId: '7',
      hsLineItems: [
        { hs_sku: 'A', productId: 11, quantity: 1, price: 10, name: 'A' },
        { hs_sku: 'B', productId: 12, quantity: 3, price: 5, name: 'B' }
      ]
    })
    expect(payload.saleOrder.order_line).toHaveLength(2)
    expect(payload.saleOrder.order_line[0]).toEqual([0, 0, { product_id: 11, name: 'A', product_uom_qty: 1, price_unit: 10 }])
    expect(payload.saleOrder.order_line[1]).toEqual([0, 0, { product_id: 12, name: 'B', product_uom_qty: 3, price_unit: 5 }])
  })

  it('productId on line item takes precedence over hs_sku', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-4' },
      odooCustomerId: '5',
      hsLineItems: [{ hs_sku: 'NON_NUMERIC', productId: 17, quantity: 1, price: 0, name: 'X' }]
    })
    expect(payload.saleOrder.order_line[0][2].product_id).toBe(17)
  })

  it('numeric hs_sku is used as product_id when productId absent', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-5' },
      odooCustomerId: '5',
      hsLineItems: [{ hs_sku: '42', quantity: 1, price: 0, name: 'X' }]
    })
    expect(payload.saleOrder.order_line[0][2].product_id).toBe(42)
  })

  it('non-numeric hs_sku with no productId resolves to null', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-6' },
      odooCustomerId: '5',
      hsLineItems: [{ hs_sku: 'NON_NUMERIC', quantity: 1, price: 0, name: 'X' }]
    })
    expect(payload.saleOrder.order_line[0][2].product_id).toBeNull()
  })

  it('sets product_uom on every order_line from line item productUomId', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-9' },
      odooCustomerId: '5',
      hsLineItems: [
        { hs_sku: 'A', productId: 11, productUomId: 1, quantity: 1, price: 10, name: 'A' },
        { hs_sku: 'B', productId: 12, productUomId: 2, quantity: 3, price: 5, name: 'B' }
      ]
    })
    expect(payload.saleOrder.order_line[0][2].product_uom).toBe(1)
    expect(payload.saleOrder.order_line[1][2].product_uom).toBe(2)
  })

  it('omits product_uom from order_line when productUomId is unknown', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-10' },
      odooCustomerId: '5',
      hsLineItems: [{ hs_sku: '42', quantity: 1, price: 0, name: 'X' }]
    })
    expect(payload.saleOrder.order_line[0][2]).not.toHaveProperty('product_uom')
  })

  it('coerces a string productUomId to a number on order_line', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-11' },
      odooCustomerId: '5',
      hsLineItems: [{ hs_sku: 'A', productId: 11, productUomId: '7', quantity: 1, price: 0, name: 'A' }]
    })
    expect(payload.saleOrder.order_line[0][2].product_uom).toBe(7)
  })

  it('throws MISSING_ODOO_CUSTOMER_ID error when odooCustomerId missing', () => {
    expect(() => mapDealToSaleOrder({ hsDeal: { id: 'D-1', properties: {} }, odooCustomerId: null })).toThrow(/odooCustomerId/)
  })

  it('requires hsDeal', () => {
    expect(() => mapDealToSaleOrder({ odooCustomerId: '1' })).toThrow(/hsDeal/)
  })

  it('includes country_expense in saleOrder when countryExpenseId is provided', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-20' },
      odooCustomerId: '5',
      hsLineItems: [],
      countryExpenseId: 78
    })
    expect(payload.saleOrder.country_expense).toBe(78)
  })

  it('coerces string countryExpenseId to a number', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-20' },
      odooCustomerId: '5',
      hsLineItems: [],
      countryExpenseId: '78'
    })
    expect(payload.saleOrder.country_expense).toBe(78)
  })

  it('omits country_expense when countryExpenseId is null', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-21' },
      odooCustomerId: '5',
      hsLineItems: [],
      countryExpenseId: null
    })
    expect(payload.saleOrder).not.toHaveProperty('country_expense')
  })

  it('omits country_expense when countryExpenseId is undefined (default)', () => {
    const payload = mapDealToSaleOrder({
      hsDeal: { id: 'D-22' },
      odooCustomerId: '5',
      hsLineItems: []
    })
    expect(payload.saleOrder).not.toHaveProperty('country_expense')
  })
})
