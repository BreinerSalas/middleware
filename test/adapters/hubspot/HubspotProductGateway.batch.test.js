import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { HubspotProductGateway } = require('../../../src/adapters/outbound/hubspot/HubspotProductGateway.js')

function makeApi({ batchUpsertProducts = async () => ({ results: [], errors: [], numErrors: 0 }) } = {}) {
  return {
    searchProductByHsSku: vi.fn(),
    createProduct: vi.fn(),
    updateProduct: vi.fn(),
    batchUpsertProducts: vi.fn(batchUpsertProducts)
  }
}

function product(id, sku, name = `P-${id}`, price = 10) {
  return { id, name, default_code: sku, list_price: price }
}

describe('HubspotProductGateway - batchUpsertBySkus', () => {
  it('splits input into 100-item chunks and calls apiClient.batchUpsertProducts per chunk', async () => {
    const calls = []
    const api = makeApi({
      batchUpsertProducts: vi.fn(async (args) => {
        calls.push(args.inputs.length)
        return { results: args.inputs.map((_, i) => ({ id: `P-${i}`, properties: { hs_sku: args.inputs[i].id } })), errors: [], numErrors: 0 }
      })
    })
    const gw = new HubspotProductGateway({ apiClient: api })
    const products = Array.from({ length: 250 }, (_, i) => product(i + 1, `SKU-${i + 1}`))
    const r = await gw.batchUpsertBySkus(products, { chunkSize: 100 })
    expect(calls).toEqual([100, 100, 50])
    expect(r.results).toHaveLength(250)
  })

  it('uses hs_sku as the default idProperty (passed down to apiClient)', async () => {
    const api = makeApi({
      batchUpsertProducts: vi.fn(async () => ({ results: [], errors: [], numErrors: 0 }))
    })
    const gw = new HubspotProductGateway({ apiClient: api })
    await gw.batchUpsertBySkus([product(1, 'AC-1170', 'Aceite')])
    const [arg] = api.batchUpsertProducts.mock.calls[0]
    expect(arg.idProperty).toBe('hs_sku')
    expect(arg.inputs[0].id).toBe('AC-1170')
    expect(arg.inputs[0].properties).toMatchObject({ name: 'Aceite', price: '10' })
    expect(arg.inputs[0].properties.hs_sku).toBe('AC-1170')
  })

  it('skips products without valid sku (default_code false / null / empty), reported as {sourceId, reason: no_sku}', async () => {
    const api = makeApi()
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.batchUpsertBySkus([
      product(1, 'AC-1'),
      product(2, false),
      product(3, null),
      product(4, ''),
      product(5, 'AC-5')
    ])
    expect(api.batchUpsertProducts).toHaveBeenCalledTimes(1)
    const inputs = api.batchUpsertProducts.mock.calls[0][0].inputs
    expect(inputs).toHaveLength(2)
    expect(r.skipped).toEqual([
      { sourceId: 2, reason: 'no_sku' },
      { sourceId: 3, reason: 'no_sku' },
      { sourceId: 4, reason: 'no_sku' }
    ])
  })

  it('reports duplicate-sku-within-input skips as {sourceId, reason: duplicate_sku_in_input}', async () => {
    const api = makeApi({
      batchUpsertProducts: vi.fn(async (args) => ({
        results: args.inputs.map((_, i) => ({ id: `P-${i}`, properties: { hs_sku: args.inputs[i].id } })),
        errors: [],
        numErrors: 0
      }))
    })
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.batchUpsertBySkus([
      product(1, 'DUP'),
      product(2, 'DUP'),
      product(3, 'UNIQUE')
    ])
    const inputs = api.batchUpsertProducts.mock.calls[0][0].inputs
    expect(inputs).toHaveLength(2)
    expect(r.skipped).toEqual([{ sourceId: 2, reason: 'duplicate_sku_in_input' }])
  })

  it('collects per-item errors from apiClient response into the result.errors array', async () => {
    const api = makeApi({
      batchUpsertProducts: vi.fn(async () => ({
        results: [{ id: 'P-1', properties: { hs_sku: 'AC-1' } }],
        errors: [{ id: 'AC-2', message: 'invalid value', category: 'VALIDATION_ERROR' }],
        numErrors: 1
      }))
    })
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.batchUpsertBySkus([
      product(1, 'AC-1'),
      product(2, 'AC-2', 'BadProduct')
    ])
    expect(r.results).toHaveLength(1)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatchObject({ id: 'AC-2' })
  })

  it('returns empty results and no apiClient call when input is empty', async () => {
    const api = makeApi()
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.batchUpsertBySkus([])
    expect(api.batchUpsertProducts).not.toHaveBeenCalled()
    expect(r.results).toEqual([])
  })

  it('falls back to a single-item batch call instead of propagating when the chunk call throws, and reports a genuinely unexpected error via result.errors', async () => {
    const api = makeApi({
      batchUpsertProducts: vi.fn(async () => { throw new Error('batch-boom') })
    })
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.batchUpsertBySkus([product(1, 'AC-1')])
    // 1 whole-chunk attempt + 1 single-item fallback attempt, both via batchUpsertProducts
    expect(api.batchUpsertProducts).toHaveBeenCalledTimes(2)
    expect(r.results).toHaveLength(0)
    expect(r.skipped).toHaveLength(0)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatchObject({ id: 'AC-1', message: 'batch-boom' })
  })

  it('falls back to per-item single-item batch calls for a chunk when the whole batch call throws, isolating a duplicate-in-hubspot conflict from the rest', async () => {
    const api = makeApi()
    api.batchUpsertProducts = vi.fn(async (args) => {
      if (args.inputs.length > 1) {
        const e = new Error('Cannot set PropertyValueCoordinates... AC-2 already has that value.')
        e.httpStatus = 400
        throw e
      }
      const id = args.inputs[0].id
      if (id === 'AC-2') {
        const e = new Error('Cannot set PropertyValueCoordinates... AC-2 already has that value.')
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
    const r = await gw.batchUpsertBySkus([
      product(1, 'AC-1', 'Good Product'),
      product(2, 'AC-2', 'Colliding Product')
    ])
    // 1 whole-chunk attempt + 2 single-item fallback calls, all via batchUpsertProducts
    expect(api.batchUpsertProducts).toHaveBeenCalledTimes(3)
    expect(r.results).toHaveLength(1)
    expect(r.results[0].properties.hs_sku).toBe('AC-1')
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
    const r = await gw.batchUpsertBySkus([product(1, 'AC-1', 'Bad Price Product')])
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
    const products = Array.from({ length: 25 }, (_, i) => product(i + 1, `SKU-${i + 1}`))
    const r = await gw.batchUpsertBySkus(products, { chunkSize: 100 })
    expect(maxInFlight).toBeLessThanOrEqual(10)
    expect(maxInFlight).toBeGreaterThan(1)
    expect(r.results).toHaveLength(25)
  })
})
