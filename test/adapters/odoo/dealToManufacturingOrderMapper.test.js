import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { mapDealToManufacturingOrder } = require('../../../src/adapters/outbound/odoo/dealToManufacturingOrderMapper.js')

describe('mapDealToManufacturingOrder', () => {
  it('produces composite payload: saleOrder with partner_id and order_line, manufacturingOrder with product fields', () => {
    const payload = mapDealToManufacturingOrder({
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

    expect(payload.manufacturingOrder.origin).toBe('hs:D-1')
    expect(payload.manufacturingOrder.product_id).toBe(17)
    expect(payload.manufacturingOrder.product_qty).toBe(2)
    expect(payload.manufacturingOrder.company_id).toBe(1)
    expect(payload.manufacturingOrder.partner_id).toBeUndefined()
    expect(payload.manufacturingOrder.line_items).toBeUndefined()
  })

  it('saleOrder.order_line maps every hs line item with proper tuple shape', () => {
    const payload = mapDealToManufacturingOrder({
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

  it('manufacturingOrder uses first line item as the product to manufacture', () => {
    const payload = mapDealToManufacturingOrder({
      hsDeal: { id: 'D-3' },
      odooCustomerId: '5',
      hsLineItems: [
        { hs_sku: 'FIRST', productId: 21, quantity: 10, price: 1, name: 'first' },
        { hs_sku: 'SECOND', productId: 22, quantity: 5, price: 2, name: 'second' }
      ]
    })
    expect(payload.manufacturingOrder.product_id).toBe(21)
    expect(payload.manufacturingOrder.product_qty).toBe(10)
  })

  it('productId on line item takes precedence over hs_sku', () => {
    const payload = mapDealToManufacturingOrder({
      hsDeal: { id: 'D-4' },
      odooCustomerId: '5',
      hsLineItems: [{ hs_sku: 'NON_NUMERIC', productId: 17, quantity: 1, price: 0, name: 'X' }]
    })
    expect(payload.saleOrder.order_line[0][2].product_id).toBe(17)
    expect(payload.manufacturingOrder.product_id).toBe(17)
  })

  it('numeric hs_sku is used as product_id when productId absent', () => {
    const payload = mapDealToManufacturingOrder({
      hsDeal: { id: 'D-5' },
      odooCustomerId: '5',
      hsLineItems: [{ hs_sku: '42', quantity: 1, price: 0, name: 'X' }]
    })
    expect(payload.saleOrder.order_line[0][2].product_id).toBe(42)
    expect(payload.manufacturingOrder.product_id).toBe(42)
  })

  it('non-numeric hs_sku with no productId resolves to null', () => {
    const payload = mapDealToManufacturingOrder({
      hsDeal: { id: 'D-6' },
      odooCustomerId: '5',
      hsLineItems: [{ hs_sku: 'NON_NUMERIC', quantity: 1, price: 0, name: 'X' }]
    })
    expect(payload.saleOrder.order_line[0][2].product_id).toBeNull()
    expect(payload.manufacturingOrder.product_id).toBeNull()
  })

  it('sets product_uom_id on manufacturingOrder from line item productUomId', () => {
    const payload = mapDealToManufacturingOrder({
      hsDeal: { id: 'D-7' },
      odooCustomerId: '5',
      hsLineItems: [{ hs_sku: 'SKU-1', productId: 17, productUomId: 5, quantity: 1, price: 0, name: 'X' }]
    })
    expect(payload.manufacturingOrder.product_uom_id).toBe(5)
  })

  it('does not set product_uom_id when line item has no productUomId (legacy / numeric sku path)', () => {
    const payload = mapDealToManufacturingOrder({
      hsDeal: { id: 'D-8' },
      odooCustomerId: '5',
      hsLineItems: [{ hs_sku: '42', quantity: 1, price: 0, name: 'X' }]
    })
    expect(payload.manufacturingOrder.product_uom_id).toBeUndefined()
  })

  it('throws transient error when odooCustomerId missing', () => {
    expect(() => mapDealToManufacturingOrder({ hsDeal: { id: 'D-1', properties: {} }, odooCustomerId: null })).toThrow(/odooCustomerId/)
  })

  it('requires hsDeal', () => {
    expect(() => mapDealToManufacturingOrder({ odooCustomerId: '1' })).toThrow(/hsDeal/)
  })
})
