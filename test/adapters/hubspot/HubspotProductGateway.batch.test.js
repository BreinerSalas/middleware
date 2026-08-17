import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { HubspotProductGateway } = require('../../../src/adapters/outbound/hubspot/HubspotProductGateway.js')

function makeApi({ batchUpsertProducts = async () => ({ results: [], errors: [], numErrors: 0 }) } = {}) {
  return {
    searchProductByOdooId: vi.fn(),
    createProduct: vi.fn(),
    updateProduct: vi.fn(),
    batchUpsertProducts: vi.fn(batchUpsertProducts)
  }
}

function product(id, name = `P-${id}`, defaultCode = `SKU-${id}`, price = 10) {
  return { id, name, default_code: defaultCode, list_price: price }
}

describe('HubspotProductGateway - batchUpsertByOdooIds (openspec/hubspot-product-odoo-id-key)', () => {
  it('splits input into 100-item chunks and calls apiClient.batchUpsertProducts per chunk', async () => {
    const calls = []
    const api = makeApi({
      batchUpsertProducts: vi.fn(async (args) => {
        calls.push(args.inputs.length)
        return { results: args.inputs.map((_, i) => ({ id: `P-${i}`, properties: { id_producto_odoo: args.inputs[i].id } })), errors: [], numErrors: 0 }
      })
    })
    const gw = new HubspotProductGateway({ apiClient: api })
    const products = Array.from({ length: 250 }, (_, i) => product(i + 1))
    const r = await gw.batchUpsertByOdooIds(products, { chunkSize: 100 })
    expect(calls).toEqual([100, 100, 50])
    expect(r.results).toHaveLength(250)
  })

  it('uses id_producto_odoo as the default idProperty and Odoo id as the input id', async () => {
    const api = makeApi({
      batchUpsertProducts: vi.fn(async () => ({ results: [], errors: [], numErrors: 0 }))
    })
    const gw = new HubspotProductGateway({ apiClient: api })
    await gw.batchUpsertByOdooIds([product(1, 'Aceite', 'AC-1170')])
    const [arg] = api.batchUpsertProducts.mock.calls[0]
    expect(arg.idProperty).toBe('id_producto_odoo')
    expect(arg.inputs[0].id).toBe('1')
    expect(arg.inputs[0].properties.id_producto_odoo).toBe('1')
    expect(arg.inputs[0].properties.name).toBe('Aceite')
    expect(arg.inputs[0].properties.hs_sku).toBe('AC-1170')
  })

  it('does NOT partition by SKU — products with or without default_code are all included', async () => {
    const api = makeApi()
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.batchUpsertByOdooIds([
      product(1, 'P1', 'AC-1'),
      product(2, 'P2', false),
      product(3, 'P3', null),
      product(4, 'P4', ''),
      product(5, 'P5', 'AC-5')
    ])
    expect(api.batchUpsertProducts).toHaveBeenCalledTimes(1)
    const inputs = api.batchUpsertProducts.mock.calls[0][0].inputs
    expect(inputs).toHaveLength(5)
    // hs_sku only present where default_code is real
    expect(inputs[0].properties.hs_sku).toBe('AC-1')
    expect(inputs[1].properties.hs_sku).toBeUndefined()
    expect(inputs[2].properties.hs_sku).toBeUndefined()
    expect(inputs[3].properties.hs_sku).toBeUndefined()
    expect(inputs[4].properties.hs_sku).toBe('AC-5')
    // id_producto_odoo always present
    inputs.forEach((it, i) => expect(it.properties.id_producto_odoo).toBe(String(i + 1)))
    // No no_sku / duplicate_sku_in_input skip entries
    expect(r.skipped).toEqual([])
  })

  it('does NOT emit duplicate_sku_in_input skips — Odoo ids are unique by construction', async () => {
    const api = makeApi({
      batchUpsertProducts: vi.fn(async (args) => ({
        results: args.inputs.map((_, i) => ({ id: `P-${i}`, properties: { id_producto_odoo: args.inputs[i].id } })),
        errors: [],
        numErrors: 0
      }))
    })
    const gw = new HubspotProductGateway({ apiClient: api })
    // Same default_code (sku) on different Odoo ids MUST all be upserted, not deduped.
    const r = await gw.batchUpsertByOdooIds([
      product(1, 'P1', 'DUP'),
      product(2, 'P2', 'DUP'),
      product(3, 'P3', 'UNIQUE')
    ])
    const inputs = api.batchUpsertProducts.mock.calls[0][0].inputs
    expect(inputs).toHaveLength(3)
    expect(r.skipped).toEqual([])
  })

  it('skips products without a valid Odoo id as {sourceId, reason: no_id}', async () => {
    const api = makeApi()
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.batchUpsertByOdooIds([
      product(1, 'P1', 'AC-1'),
      { id: null, name: 'P2', default_code: 'X', list_price: 1 },
      { name: 'P3', default_code: 'X', list_price: 1 }
    ])
    expect(api.batchUpsertProducts).toHaveBeenCalledTimes(1)
    const inputs = api.batchUpsertProducts.mock.calls[0][0].inputs
    expect(inputs).toHaveLength(1)
    expect(r.skipped).toEqual([
      { sourceId: null, reason: 'no_id' },
      { sourceId: null, reason: 'no_id' }
    ])
  })

  it('collects per-item errors from apiClient response into the result.errors array', async () => {
    const api = makeApi({
      batchUpsertProducts: vi.fn(async () => ({
        results: [{ id: 'P-1', properties: { id_producto_odoo: '1' } }],
        errors: [{ id: '2', message: 'invalid value', category: 'VALIDATION_ERROR' }],
        numErrors: 1
      }))
    })
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.batchUpsertByOdooIds([product(1, 'P1'), product(2, 'P2', 'AC-2')])
    expect(r.results).toHaveLength(1)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatchObject({ id: '2' })
  })

  it('returns empty results and no apiClient call when input is empty', async () => {
    const api = makeApi()
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.batchUpsertByOdooIds([])
    expect(api.batchUpsertProducts).not.toHaveBeenCalled()
    expect(r.results).toEqual([])
  })

  it('falls back to single-item batch when whole-chunk throws, isolates duplicate-in-hubspot from rest', async () => {
    const api = makeApi()
    api.batchUpsertProducts = vi.fn(async (args) => {
      if (args.inputs.length > 1) {
        const e = new Error('Cannot set PropertyValueCoordinates... 2 already has that value.')
        e.httpStatus = 400
        throw e
      }
      const id = args.inputs[0].id
      if (id === '2') {
        const e = new Error('Cannot set PropertyValueCoordinates... 2 already has that value.')
        e.httpStatus = 400
        throw e
      }
      return {
        results: [{ id: `NEW-${id}`, properties: args.inputs[0].properties, new: true }],
        errors: [],
        numErrors: 0
      }
    })
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.batchUpsertByOdooIds([
      product(1, 'Good Product', 'AC-1'),
      product(2, 'Colliding Product', 'AC-2')
    ])
    expect(api.batchUpsertProducts).toHaveBeenCalledTimes(3)
    expect(r.results).toHaveLength(1)
    expect(r.results[0].properties.id_producto_odoo).toBe('1')
    expect(r.errors).toHaveLength(0)
    expect(r.skipped).toEqual([{ sourceId: 2, reason: 'duplicate_in_hubspot' }])
  })

  it('classifies VALIDATION_ERROR / "Property values were not valid" single-item fallback failures as skipped: invalid_property_value (not failed)', async () => {
    const api = makeApi()
    api.batchUpsertProducts = vi.fn(async (args) => {
      if (args.inputs.length > 1) throw new Error('batch-boom')
      const e = new Error(
        'Property values were not valid: [{"isValid":false,"message":"Price -5 is invalid","error":"INVALID_PRICE","name":"price"}]'
      )
      e.httpStatus = 400
      e.original = { response: { data: { category: 'VALIDATION_ERROR', message: e.message } } }
      throw e
    })
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.batchUpsertByOdooIds([product(1, 'Bad Price Product', 'AC-1')])
    expect(r.errors).toHaveLength(0)
    expect(r.results).toHaveLength(0)
    expect(r.skipped).toEqual([{ sourceId: 1, reason: 'invalid_property_value' }])
  })

  it('runs the chunk fallback with bounded concurrency (never more than 10 in flight)', async () => {
    const api = makeApi()
    let inFlight = 0
    let maxInFlight = 0
    api.batchUpsertProducts = vi.fn(async (args) => {
      if (args.inputs.length > 1) throw new Error('batch-boom')
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      const id = args.inputs[0].id
      return { results: [{ id: `NEW-${id}`, properties: args.inputs[0].properties, new: true }], errors: [], numErrors: 0 }
    })
    const gw = new HubspotProductGateway({ apiClient: api })
    const products = Array.from({ length: 25 }, (_, i) => product(i + 1))
    const r = await gw.batchUpsertByOdooIds(products, { chunkSize: 100 })
    expect(maxInFlight).toBeLessThanOrEqual(10)
    expect(maxInFlight).toBeGreaterThan(1)
    expect(r.results).toHaveLength(25)
  })
})
