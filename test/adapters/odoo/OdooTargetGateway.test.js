import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { OdooTargetGateway } = require('../../../src/adapters/outbound/odoo/OdooTargetGateway.js')
const { hashPayload } = require('../../../src/core/shared/hash.js')

function makeApi({ soSearch = [], soCreate = { id: 'SO-NEW' }, moCreate = { id: 'MO-NEW', ref: null, state: 'draft', raw: {} }, productMap = {} } = {}) {
  return {
    searchSalesOrderByOrigin: vi.fn(async () => soSearch),
    createSalesOrder: vi.fn(async () => soCreate),
    updateSalesOrder: vi.fn(async (id) => ({ id: String(id), ref: null, state: 'draft', raw: {} })),
    createManufacturingOrder: vi.fn(async () => moCreate),
    updateManufacturingOrder: vi.fn(async (id) => ({ id: String(id), ref: null, state: 'confirmed', raw: {} })),
    searchProductIdsByDefaultCodes: vi.fn(async () => productMap)
  }
}

describe('OdooTargetGateway', () => {
  it('upsert creates SO then MO with sale_order_id when no existing SO or MO', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 } })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42', dealname: 'Cool' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 2, price: 9.99, name: 'Item 1' }] }
    })
    expect(api.searchSalesOrderByOrigin).toHaveBeenCalledWith('hs:D-1')
    expect(api.searchProductIdsByDefaultCodes).toHaveBeenCalledWith(['SKU-1'])
    expect(api.createSalesOrder).toHaveBeenCalledTimes(1)
    expect(api.updateSalesOrder).not.toHaveBeenCalled()
    expect(api.createManufacturingOrder).toHaveBeenCalledTimes(1)
    const moPayload = api.createManufacturingOrder.mock.calls[0][0]
    expect(moPayload.origin).toBe('hs:D-1')
    expect(moPayload.product_id).toBe(17)
    expect(moPayload.sale_order_id).toBeUndefined()
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload.order_line[0][2].product_id).toBe(17)
    expect(result.targetId).toBe('MO-NEW')
    expect(result.salesOrderId).toBe('SO-NEW')
  })

  it('upsert reuses existing SO via search and creates MO linked to it', async () => {
    const api = makeApi({ soSearch: ['SO-EXISTING'], productMap: { 'SKU-1': 17 } })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.createSalesOrder).not.toHaveBeenCalled()
    expect(api.updateSalesOrder).toHaveBeenCalledWith('SO-EXISTING', expect.objectContaining({ partner_id: 42 }))
    expect(api.createManufacturingOrder).toHaveBeenCalledTimes(1)
    const moPayload = api.createManufacturingOrder.mock.calls[0][0]
    expect(moPayload.product_id).toBe(17)
    expect(moPayload.sale_order_id).toBeUndefined()
    expect(result.salesOrderId).toBe('SO-EXISTING')
  })

  it('upsert updates existing MO when existingTargetId provided and reuses SO', async () => {
    const api = makeApi({ soSearch: ['SO-EXISTING'], productMap: { 'SKU-1': 17 } })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: 'MO-EXISTING',
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.updateManufacturingOrder).toHaveBeenCalledTimes(1)
    expect(api.createManufacturingOrder).not.toHaveBeenCalled()
    expect(api.updateManufacturingOrder.mock.calls[0][0]).toBe('MO-EXISTING')
    expect(api.updateManufacturingOrder.mock.calls[0][1].product_id).toBe(17)
    expect(api.updateManufacturingOrder.mock.calls[0][1].sale_order_id).toBeUndefined()
    expect(result.targetId).toBe('MO-EXISTING')
    expect(result.salesOrderId).toBe('SO-EXISTING')
  })

  it('upsert falls back to creating SO when search fails', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 } })
    api.searchSalesOrderByOrigin = vi.fn(async () => { throw new Error('search-down') })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.createSalesOrder).toHaveBeenCalledTimes(1)
    expect(result.salesOrderId).toBe('SO-NEW')
  })

  it('skips SKU lookup when all line items already have numeric hs_sku or productId', async () => {
    const api = makeApi({ productMap: {} })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: '17', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.searchProductIdsByDefaultCodes).not.toHaveBeenCalled()
    const moPayload = api.createManufacturingOrder.mock.calls[0][0]
    expect(moPayload.product_id).toBe(17)
  })

  it('falls back gracefully when SKU lookup fails', async () => {
    const api = makeApi()
    api.searchProductIdsByDefaultCodes = vi.fn(async () => { throw new Error('product-down') })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(result.salesOrderId).toBe('SO-NEW')
    const moPayload = api.createManufacturingOrder.mock.calls[0][0]
    expect(moPayload.product_id).toBeNull()
  })

  it('throws transient error when odooCustomerId missing', async () => {
    const api = makeApi()
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await expect(gw.upsert({ existingTargetId: null, record: { id: 'D-1', properties: {} }, references: { lineItems: [] } })).rejects.toMatchObject({ transient: true, code: 'MISSING_ODOO_CUSTOMER_ID' })
  })

  it('propagates non-transient errors from createManufacturingOrder', async () => {
    const api = makeApi()
    api.createManufacturingOrder = vi.fn(async () => { const e = new Error('boom'); e.httpStatus = 500; throw e })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await expect(gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })).rejects.toThrow(/boom/)
  })
})
