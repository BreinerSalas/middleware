import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createOdooApiClient } = require('../../../src/adapters/outbound/odoo/odooApiClient.js')

describe('odooApiClient', () => {
  it('stub mode returns deterministic ids', async () => {
    const api = createOdooApiClient({ mode: 'stub' })
    const a = await api.createManufacturingOrder({ x: 1 })
    const b = await api.createManufacturingOrder({ x: 2 })
    expect(a.id).toBe('stub-mrp-1')
    expect(b.id).toBe('stub-mrp-2')
  })

  it('stub mode updateManufacturingOrder echoes targetId', async () => {
    const api = createOdooApiClient({ mode: 'stub' })
    const a = await api.createManufacturingOrder({ x: 1 })
    const u = await api.updateManufacturingOrder(a.id, { y: 2 })
    expect(u.id).toBe(a.id)
  })

  it('http mode requires baseUrl', () => {
    expect(() =>
      createOdooApiClient({ mode: 'http', db: 'd', login: 'l@x.com', apiKey: 'k' })
    ).toThrow(/ODOO_BASE_URL/)
  })

  it('http mode requires db', () => {
    expect(() =>
      createOdooApiClient({ mode: 'http', baseUrl: 'https://odoo.example.com', login: 'l@x.com', apiKey: 'k' })
    ).toThrow(/ODOO_DB/)
  })

  it('http mode requires login', () => {
    expect(() =>
      createOdooApiClient({ mode: 'http', baseUrl: 'https://odoo.example.com', db: 'db', apiKey: 'k' })
    ).toThrow(/ODOO_LOGIN/)
  })

  it('http mode requires apiKey', () => {
    expect(() =>
      createOdooApiClient({ mode: 'http', baseUrl: 'https://odoo.example.com', db: 'db', login: 'l@x.com' })
    ).toThrow(/ODOO_API_KEY/)
  })

  it('throws on unsupported mode', () => {
    expect(() =>
      createOdooApiClient({ mode: 'grpc', baseUrl: 'https://x', db: 'd', login: 'l@x.com', apiKey: 'k' })
    ).toThrow(/Unsupported ODOO_CLIENT_MODE/)
  })

  it('http mode error aggregates all missing required vars in a single message', () => {
    let err
    try {
      createOdooApiClient({ mode: 'http' })
    } catch (e) { err = e }
    expect(err).toBeDefined()
    expect(err.message).toMatch(/ODOO_BASE_URL/)
    expect(err.message).toMatch(/ODOO_DB/)
    expect(err.message).toMatch(/ODOO_LOGIN/)
    expect(err.message).toMatch(/ODOO_API_KEY/)
  })

  it('http mode error only lists vars that are actually missing', () => {
    let err
    try {
      createOdooApiClient({ mode: 'http', baseUrl: 'https://x', apiKey: 'k' })
    } catch (e) { err = e }
    expect(err).toBeDefined()
    expect(err.message).toMatch(/ODOO_DB/)
    expect(err.message).toMatch(/ODOO_LOGIN/)
    expect(err.message).not.toMatch(/ODOO_BASE_URL/)
    expect(err.message).not.toMatch(/ODOO_API_KEY/)
  })

  it('http mode authenticates then calls execute_kw create', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: 99 }, status: 200 })
    const api = createOdooApiClient({
      mode: 'http',
      baseUrl: 'https://odoo.example.com',
      db: 'test-db',
      login: 'test@x.com',
      apiKey: 'k',
      transport: { post }
    })
    const r = await api.createManufacturingOrder({ partner_id: 1 })
    expect(r.id).toBe('99')
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[0][1].params).toMatchObject({
      service: 'common',
      method: 'authenticate',
      args: ['test-db', 'test@x.com', 'k', {}]
    })
    expect(post.mock.calls[1][1].params).toMatchObject({
      service: 'object',
      method: 'execute_kw',
      args: ['test-db', 2, 'k', 'mrp.production', 'create', [{ partner_id: 1 }], {}]
    })
  })

  it('http mode updateManufacturingOrder uses execute_kw write with numeric target id', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 7 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: true }, status: 200 })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    const r = await api.updateManufacturingOrder(42, { state: 'confirmed' })
    expect(r.id).toBe('42')
    expect(post.mock.calls[1][1].params.args).toEqual([
      'db', 7, 'k', 'mrp.production', 'write', [[42], { state: 'confirmed' }], {}
    ])
  })

  it('http mode throws ODOO_AUTH_FAILED when authenticate returns false', async () => {
    const post = vi.fn().mockResolvedValue({ data: { result: false }, status: 200 })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    await expect(api.createManufacturingOrder({})).rejects.toMatchObject({
      code: 'ODOO_AUTH_FAILED'
    })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('http mode authenticates only once and reuses uid across calls', async () => {
    const post = vi.fn(async () => ({ data: { result: 5 }, status: 200 }))
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    await api.createManufacturingOrder({ a: 1 })
    await api.createManufacturingOrder({ a: 2 })
    await api.updateManufacturingOrder(99, { b: 3 })
    expect(post).toHaveBeenCalledTimes(4)
    const authCalls = post.mock.calls.filter(([, body]) => body.params.method === 'authenticate')
    expect(authCalls).toHaveLength(1)
    for (const c of post.mock.calls.slice(1)) {
      expect(c[1].params.args[1]).toBe(5)
    }
  })

  it('http mode propagates execute_kw RPC error', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({ data: { error: { code: 200, data: { message: 'Validation error' } } }, status: 200 })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    await expect(api.createManufacturingOrder({})).rejects.toThrow(/Validation error/)
  })

  it('http mode createSalesOrder uses execute_kw on sale.order.create', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: 17 }, status: 200 })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    const r = await api.createSalesOrder({ partner_id: 7, order_line: [] })
    expect(r.id).toBe('17')
    expect(post.mock.calls[1][1].params.args).toEqual([
      'db', 2, 'k', 'sale.order', 'create', [{ partner_id: 7, order_line: [] }], {}
    ])
  })

  it('http mode updateSalesOrder uses execute_kw on sale.order.write', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 3 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: true }, status: 200 })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    await api.updateSalesOrder(17, { note: 'updated' })
    expect(post.mock.calls[1][1].params.args).toEqual([
      'db', 3, 'k', 'sale.order', 'write', [[17], { note: 'updated' }], {}
    ])
  })

  it('http mode searchSalesOrderByOrigin uses execute_kw on sale.order.search', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 4 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: [17, 18] }, status: 200 })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    const r = await api.searchSalesOrderByOrigin('hs:62939072525')
    expect(r).toEqual([17, 18])
    expect(post.mock.calls[1][1].params.args).toEqual([
      'db', 4, 'k', 'sale.order', 'search',
      [[['origin', '=', 'hs:62939072525']]], {}
    ])
  })

  it('stub mode createSalesOrder returns deterministic ids', async () => {
    const api = createOdooApiClient({ mode: 'stub' })
    const a = await api.createSalesOrder({ partner_id: 1 })
    const b = await api.createSalesOrder({ partner_id: 2 })
    expect(a.id).toBe('stub-so-1')
    expect(b.id).toBe('stub-so-2')
  })

  it('http mode searchProductIdsByDefaultCodes returns map of code->{id,uomId}', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({
        data: {
          result: [
            { id: 17, default_code: '4001/2905U', uom_id: [1, 'Units'] },
            { id: 18, default_code: 'SKU-2', uom_id: [2, 'kg'] }
          ]
        },
        status: 200
      })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    const r = await api.searchProductIdsByDefaultCodes(['4001/2905U', 'SKU-2', 'UNKNOWN'])
    expect(r).toEqual({
      '4001/2905U': { id: 17, uomId: 1 },
      'SKU-2': { id: 18, uomId: 2 }
    })
    expect(post.mock.calls[1][1].params.args).toEqual([
      'db', 2, 'k', 'product.product', 'search_read',
      [[['default_code', 'in', ['4001/2905U', 'SKU-2', 'UNKNOWN']]]],
      { fields: ['id', 'default_code', 'uom_id'] }
    ])
  })

  it('http mode searchProductIdsByDefaultCodes returns empty map for empty input', async () => {
    const post = vi.fn()
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    const r = await api.searchProductIdsByDefaultCodes([])
    expect(r).toEqual({})
    expect(post).not.toHaveBeenCalled()
  })

  it('stub mode searchProductIdsByDefaultCodes returns empty map', async () => {
    const api = createOdooApiClient({ mode: 'stub' })
    const r = await api.searchProductIdsByDefaultCodes(['ANY'])
    expect(r).toEqual({})
  })

  it('http mode default transport does not send Authorization header', async () => {
    const axios = require('axios')
    const captured = []
    const spy = vi.spyOn(axios, 'post').mockImplementation(async (url, body, opts) => {
      captured.push({ url, headers: opts && opts.headers })
      if (body && body.params && body.params.method === 'authenticate') {
        return { data: { result: 2 }, status: 200 }
      }
      return { data: { result: 1 }, status: 200 }
    })
    try {
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'super-secret-key-should-not-leak'
      })
      await api.createManufacturingOrder({ product_id: 1 })
    } finally {
      spy.mockRestore()
    }
    expect(captured.length).toBeGreaterThan(0)
    for (const call of captured) {
      expect(call.headers).not.toHaveProperty('Authorization')
      expect(call.headers).not.toHaveProperty('authorization')
    }
  })
})
