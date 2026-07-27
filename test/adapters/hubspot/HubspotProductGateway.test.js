import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { HubspotProductGateway } = require('../../../src/adapters/outbound/hubspot/HubspotProductGateway.js')

function makeApi({ search = async () => null, create = { id: 'NEW', properties: {} }, update = { id: 'EXIST', properties: {} } } = {}) {
  return {
    searchProductByHsSku: vi.fn(search),
    createProduct: vi.fn(async () => create),
    updateProduct: vi.fn(async () => update)
  }
}

describe('HubspotProductGateway', () => {
  it('buildProperties maps fields for create payload', () => {
    const api = makeApi()
    const gw = new HubspotProductGateway({ apiClient: api })
    const props = gw.buildProperties({ id: 7, name: 'Aceite', default_code: 'AC-1170', list_price: 12.5 })
    expect(props).toEqual({ hs_sku: 'AC-1170', name: 'Aceite', price: '12.5' })
  })

  it('buildProperties coerces missing list_price to 0 string', () => {
    const api = makeApi()
    const gw = new HubspotProductGateway({ apiClient: api })
    const props = gw.buildProperties({ id: 7, name: 'X', default_code: 'X', list_price: null })
    expect(props.price).toBe('0')
  })

  it('buildProperties omits hs_sku when default_code is false (Odoo no-SKU marker)', () => {
    const api = makeApi()
    const gw = new HubspotProductGateway({ apiClient: api })
    const props = gw.buildProperties({ id: 7, name: 'X', default_code: false, list_price: 10 })
    expect(props).not.toHaveProperty('hs_sku')
    expect(props.name).toBe('X')
    expect(props.price).toBe('10')
  })

  it('buildProperties omits hs_sku when default_code is empty string', () => {
    const api = makeApi()
    const gw = new HubspotProductGateway({ apiClient: api })
    const props = gw.buildProperties({ id: 7, name: 'Y', default_code: '', list_price: 10 })
    expect(props).not.toHaveProperty('hs_sku')
  })

  it('upsertBySku without default_code goes straight to create (no search)', async () => {
    const api = makeApi()
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.upsertBySku({ id: 7, name: 'NoSku', default_code: false, list_price: 10 })
    expect(api.searchProductByHsSku).not.toHaveBeenCalled()
    expect(api.createProduct).toHaveBeenCalledTimes(1)
    const props = api.createProduct.mock.calls[0][0]
    expect(props).not.toHaveProperty('hs_sku')
    expect(props.name).toBe('NoSku')
    expect(r.created).toBe(true)
  })

  it('upsertBySku skips both search and create when name is missing (no usable record)', async () => {
    const api = makeApi()
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.upsertBySku({ id: 7, name: '', default_code: false, list_price: 10 })
    expect(r.skipped).toBe(true)
    expect(api.searchProductByHsSku).not.toHaveBeenCalled()
    expect(api.createProduct).not.toHaveBeenCalled()
  })

  it('creates when search returns null', async () => {
    const api = makeApi({ search: async () => null })
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.upsertBySku({ id: 7, name: 'X', default_code: '1170', list_price: 9.99 })
    expect(api.searchProductByHsSku).toHaveBeenCalledWith('1170')
    expect(api.createProduct).toHaveBeenCalledTimes(1)
    expect(api.updateProduct).not.toHaveBeenCalled()
    expect(r.created).toBe(true)
    expect(r.id).toBe('NEW')
  })

  it('updates when search returns existing', async () => {
    const api = makeApi({ search: async () => ({ id: 'P-1', properties: {} }) })
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.upsertBySku({ id: 7, name: 'X', default_code: '1170', list_price: 9.99 })
    expect(api.createProduct).not.toHaveBeenCalled()
    expect(api.updateProduct).toHaveBeenCalledTimes(1)
    expect(api.updateProduct.mock.calls[0][0]).toBe('P-1')
    expect(r.created).toBe(false)
    expect(r.id).toBe('EXIST')
  })

  it('maps default_code→hs_sku, name→name, list_price→price', async () => {
    const api = makeApi()
    const gw = new HubspotProductGateway({ apiClient: api })
    await gw.upsertBySku({ id: 7, name: 'Aceite', default_code: 'AC-1170', list_price: 12.5 })
    const props = api.createProduct.mock.calls[0][0]
    expect(props).toEqual({ hs_sku: 'AC-1170', name: 'Aceite', price: '12.5' })
  })

  it('upsertBySku with empty-string sku goes straight to create (no search)', async () => {
    const api = makeApi()
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.upsertBySku({ id: 7, name: 'X', default_code: '', list_price: 9.99 })
    expect(api.searchProductByHsSku).not.toHaveBeenCalled()
    expect(api.createProduct).toHaveBeenCalledTimes(1)
    const props = api.createProduct.mock.calls[0][0]
    expect(props).not.toHaveProperty('hs_sku')
    expect(r.created).toBe(true)
  })

  it('upsertBySku with null sku (no field at all) goes straight to create', async () => {
    const api = makeApi()
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.upsertBySku({ id: 7, name: 'X', default_code: null, list_price: 9.99 })
    expect(api.searchProductByHsSku).not.toHaveBeenCalled()
    expect(api.createProduct).toHaveBeenCalledTimes(1)
    expect(r.created).toBe(true)
  })

  it('upsertBySku skips when name is missing (no usable record)', async () => {
    const api = makeApi()
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.upsertBySku({ id: 7, name: '', default_code: 'X', list_price: 0 })
    expect(r.skipped).toBe(true)
    expect(api.searchProductByHsSku).not.toHaveBeenCalled()
    expect(api.createProduct).not.toHaveBeenCalled()
  })

  it('upsertBySku skips when name is missing and sku is false (both bad)', async () => {
    const api = makeApi()
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.upsertBySku({ id: 7, name: '', default_code: false, list_price: 0 })
    expect(r.skipped).toBe(true)
    expect(api.searchProductByHsSku).not.toHaveBeenCalled()
    expect(api.createProduct).not.toHaveBeenCalled()
  })

  it('create 400 with "already has that value" is treated as skipped (duplicate)', async () => {
    const api = makeApi()
    api.searchProductByHsSku = vi.fn(async () => { throw new Error('429') })
    api.createProduct = vi.fn(async () => {
      const e = new Error('Cannot set PropertyValueCoordinates... 46609204878 already has that value.')
      e.httpStatus = 400
      throw e
    })
    const logger = { warn: vi.fn() }
    const gw = new HubspotProductGateway({ apiClient: api, logger })
    const r = await gw.upsertBySku({ id: 7, name: 'X', default_code: 'EC231035-0', list_price: 10 })
    expect(r.skipped).toBe(true)
    expect(r.reason).toMatch(/duplicate/)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('swallows search errors and falls back to create (safe-but-noisy)', async () => {
    const api = makeApi({
      search: async () => { throw new Error('search-down') },
      create: { id: 'NEW', properties: {} }
    })
    const gw = new HubspotProductGateway({ apiClient: api })
    const r = await gw.upsertBySku({ id: 7, name: 'X', default_code: '1170', list_price: 9.99 })
    expect(api.createProduct).toHaveBeenCalledTimes(1)
    expect(r.created).toBe(true)
  })
})
