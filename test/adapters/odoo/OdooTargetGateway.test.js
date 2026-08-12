import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { OdooTargetGateway, collectUnresolvedLines } = require('../../../src/adapters/outbound/odoo/OdooTargetGateway.js')
const { hashPayload } = require('../../../src/core/shared/hash.js')

function makeApi({
  soSearch = [],
  soCreate = { id: 'SO-NEW', ref: 'S00001', state: 'draft', raw: {} },
  productMap = {},
  nameMap = null,
  partnerCountry = { 42: { countryId: 49, countryName: 'Colombia', parentId: null } },
  operationCosts = [
    { id: 78, name: 'DDP Colombia', countryId: 49, countryName: 'Colombia', productId: null }
  ]
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
  // searchProductIdsByNames / readProductUoms se agregan solo cuando el test los pide,
  // para que las guardias de retrocompatibilidad se sigan ejercitando.
  if (nameMap) api.searchProductIdsByNames = vi.fn(async () => nameMap)
  return api
}

describe('collectUnresolvedLines', () => {
  it('returns an empty array for an empty or non-array input', () => {
    expect(collectUnresolvedLines([])).toEqual([])
    expect(collectUnresolvedLines(null)).toEqual([])
  })

  it('ignores line items that resolved', () => {
    expect(collectUnresolvedLines([{ id: 'L-1', productId: 17, name: 'X' }])).toEqual([])
    expect(collectUnresolvedLines([{ id: 'L-2', hs_sku: '42', name: 'X' }])).toEqual([])
  })

  it('reports not_found for a line item with an unresolvable sku', () => {
    expect(collectUnresolvedLines([{ id: 'L-1', hs_sku: 'NOPE', name: 'Cosa' }])).toEqual([
      { lineItemId: 'L-1', name: 'Cosa', hsSku: 'NOPE', reason: 'not_found' }
    ])
  })

  it('reports no_name_no_sku when the line item has neither', () => {
    expect(collectUnresolvedLines([{ id: 'L-1', hs_sku: null, name: '  ' }])).toEqual([
      { lineItemId: 'L-1', name: null, hsSku: null, reason: 'no_name_no_sku' }
    ])
  })

  it('name_ambiguous takes precedence and carries the candidates', () => {
    expect(collectUnresolvedLines([
      { id: 'L-1', hs_sku: null, name: 'Dup', productResolutionError: 'name_ambiguous', productNameCandidates: [1, 2] }
    ])).toEqual([
      { lineItemId: 'L-1', name: 'Dup', hsSku: null, reason: 'name_ambiguous', candidates: [1, 2] }
    ])
  })

  it('collects a mixed batch, keeping only the unresolved ones', () => {
    const out = collectUnresolvedLines([
      { id: 'L-1', productId: 17, name: 'ok' },
      { id: 'L-2', hs_sku: 'NOPE', name: 'malo' },
      { id: 'L-3', hs_sku: null, name: null }
    ])
    expect(out.map((u) => u.lineItemId)).toEqual(['L-2', 'L-3'])
    expect(out.map((u) => u.reason)).toEqual(['not_found', 'no_name_no_sku'])
  })
})

describe('OdooTargetGateway', () => {
  it('upsert creates SO when no existing SO and returns country_expense in metadata', async () => {
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
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload.origin).toBe('hs:D-1')
    expect(soPayload.partner_id).toBe(42)
    expect(soPayload.order_line[0][2].product_id).toBe(17)
    expect(soPayload.country_expense).toBe(78)
    expect(result.targetId).toBe('SO-NEW')
    expect(result.targetRef).toBe('S00001')
    expect(result.salesOrderId).toBe('SO-NEW')
    expect(result.metadata.countryExpense.status).toBe('resolved')
    expect(result.metadata.countryExpense.id).toBe(78)
  })

  it('upsert reuses existing SO via search and updates it, replacing order_line with the current HubSpot lines (Fase 6 — ping-pong)', async () => {
    const api = makeApi({
      soSearch: [{ id: 17, name: 'S00017', state: 'draft', countryExpenseId: 78 }],
      productMap: { 'SKU-1': 17 }
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 3, price: 9.5, name: 'X' }] }
    })
    expect(api.createSalesOrder).not.toHaveBeenCalled()
    expect(api.updateSalesOrder).toHaveBeenCalledWith(17, expect.objectContaining({
      origin: 'hs:D-1',
      partner_id: 42
    }))
    const updatePayload = api.updateSalesOrder.mock.calls[0][1]
    expect(updatePayload.order_line[0]).toEqual([5, 0, 0])
    expect(updatePayload.order_line[1]).toEqual([0, 0, expect.objectContaining({ product_id: 17, product_uom_qty: 3, price_unit: 9.5 })])
    expect(updatePayload).not.toHaveProperty('country_expense')
    expect(result.targetId).toBe('17')
    expect(result.salesOrderId).toBe('17')
  })

  it('upsert tolerates legacy soSearch returning bare ids (no name/state)', async () => {
    const api = makeApi({ soSearch: ['17'], productMap: { 'SKU-1': 17 } })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.updateSalesOrder).toHaveBeenCalledWith('17', expect.objectContaining({ partner_id: 42 }))
    expect(result.targetId).toBe('17')
  })

  it('ignores existingTargetId (Risk 2: stale MO id never reaches updateSalesOrder)', async () => {
    const api = makeApi({
      soSearch: [{ id: 17, name: 'S00017', state: 'draft', countryExpenseId: 78 }],
      productMap: { 'SKU-1': 17 }
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      existingTargetId: 'MO-STALE-99',
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.updateSalesOrder).toHaveBeenCalledWith(17, expect.anything())
    expect(api.updateSalesOrder).not.toHaveBeenCalledWith('MO-STALE-99', expect.anything())
  })

  it('never calls createManufacturingOrder or updateManufacturingOrder, even with existingTargetId set', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 } })
    api.createManufacturingOrder = vi.fn(async () => ({ id: 'MO-X', ref: null, state: 'draft', raw: {} }))
    api.updateManufacturingOrder = vi.fn(async (id) => ({ id: String(id), ref: null, state: 'confirmed', raw: {} }))
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      existingTargetId: 'MO-EXISTING',
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.createManufacturingOrder).not.toHaveBeenCalled()
    expect(api.updateManufacturingOrder).not.toHaveBeenCalled()
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
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload.order_line[0][2].product_id).toBe(17)
  })

  it('rethrows transient when the default_code lookup fails (Odoo down is retryable)', async () => {
    const api = makeApi()
    api.searchProductIdsByDefaultCodes = vi.fn(async () => { throw new Error('product-down') })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await expect(gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })).rejects.toMatchObject({ transient: true })
    expect(api.createSalesOrder).not.toHaveBeenCalled()
  })

  it('fills product_uom on the SO line by reading the uom of a numeric hs_sku', async () => {
    const api = makeApi()
    api.readProductUoms = vi.fn(async () => ({ 17: 1 }))
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: '17', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.readProductUoms).toHaveBeenCalledWith([17])
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload.order_line[0][2].product_uom).toBe(1)
  })

  it('does not read uoms when the default_code lookup already supplied them', async () => {
    const api = makeApi({ productMap: { 'SKU-1': { id: 17, uomId: 3 } } })
    api.readProductUoms = vi.fn(async () => ({}))
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.readProductUoms).not.toHaveBeenCalled()
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload.order_line[0][2].product_uom).toBe(3)
  })

  it('degrades gracefully when readProductUoms throws', async () => {
    const api = makeApi()
    api.readProductUoms = vi.fn(async () => { throw new Error('uom-down') })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: '17', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(result.salesOrderId).toBe('SO-NEW')
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload.order_line[0][2]).not.toHaveProperty('product_uom')
  })

  it('works with an apiClient that has no readProductUoms (back-compat)', async () => {
    const api = makeApi()
    expect(api.readProductUoms).toBeUndefined()
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: '17', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(result.salesOrderId).toBe('SO-NEW')
  })

  it('does not attempt a uom read when the product id could not be resolved', async () => {
    const api = makeApi({ productMap: {} })
    api.readProductUoms = vi.fn(async () => ({}))
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, requireProductMatch: false })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'UNRESOLVABLE', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.readProductUoms).not.toHaveBeenCalled()
  })

  it('resolves the product by name when hs_sku is null, and fills product_uom from it', async () => {
    const api = makeApi({ nameMap: { 'wow cabecera de gondola': { id: 18442, uomId: 1, matches: 1, ids: [18442] } } })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ id: 'L-1', hs_sku: null, quantity: 4, price: 37.12, name: 'WOW CABECERA DE GONDOLA' }] }
    })
    expect(api.searchProductIdsByDefaultCodes).not.toHaveBeenCalled()
    expect(api.searchProductIdsByNames).toHaveBeenCalledWith(['WOW CABECERA DE GONDOLA'])
    const line = api.createSalesOrder.mock.calls[0][0].order_line[0][2]
    expect(line.product_id).toBe(18442)
    expect(line.product_uom).toBe(1)
  })

  it('falls through to the name lookup when the default_code lookup misses', async () => {
    const api = makeApi({ productMap: {}, nameMap: { 'item uno': { id: 55, uomId: 2, matches: 1, ids: [55] } } })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ id: 'L-1', hs_sku: 'NOPE', quantity: 1, price: 0, name: 'Item Uno' }] }
    })
    expect(api.searchProductIdsByDefaultCodes).toHaveBeenCalledWith(['NOPE'])
    expect(api.searchProductIdsByNames).toHaveBeenCalledWith(['Item Uno'])
    expect(api.createSalesOrder.mock.calls[0][0].order_line[0][2].product_id).toBe(55)
  })

  it('default_code wins over name: the name lookup is never called', async () => {
    const api = makeApi({ productMap: { 'SKU-1': { id: 17, uomId: 1 } }, nameMap: { x: { id: 999, uomId: 1, matches: 1, ids: [999] } } })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ id: 'L-1', hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.searchProductIdsByNames).not.toHaveBeenCalled()
    expect(api.createSalesOrder.mock.calls[0][0].order_line[0][2].product_id).toBe(17)
  })

  it('a numeric hs_sku short-circuits both lookups', async () => {
    const api = makeApi({ nameMap: { x: { id: 999, uomId: 1, matches: 1, ids: [999] } } })
    api.readProductUoms = vi.fn(async () => ({ 17: 1 }))
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ id: 'L-1', hs_sku: '17', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.searchProductIdsByDefaultCodes).not.toHaveBeenCalled()
    expect(api.searchProductIdsByNames).not.toHaveBeenCalled()
    expect(api.createSalesOrder.mock.calls[0][0].order_line[0][2].product_id).toBe(17)
  })

  it('batches the name lookup into a single call with distinct names', async () => {
    const api = makeApi({
      nameMap: {
        uno: { id: 1, uomId: 1, matches: 1, ids: [1] },
        dos: { id: 2, uomId: 1, matches: 1, ids: [2] }
      }
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: {
        lineItems: [
          { id: 'L-1', hs_sku: null, quantity: 1, price: 0, name: 'Uno' },
          { id: 'L-2', hs_sku: null, quantity: 1, price: 0, name: 'Dos' },
          { id: 'L-3', hs_sku: null, quantity: 1, price: 0, name: '  uno  ' }
        ]
      }
    })
    expect(api.searchProductIdsByNames).toHaveBeenCalledTimes(1)
    expect(api.searchProductIdsByNames.mock.calls[0][0]).toEqual(['Uno', 'Dos'])
    const lines = api.createSalesOrder.mock.calls[0][0].order_line
    expect(lines[0][2].product_id).toBe(1)
    expect(lines[2][2].product_id).toBe(1)
  })

  it('refuses to guess on an ambiguous name and skips with the candidate ids', async () => {
    const api = makeApi({ nameMap: { dup: { id: 18442, uomId: 1, matches: 2, ids: [18442, 18999] } } })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await expect(gw.upsert({
      existingTargetId: null,
      record: { id: 'D-9', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ id: 'L-1', hs_sku: null, quantity: 1, price: 0, name: 'Dup' }] }
    })).rejects.toMatchObject({
      code: 'SKIP_SYNC',
      detail: { code: 'ODOO_PRODUCT_NAME_AMBIGUOUS', sourceId: 'D-9' }
    })
    expect(api.createSalesOrder).not.toHaveBeenCalled()
  })

  it('skips with a legible reason when nothing resolves, without writing to Odoo', async () => {
    const api = makeApi({ productMap: {}, nameMap: {} })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    let caught
    try {
      await gw.upsert({
        existingTargetId: null,
        record: { id: 'D-9', properties: { id_cliente_odoo: '42' } },
        references: { lineItems: [{ id: 'L-1', hs_sku: null, quantity: 1, price: 0, name: 'Fantasma' }] }
      })
    } catch (err) { caught = err }
    expect(caught.code).toBe('SKIP_SYNC')
    expect(caught.detail.code).toBe('ODOO_PRODUCT_NOT_FOUND')
    expect(caught.message).toContain('L-1')
    expect(caught.message).toContain('Fantasma')
    expect(caught.detail.unresolved).toEqual([
      { lineItemId: 'L-1', name: 'Fantasma', hsSku: null, reason: 'not_found' }
    ])
    expect(api.createSalesOrder).not.toHaveBeenCalled()
  })

  it('never queries Odoo with an empty name when the line item has neither sku nor name', async () => {
    const api = makeApi({ nameMap: {} })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await expect(gw.upsert({
      existingTargetId: null,
      record: { id: 'D-9', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ id: 'L-1', hs_sku: null, quantity: 1, price: 0, name: '   ' }] }
    })).rejects.toMatchObject({ detail: { unresolved: [{ reason: 'no_name_no_sku' }] } })
    expect(api.searchProductIdsByNames).not.toHaveBeenCalled()
  })

  it('rethrows transient when the name lookup fails', async () => {
    const api = makeApi({ nameMap: {} })
    api.searchProductIdsByNames = vi.fn(async () => { throw new Error('odoo-down') })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await expect(gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ id: 'L-1', hs_sku: null, quantity: 1, price: 0, name: 'X' }] }
    })).rejects.toMatchObject({ transient: true })
  })

  it('works with an apiClient that has no searchProductIdsByNames (back-compat)', async () => {
    const api = makeApi({ productMap: {} })
    expect(api.searchProductIdsByNames).toBeUndefined()
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await expect(gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ id: 'L-1', hs_sku: 'NOPE', quantity: 1, price: 0, name: 'X' }] }
    })).rejects.toMatchObject({ code: 'SKIP_SYNC' })
  })

  it('requireProductMatch false preserves the old permissive behaviour (stub mode)', async () => {
    const api = makeApi({ productMap: {} })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, requireProductMatch: false })
    const result = await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ id: 'L-1', hs_sku: 'NOPE', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(result.salesOrderId).toBe('SO-NEW')
    expect(api.createSalesOrder.mock.calls[0][0].order_line[0][2].product_id).toBeNull()
  })

  it('throws transient error when odooCustomerId missing', async () => {
    const api = makeApi()
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await expect(gw.upsert({ existingTargetId: null, record: { id: 'D-1', properties: {} }, references: { lineItems: [] } })).rejects.toMatchObject({ transient: true, code: 'MISSING_ODOO_CUSTOMER_ID' })
  })

  it('propagates non-transient errors from createSalesOrder', async () => {
    const api = makeApi({ productMap: { 'SKU-1': { id: 17, uomId: 1 } } })
    api.createSalesOrder = vi.fn(async () => { const e = new Error('boom'); e.httpStatus = 500; throw e })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await expect(gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })).rejects.toThrow(/boom/)
  })

  it('uses defaultCustomerId from constructor as final fallback when deal property and references are missing', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 } })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, defaultCustomerId: '99' })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: {} },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload.partner_id).toBe(99)
  })

  it('prefers deal property over defaultCustomerId', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 } })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, defaultCustomerId: '99' })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload.partner_id).toBe(42)
  })

  it('ignores defaultCustomerId when not configured (empty string)', async () => {
    const api = makeApi()
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await expect(gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: {} },
      references: { lineItems: [] }
    })).rejects.toMatchObject({ transient: true, code: 'MISSING_ODOO_CUSTOMER_ID' })
  })

  it('extracts numeric id from object form in productMap (regression: real Odoo returns {id, uomId})', async () => {
    const api = makeApi({ productMap: { 'SKU-1': { id: 17, uomId: 1 } } })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload.order_line[0][2].product_id).toBe(17)
  })

  it('accepts numeric productMap value (backward compat: stubs/tests use plain numbers)', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 } })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload.order_line[0][2].product_id).toBe(17)
  })
})

describe('OdooTargetGateway auto-confirm (Fase 4 — docs/plan-cambios-2026-08-05.md)', () => {
  it('does not call confirmSalesOrder when autoConfirm is off (default)', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 } })
    api.confirmSalesOrder = vi.fn(async () => ({ confirmed: true }))
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.confirmSalesOrder).not.toHaveBeenCalled()
    expect(result.metadata.confirmation).toBeNull()
  })

  it('confirms a newly-created sale.order when autoConfirm is on and records the outcome', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 }, soCreate: { id: 'SO-NEW', ref: 'S00001', state: 'draft', raw: {} } })
    api.confirmSalesOrder = vi.fn(async () => ({ confirmed: true }))
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, autoConfirm: true })
    const result = await gw.upsert({
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.confirmSalesOrder).toHaveBeenCalledWith('SO-NEW')
    expect(result.metadata.confirmation).toEqual({ status: 'confirmed', reason: null })
  })

  it('confirms an updated (existing) sale.order too', async () => {
    const api = makeApi({
      soSearch: [{ id: 17, name: 'S00017', state: 'draft', countryExpenseId: 78 }],
      productMap: { 'SKU-1': 17 }
    })
    api.confirmSalesOrder = vi.fn(async () => ({ confirmed: true }))
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, autoConfirm: true })
    const result = await gw.upsert({
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.confirmSalesOrder).toHaveBeenCalledWith('17')
    expect(result.metadata.confirmation).toEqual({ status: 'confirmed', reason: null })
  })

  it('records a rejection without throwing when Odoo refuses to confirm (e.g. stock/credit rule)', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 } })
    api.confirmSalesOrder = vi.fn(async () => { throw new Error('No hay stock suficiente') })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, autoConfirm: true })
    const result = await gw.upsert({
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(result.metadata.confirmation).toEqual({ status: 'rejected', reason: 'No hay stock suficiente' })
    expect(result.targetId).toBe('SO-NEW')
  })

  it('looks up the manufacturing order by sale.order name after a successful confirm', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 }, soCreate: { id: 'SO-NEW', ref: 'S00001', state: 'draft', raw: {} } })
    api.confirmSalesOrder = vi.fn(async () => ({ confirmed: true }))
    api.findManufacturingOrderBySaleOrderName = vi.fn(async () => ({ id: 88, name: 'WH/MO/00042' }))
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, autoConfirm: true })
    const result = await gw.upsert({
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.findManufacturingOrderBySaleOrderName).toHaveBeenCalledWith('S00001')
    expect(result.metadata.manufacturingOrder).toEqual({ id: 88, name: 'WH/MO/00042' })
  })

  it('does not look up the MO when confirmation was rejected', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 } })
    api.confirmSalesOrder = vi.fn(async () => { throw new Error('rejected') })
    api.findManufacturingOrderBySaleOrderName = vi.fn(async () => ({ id: 88, name: 'WH/MO/00042' }))
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, autoConfirm: true })
    const result = await gw.upsert({
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.findManufacturingOrderBySaleOrderName).not.toHaveBeenCalled()
    expect(result.metadata.manufacturingOrder).toBeNull()
  })

  it('does not look up the MO when autoConfirm is off', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 } })
    api.findManufacturingOrderBySaleOrderName = vi.fn(async () => ({ id: 88, name: 'WH/MO/00042' }))
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.findManufacturingOrderBySaleOrderName).not.toHaveBeenCalled()
    expect(result.metadata.manufacturingOrder).toBeNull()
  })

  it('the MO not existing yet (null) does not fail the upsert', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 }, soCreate: { id: 'SO-NEW', ref: 'S00001', state: 'draft', raw: {} } })
    api.confirmSalesOrder = vi.fn(async () => ({ confirmed: true }))
    api.findManufacturingOrderBySaleOrderName = vi.fn(async () => null)
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, autoConfirm: true })
    const result = await gw.upsert({
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(result.metadata.manufacturingOrder).toBeNull()
    expect(result.targetId).toBe('SO-NEW')
  })

  it('a failed MO lookup does not fail the upsert (soft failure, logged)', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 }, soCreate: { id: 'SO-NEW', ref: 'S00001', state: 'draft', raw: {} } })
    api.confirmSalesOrder = vi.fn(async () => ({ confirmed: true }))
    api.findManufacturingOrderBySaleOrderName = vi.fn(async () => { throw new Error('boom') })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, autoConfirm: true })
    const result = await gw.upsert({
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(result.metadata.manufacturingOrder).toBeNull()
    expect(result.targetId).toBe('SO-NEW')
  })
})

describe('OdooTargetGateway revive cancelled sale.order (Fase 6 — ping-pong cancelar/corregir en HubSpot/cerrar-ganado)', () => {
  it('revives (action_draft) a cancelled existing SO before updating/confirming it', async () => {
    const api = makeApi({
      soSearch: [{ id: 17, name: 'S00017', state: 'cancel', countryExpenseId: 78 }],
      productMap: { 'SKU-1': 17 }
    })
    api.reviveSalesOrderToDraft = vi.fn(async () => ({ state: 'draft' }))
    api.confirmSalesOrder = vi.fn(async () => ({ confirmed: true }))
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, autoConfirm: true })
    await gw.upsert({
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.reviveSalesOrderToDraft).toHaveBeenCalledWith(17)
    expect(api.reviveSalesOrderToDraft.mock.invocationCallOrder[0])
      .toBeLessThan(api.updateSalesOrder.mock.invocationCallOrder[0])
    expect(api.confirmSalesOrder).toHaveBeenCalledWith('17')
  })

  it('does not call reviveSalesOrderToDraft when the existing SO is not cancelled', async () => {
    const api = makeApi({
      soSearch: [{ id: 17, name: 'S00017', state: 'sale', countryExpenseId: 78 }],
      productMap: { 'SKU-1': 17 }
    })
    api.reviveSalesOrderToDraft = vi.fn(async () => ({ state: 'draft' }))
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.reviveSalesOrderToDraft).not.toHaveBeenCalled()
  })

  it('does not call reviveSalesOrderToDraft when creating a brand-new SO', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 } })
    api.reviveSalesOrderToDraft = vi.fn(async () => ({ state: 'draft' }))
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.reviveSalesOrderToDraft).not.toHaveBeenCalled()
  })

  it('cancels orphaned manufacturing orders (by SO name) before reviving a cancelled SO', async () => {
    const api = makeApi({
      soSearch: [{ id: 17, name: 'S00017', state: 'cancel', countryExpenseId: 78 }],
      productMap: { 'SKU-1': 17 }
    })
    api.reviveSalesOrderToDraft = vi.fn(async () => ({ state: 'draft' }))
    api.cancelManufacturingOrdersBySaleOrderName = vi.fn(async () => ({ cancelledIds: [73, 74] }))
    api.confirmSalesOrder = vi.fn(async () => ({ confirmed: true }))
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, autoConfirm: true })
    await gw.upsert({
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.cancelManufacturingOrdersBySaleOrderName).toHaveBeenCalledWith('S00017')
    expect(api.cancelManufacturingOrdersBySaleOrderName.mock.invocationCallOrder[0])
      .toBeLessThan(api.reviveSalesOrderToDraft.mock.invocationCallOrder[0])
  })

  it('does not cancel manufacturing orders when the existing SO is not cancelled', async () => {
    const api = makeApi({
      soSearch: [{ id: 17, name: 'S00017', state: 'sale', countryExpenseId: 78 }],
      productMap: { 'SKU-1': 17 }
    })
    api.cancelManufacturingOrdersBySaleOrderName = vi.fn(async () => ({ cancelledIds: [] }))
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.cancelManufacturingOrdersBySaleOrderName).not.toHaveBeenCalled()
  })

  it('a failed manufacturing-order cancellation does not block reviving/updating the SO (soft failure, logged)', async () => {
    const api = makeApi({
      soSearch: [{ id: 17, name: 'S00017', state: 'cancel', countryExpenseId: 78 }],
      productMap: { 'SKU-1': 17 }
    })
    api.reviveSalesOrderToDraft = vi.fn(async () => ({ state: 'draft' }))
    api.cancelManufacturingOrdersBySaleOrderName = vi.fn(async () => { throw new Error('boom') })
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload, logger })
    const result = await gw.upsert({
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.reviveSalesOrderToDraft).toHaveBeenCalledWith(17)
    expect(result.targetId).toBe('17')
    expect(logger.warn).toHaveBeenCalledWith(
      'odoo.upsert.manufacturingOrder.cancel_orphans_failed',
      expect.objectContaining({ salesOrderName: 'S00017', error: 'boom' })
    )
  })
})

describe('OdooTargetGateway country_expense resolution', () => {
  it('resolves country_expense from partner country + operation.costs', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 } })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.readPartnerCountries).toHaveBeenCalledWith([42])
    expect(api.listOperationCosts).toHaveBeenCalledTimes(1)
    expect(result.metadata.countryExpense).toEqual({
      status: 'resolved',
      id: 78,
      countryId: 49,
      countryName: 'Colombia',
      reason: 'ddp_exact_match',
      matches: 1,
      ambiguous: false
    })
  })

  it('returns status unresolved when partner has no country_id', async () => {
    const api = makeApi({
      productMap: { 'SKU-1': 17 },
      partnerCountry: { 42: { countryId: null, countryName: null, parentId: null } }
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(result.metadata.countryExpense.status).toBe('unresolved')
    expect(result.metadata.countryExpense.reason).toBe('partner_has_no_country')
    expect(result.metadata.countryExpense.countryId).toBeNull()
  })

  it('walks parent_id chain to find a country', async () => {
    const api = makeApi({
      productMap: { 'SKU-1': 17 },
      partnerCountry: { 42: { countryId: null, countryName: null, parentId: 7 }, 7: { countryId: 49, countryName: 'Colombia', parentId: null } }
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(api.readPartnerCountries).toHaveBeenCalledWith([42])
    expect(api.readPartnerCountries).toHaveBeenCalledWith([7])
    expect(result.metadata.countryExpense.status).toBe('resolved')
    expect(result.metadata.countryExpense.countryId).toBe(49)
  })

  it('returns no_operation_cost_for_country when partner has country but no matching records', async () => {
    const api = makeApi({
      productMap: { 'SKU-1': 17 },
      partnerCountry: { 42: { countryId: 999, countryName: 'Atlantis', parentId: null } },
      operationCosts: [{ id: 1, name: 'DDP Colombia', countryId: 49, countryName: 'Colombia', productId: null }]
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(result.metadata.countryExpense.status).toBe('unresolved')
    expect(result.metadata.countryExpense.reason).toBe('no_operation_cost_for_country')
    expect(result.metadata.countryExpense.countryId).toBe(999)
  })

  it('falls back to lowest id when ambiguous and reports matches > 1', async () => {
    const api = makeApi({
      productMap: { 'SKU-1': 17 },
      operationCosts: [
        { id: 116, name: 'CIP Colombia', countryId: 49, countryName: 'Colombia', productId: null },
        { id: 154, name: 'EXW Colombia (con Duca)', countryId: 49, countryName: 'Colombia', productId: null }
      ]
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(result.metadata.countryExpense.status).toBe('resolved')
    expect(result.metadata.countryExpense.id).toBe(116)
    expect(result.metadata.countryExpense.ambiguous).toBe(true)
    expect(result.metadata.countryExpense.matches).toBe(2)
    expect(result.metadata.countryExpense.reason).toBe('no_ddp_exact_match')
  })

  it('degrades when readPartnerCountries throws (does not block SO create)', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 } })
    api.readPartnerCountries = vi.fn(async () => { throw new Error('partner-down') })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(result.metadata.countryExpense.status).toBe('unresolved')
    expect(result.metadata.countryExpense.reason).toBe('partner_lookup_failed')
    expect(result.salesOrderId).toBe('SO-NEW')
  })

  it('degrades when listOperationCosts throws (does not block SO create)', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 } })
    api.listOperationCosts = vi.fn(async () => { throw new Error('costs-down') })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(result.metadata.countryExpense.status).toBe('unresolved')
    expect(result.metadata.countryExpense.reason).toBe('operation_costs_lookup_failed')
    expect(result.salesOrderId).toBe('SO-NEW')
  })

  it('works without readPartnerCountries (back-compat stub api)', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 } })
    delete api.readPartnerCountries
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(result.metadata.countryExpense.status).toBe('unresolved')
    expect(result.metadata.countryExpense.reason).toBe('readPartnerCountries_not_supported')
    expect(result.salesOrderId).toBe('SO-NEW')
  })

  it('works without listOperationCosts (back-compat stub api)', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 } })
    delete api.listOperationCosts
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    const result = await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    expect(result.metadata.countryExpense.status).toBe('unresolved')
    expect(result.metadata.countryExpense.reason).toBe('listOperationCosts_not_supported')
    expect(result.salesOrderId).toBe('SO-NEW')
  })

  it('includes country_expense in create payload when resolved', async () => {
    const api = makeApi({ productMap: { 'SKU-1': 17 } })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload.country_expense).toBe(78)
  })

  it('omits country_expense from create payload when unresolved', async () => {
    const api = makeApi({
      productMap: { 'SKU-1': 17 },
      partnerCountry: { 42: { countryId: null, countryName: null, parentId: null } }
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload).not.toHaveProperty('country_expense')
  })

  it('omits country_expense from update payload when SO already has it', async () => {
    const api = makeApi({
      soSearch: [{ id: 17, name: 'S00017', state: 'draft', countryExpenseId: 78 }],
      productMap: { 'SKU-1': 17 }
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    const updatePayload = api.updateSalesOrder.mock.calls[0][1]
    expect(updatePayload).not.toHaveProperty('country_expense')
  })

  it('sends country_expense in update payload when SO has it empty', async () => {
    const api = makeApi({
      soSearch: [{ id: 17, name: 'S00017', state: 'draft', countryExpenseId: null }],
      productMap: { 'SKU-1': 17 }
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    const updatePayload = api.updateSalesOrder.mock.calls[0][1]
    expect(updatePayload.country_expense).toBe(78)
  })

  it('omits note from update payload when existing SO already has a note', async () => {
    const api = makeApi({
      soSearch: [{ id: 17, name: 'S00017', state: 'draft', countryExpenseId: 78, note: 'Existing note' }],
      productMap: { 'SKU-1': 17 }
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42', dealname: 'Cool' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    const updatePayload = api.updateSalesOrder.mock.calls[0][1]
    expect(updatePayload).not.toHaveProperty('note')
  })

  it('sends note in update payload when existing SO has no note', async () => {
    const api = makeApi({
      soSearch: [{ id: 17, name: 'S00017', state: 'draft', countryExpenseId: 78, note: null }],
      productMap: { 'SKU-1': 17 }
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42', dealname: 'Cool' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    const updatePayload = api.updateSalesOrder.mock.calls[0][1]
    expect(updatePayload.note).toBe('Deal: Cool')
  })

  it('appends [smartflow] marker to note when unresolved on create', async () => {
    const api = makeApi({
      productMap: { 'SKU-1': 17 },
      partnerCountry: { 42: { countryId: null, countryName: null, parentId: null } }
    })
    const gw = new OdooTargetGateway({ apiClient: api, hashPayload })
    await gw.upsert({
      existingTargetId: null,
      record: { id: 'D-1', properties: { id_cliente_odoo: '42', dealname: 'Cool' } },
      references: { lineItems: [{ hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'X' }] }
    })
    const soPayload = api.createSalesOrder.mock.calls[0][0]
    expect(soPayload.note).toContain('[smartflow] País no resuelto')
    expect(soPayload.note).toContain('Deal: Cool')
  })
})
