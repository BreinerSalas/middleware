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

  it('http mode createSalesOrder uses execute_kw on sale.order.create and reads the name back', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: 17 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: [{ id: 17, name: 'S06613', state: 'draft' }] }, status: 200 })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    const r = await api.createSalesOrder({ partner_id: 7, order_line: [] })
    expect(r.id).toBe('17')
    expect(r.ref).toBe('S06613')
    expect(r.state).toBe('draft')
    expect(post).toHaveBeenCalledTimes(3)
    expect(post.mock.calls[1][1].params.args).toEqual([
      'db', 2, 'k', 'sale.order', 'create', [{ partner_id: 7, order_line: [] }], {}
    ])
    expect(post.mock.calls[2][1].params.args).toEqual([
      'db', 2, 'k', 'sale.order', 'read', [[17]], { fields: ['name', 'state'] }
    ])
  })

  it('http mode createSalesOrder surfaces the read-after-create error', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: 17 }, status: 200 })
      .mockResolvedValueOnce({ data: { error: { code: 200, data: { message: 'read failed' } } }, status: 200 })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
    })
    await expect(api.createSalesOrder({})).rejects.toThrow(/read failed/)
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

  it('http mode searchSalesOrderByOrigin uses execute_kw on sale.order.search_read', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 4 }, status: 200 })
      .mockResolvedValueOnce({
        data: {
          result: [
            { id: 17, name: 'S06613', state: 'draft', country_expense: [78, 'DDP Colombia'] },
            { id: 18, name: 'S06614', state: 'draft', country_expense: false }
          ]
        },
        status: 200
      })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    const r = await api.searchSalesOrderByOrigin('hs:62939072525')
    expect(r).toEqual([
      { id: 17, name: 'S06613', state: 'draft', countryExpenseId: 78 },
      { id: 18, name: 'S06614', state: 'draft', countryExpenseId: null }
    ])
    expect(post.mock.calls[1][1].params.args).toEqual([
      'db', 4, 'k', 'sale.order', 'search_read',
      [[['origin', '=', 'hs:62939072525']]],
      { fields: ['id', 'name', 'state', 'country_expense'] }
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

  it('http mode readProductUoms returns map of productId->uomId', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({
        data: {
          result: [
            { id: 17, uom_id: [1, 'Units'] },
            { id: 18, uom_id: [2, 'kg'] }
          ]
        },
        status: 200
      })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    const r = await api.readProductUoms([17, 18])
    expect(r).toEqual({ 17: 1, 18: 2 })
    expect(post.mock.calls[1][1].params.args).toEqual([
      'db', 2, 'k', 'product.product', 'read',
      [[17, 18]],
      { fields: ['id', 'uom_id'] }
    ])
  })

  it('http mode readProductUoms skips products with no uom_id', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({
        data: { result: [{ id: 17, uom_id: false }, { id: 18, uom_id: [2, 'kg'] }] },
        status: 200
      })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    const r = await api.readProductUoms([17, 18])
    expect(r).toEqual({ 18: 2 })
  })

  it('http mode readProductUoms returns empty map for empty or non-numeric input', async () => {
    const post = vi.fn()
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    expect(await api.readProductUoms([])).toEqual({})
    expect(await api.readProductUoms(['not-a-number'])).toEqual({})
    expect(post).not.toHaveBeenCalled()
  })

  it('stub mode readProductUoms returns empty map', async () => {
    const api = createOdooApiClient({ mode: 'stub' })
    const r = await api.readProductUoms([1])
    expect(r).toEqual({})
  })

  it('http mode searchProductIdsByNames builds an OR domain of =ilike terms', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({
        data: {
          result: [
            { id: 17, name: 'CLIPSTRIPS P&G', uom_id: [1, 'und'] },
            { id: 18, name: 'OTRA COSA', uom_id: [2, 'kg'] }
          ]
        },
        status: 200
      })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    const r = await api.searchProductIdsByNames(['CLIPSTRIPS P&G', 'Otra Cosa'])
    expect(r).toEqual({
      'clipstrips p&g': { id: 17, uomId: 1, matches: 1, ids: [17] },
      'otra cosa': { id: 18, uomId: 2, matches: 1, ids: [18] }
    })
    expect(post.mock.calls[1][1].params.args).toEqual([
      'db', 2, 'k', 'product.product', 'search_read',
      [['|', ['name', '=ilike', 'clipstrips p&g'], ['name', '=ilike', 'otra cosa']]],
      { fields: ['id', 'name', 'uom_id'] }
    ])
  })

  it('http mode searchProductIdsByNames uses no OR operator for a single name', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: [] }, status: 200 })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    await api.searchProductIdsByNames(['Solo Uno'])
    expect(post.mock.calls[1][1].params.args[5]).toEqual([[['name', '=ilike', 'solo uno']]])
  })

  it('http mode searchProductIdsByNames reports ambiguity instead of picking one', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({
        data: {
          result: [
            { id: 18442, name: 'DUP', uom_id: [1, 'und'] },
            { id: 18999, name: 'dup', uom_id: [1, 'und'] }
          ]
        },
        status: 200
      })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    const r = await api.searchProductIdsByNames(['DUP'])
    expect(r.dup).toEqual({ id: 18442, uomId: 1, matches: 2, ids: [18442, 18999] })
  })

  it('http mode searchProductIdsByNames matches across case and whitespace drift', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: [{ id: 7, name: 'FOO BAR', uom_id: [1, 'und'] }] }, status: 200 })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    const r = await api.searchProductIdsByNames(['  Foo   Bar '])
    expect(r['foo bar'].id).toBe(7)
  })

  it('http mode searchProductIdsByNames deduplicates and skips the RPC for empty input', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: [] }, status: 200 })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k',
      transport: { post }
    })
    expect(await api.searchProductIdsByNames([])).toEqual({})
    expect(await api.searchProductIdsByNames(['  ', null])).toEqual({})
    expect(post).not.toHaveBeenCalled()
    await api.searchProductIdsByNames(['Uno', 'uno', '  UNO  '])
    expect(post.mock.calls[1][1].params.args[5]).toEqual([[['name', '=ilike', 'uno']]])
  })

  it('stub mode searchProductIdsByNames returns empty map', async () => {
    const api = createOdooApiClient({ mode: 'stub' })
    expect(await api.searchProductIdsByNames(['ANY'])).toEqual({})
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

describe('readPartnerCountries', () => {
  it('http mode reads partners and maps country_id and parent_id', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({
        data: {
          result: [
            { id: 10, country_id: [10, 'Argentina'], parent_id: false },
            { id: 11, country_id: [49, 'Colombia'], parent_id: [7, 'Padre SA'] }
          ]
        },
        status: 200
      })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
    })
    const r = await api.readPartnerCountries([10, 11])
    expect(r).toEqual({
      10: { countryId: 10, countryName: 'Argentina', parentId: null },
      11: { countryId: 49, countryName: 'Colombia', parentId: 7 }
    })
    expect(post.mock.calls[1][1].params.args).toEqual([
      'db', 2, 'k', 'res.partner', 'read', [[10, 11]], { fields: ['id', 'country_id', 'parent_id'] }
    ])
  })

  it('http mode returns empty map for empty or non-numeric input without RPC', async () => {
    const post = vi.fn()
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
    })
    expect(await api.readPartnerCountries([])).toEqual({})
    expect(await api.readPartnerCountries(['not-a-number', null])).toEqual({})
    expect(post).not.toHaveBeenCalled()
  })

  it('stub mode returns empty map', async () => {
    const api = createOdooApiClient({ mode: 'stub' })
    expect(await api.readPartnerCountries([10])).toEqual({})
  })
})

describe('listOperationCosts', () => {
  it('http mode search_reads operation.costs and maps the result shape', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({
        data: {
          result: [
            { id: 71, name: 'DDP Mexico', country_id: [156, 'Mexico'], product_id: false },
            { id: 116, name: 'CIP Mexico', country_id: [156, 'Mexico'], product_id: false }
          ]
        },
        status: 200
      })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
    })
    const r = await api.listOperationCosts()
    expect(r).toEqual([
      { id: 71, name: 'DDP Mexico', countryId: 156, countryName: 'Mexico', productId: null },
      { id: 116, name: 'CIP Mexico', countryId: 156, countryName: 'Mexico', productId: null }
    ])
    expect(post.mock.calls[1][1].params.args).toEqual([
      'db', 2, 'k', 'operation.costs', 'search_read', [[]],
      { fields: ['id', 'name', 'country_id', 'product_id'] }
    ])
  })

  it('stub mode returns empty array', async () => {
    const api = createOdooApiClient({ mode: 'stub' })
    expect(await api.listOperationCosts()).toEqual([])
  })
})

describe('listOperationCosts memoization + TTL', () => {
  it('two concurrent calls share a single RPC (one auth + one search_read)', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({
        data: { result: [{ id: 71, name: 'DDP Mexico', country_id: [156, 'Mexico'], product_id: false }] },
        status: 200
      })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
    })
    const [a, b] = await Promise.all([api.listOperationCosts(), api.listOperationCosts()])
    expect(a).toEqual(b)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('caches within TTL and refetches after expiry', async () => {
    let nowMs = 1000
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({
        data: { result: [{ id: 71, name: 'A', country_id: [1, 'X'], product_id: false }] },
        status: 200
      })
      .mockResolvedValueOnce({
        data: { result: [{ id: 72, name: 'B', country_id: [1, 'X'], product_id: false }] },
        status: 200
      })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post },
      operationCostsTtlMs: 100,
      now: () => nowMs
    })
    const r1 = await api.listOperationCosts()
    expect(r1[0].id).toBe(71)
    nowMs = 1099
    const r2 = await api.listOperationCosts()
    expect(r2[0].id).toBe(71)
    expect(post).toHaveBeenCalledTimes(2)
    nowMs = 1101
    const r3 = await api.listOperationCosts()
    expect(r3[0].id).toBe(72)
    expect(post).toHaveBeenCalledTimes(3)
  })

  it('refetches immediately after a failed call (no stale error cached)', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({
        data: { result: [{ id: 71, name: 'A', country_id: [1, 'X'], product_id: false }] },
        status: 200
      })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post },
      operationCostsTtlMs: 60000
    })
    await expect(api.listOperationCosts()).rejects.toThrow(/network/)
    const r = await api.listOperationCosts()
    expect(r[0].id).toBe(71)
  })

  it('stub mode readProductImage returns null', async () => {
    const api = createOdooApiClient({ mode: 'stub' })
    expect(await api.readProductImage(123)).toBeNull()
  })

  it('stub mode searchProductIdsWithImage returns an empty array', async () => {
    const api = createOdooApiClient({ mode: 'stub' })
    expect(await api.searchProductIdsWithImage()).toEqual([])
  })

  it('http mode readProductImage reads image_512 + write_date via product.product.read', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: [{ image_512: 'ZmFrZWJ5dGVz', write_date: '2026-08-05 10:00:00' }] }, status: 200 })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
    })
    const r = await api.readProductImage(16488)
    expect(r).toEqual({ base64: 'ZmFrZWJ5dGVz', writeDate: '2026-08-05 10:00:00' })
    expect(post.mock.calls[1][1].params.args).toEqual([
      'db', 2, 'k', 'product.product', 'read', [[16488]], { fields: ['image_512', 'write_date'] }
    ])
  })

  it('http mode readProductImage returns null when the product has no image', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: [{ image_512: false, write_date: '2026-08-05 10:00:00' }] }, status: 200 })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
    })
    expect(await api.readProductImage(16488)).toBeNull()
  })

  it('http mode readProductImage returns null when the record does not exist', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: [] }, status: 200 })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
    })
    expect(await api.readProductImage(999999)).toBeNull()
  })

  it('http mode searchProductIdsWithImage traverses product_tmpl_id.image_1920 (stored field), not the computed variant field', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: [16488, 17989, 19602] }, status: 200 })
    const api = createOdooApiClient({
      mode: 'http', baseUrl: 'https://odoo.example.com',
      db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
    })
    const ids = await api.searchProductIdsWithImage()
    expect(ids).toEqual([16488, 17989, 19602])
    expect(post.mock.calls[1][1].params.args).toEqual([
      'db', 2, 'k', 'product.product', 'search', [[['product_tmpl_id.image_1920', '!=', false]]], {}
    ])
  })

  describe('confirmSalesOrder (Fase 4 — docs/plan-cambios-2026-08-05.md auto-confirm)', () => {
    it('stub mode returns confirmed:true', async () => {
      const api = createOdooApiClient({ mode: 'stub' })
      expect(await api.confirmSalesOrder('17')).toEqual({ confirmed: true })
    })

    it('http mode calls action_confirm on the sale.order', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce({ data: { result: true }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
      })
      const r = await api.confirmSalesOrder('17')
      expect(r).toEqual({ confirmed: true })
      expect(post.mock.calls[1][1].params.args).toEqual([
        'db', 2, 'k', 'sale.order', 'action_confirm', [[17]], {}
      ])
    })

    it('http mode propagates a business rejection (e.g. UserError) as an error', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce({ data: { error: { code: 200, data: { name: 'odoo.exceptions.UserError', message: 'No hay stock suficiente' } } }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
      })
      await expect(api.confirmSalesOrder('17')).rejects.toThrow(/No hay stock suficiente/)
    })
  })

  describe('reviveSalesOrderToDraft (Fase 6 — ping-pong cancelar/corregir/cerrar-ganado)', () => {
    it('stub mode returns state draft', async () => {
      const api = createOdooApiClient({ mode: 'stub' })
      expect(await api.reviveSalesOrderToDraft('17')).toEqual({ state: 'draft' })
    })

    it('http mode calls action_draft on the sale.order', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce({ data: { result: true }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
      })
      const r = await api.reviveSalesOrderToDraft('17')
      expect(r).toEqual({ state: 'draft' })
      expect(post.mock.calls[1][1].params.args).toEqual([
        'db', 2, 'k', 'sale.order', 'action_draft', [[17]], {}
      ])
    })
  })

  describe('findManufacturingOrderBySaleOrderName (Fase 4 — docs/plan-cambios-2026-08-05.md MO write-back)', () => {
    it('stub mode returns null', async () => {
      const api = createOdooApiClient({ mode: 'stub' })
      expect(await api.findManufacturingOrderBySaleOrderName('S00017')).toBeNull()
    })

    it('http mode searches mrp.production by origin=soName and returns the first match', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce({ data: { result: [{ id: 88, name: 'WH/MO/00042' }] }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
      })
      const r = await api.findManufacturingOrderBySaleOrderName('S00017')
      expect(r).toEqual({ id: 88, name: 'WH/MO/00042' })
      expect(post.mock.calls[1][1].params.args).toEqual([
        'db', 2, 'k', 'mrp.production', 'search_read', [[['origin', '=', 'S00017']]], { fields: ['id', 'name'] }
      ])
    })

    it('http mode returns null when no MO matches yet', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce({ data: { result: [] }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
      })
      expect(await api.findManufacturingOrderBySaleOrderName('S99999')).toBeNull()
    })
  })

  describe('searchSalesOrdersChangedSince (Fase 6 — docs/plan-cambios-2026-08-05.md bidireccionalidad)', () => {
    it('stub mode returns an empty array', async () => {
      const api = createOdooApiClient({ mode: 'stub' })
      expect(await api.searchSalesOrdersChangedSince({ writeDateGte: '2026-08-01 00:00:00' })).toEqual([])
    })

    it('http mode searches sale.order by write_date and returns the rows', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce({ data: { result: [{ id: 17, name: 'S00017', state: 'cancel', invoice_status: 'no', write_date: '2026-08-06 10:00:00' }] }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
      })
      const rows = await api.searchSalesOrdersChangedSince({ writeDateGte: '2026-08-01 00:00:00', offset: 20, limit: 50 })
      expect(rows).toEqual([{ id: 17, name: 'S00017', state: 'cancel', invoice_status: 'no', write_date: '2026-08-06 10:00:00' }])
      expect(post.mock.calls[1][1].params.args).toEqual([
        'db', 2, 'k', 'sale.order', 'search_read',
        [[['write_date', '>', '2026-08-01 00:00:00']]],
        { fields: ['id', 'name', 'state', 'invoice_status', 'write_date'], offset: 20, limit: 50 }
      ])
    })
  })

  describe('searchProductsChangedSince (Fase 3 — docs/plan-cambios-2026-08-05.md incremental sync)', () => {
    it('stub mode returns an empty array', async () => {
      const api = createOdooApiClient({ mode: 'stub' })
      expect(await api.searchProductsChangedSince({ writeDateGte: '2026-08-01 00:00:00' })).toEqual([])
    })

    it('http mode ANDs the default_code filter with an OR of write_date/template write_date by default', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce({ data: { result: [{ id: 1, name: 'A', default_code: 'X', list_price: 10, write_date: '2026-08-05 09:00:00', active: true }] }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
      })
      const rows = await api.searchProductsChangedSince({ writeDateGte: '2026-08-01 00:00:00', offset: 20, limit: 50 })
      expect(rows).toEqual([{ id: 1, name: 'A', default_code: 'X', list_price: 10, write_date: '2026-08-05 09:00:00', active: true }])
      expect(post.mock.calls[1][1].params.args).toEqual([
        'db', 2, 'k', 'product.product', 'search_read',
        [['&', ['default_code', '!=', false], '|', ['write_date', '>', '2026-08-01 00:00:00'], ['product_tmpl_id.write_date', '>', '2026-08-01 00:00:00']]],
        { fields: ['id', 'name', 'default_code', 'list_price', 'write_date', 'active'], offset: 20, limit: 50 }
      ])
    })

    it('http mode omits the default_code filter when includeNoSku is true', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce({ data: { result: [] }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
      })
      await api.searchProductsChangedSince({ writeDateGte: '2026-08-01 00:00:00', includeNoSku: true })
      expect(post.mock.calls[1][1].params.args).toEqual([
        'db', 2, 'k', 'product.product', 'search_read',
        [['|', ['write_date', '>', '2026-08-01 00:00:00'], ['product_tmpl_id.write_date', '>', '2026-08-01 00:00:00']]],
        { fields: ['id', 'name', 'default_code', 'list_price', 'write_date', 'active'], offset: 0, limit: 100 }
      ])
    })
  })
})
