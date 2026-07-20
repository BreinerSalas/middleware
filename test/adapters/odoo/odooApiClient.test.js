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
      args: ['test-db', 2, 'k', 'mrp.production', 'create', [{ partner_id: 1 }]]
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
      'db', 7, 'k', 'mrp.production', 'write', [[42], { state: 'confirmed' }]
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
    expect(post).toHaveBeenCalledTimes(3)
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
