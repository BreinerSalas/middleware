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
    expect(() => createOdooApiClient({ mode: 'http' })).toThrow(/ODOO_BASE_URL/)
  })

  it('http mode posts JSON-RPC and unwraps result', async () => {
    const post = vi.fn(async () => ({ data: { result: 99 }, status: 200 }))
    const api = createOdooApiClient({ mode: 'http', baseUrl: 'https://odoo.example.com', apiKey: 'k', transport: { post } })
    const r = await api.createManufacturingOrder({ partner_id: 1 })
    expect(r.id).toBe('99')
    expect(post).toHaveBeenCalledWith('/jsonrpc', expect.objectContaining({ jsonrpc: '2.0', method: 'call' }))
  })

  it('http mode throws on rpc error', async () => {
    const post = vi.fn(async () => ({ data: { error: { code: 99, data: { message: 'nope' } } }, status: 200 }))
    const api = createOdooApiClient({ mode: 'http', baseUrl: 'https://odoo.example.com', transport: { post } })
    await expect(api.createManufacturingOrder({})).rejects.toThrow(/nope/)
  })
})
