import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { odooHealthCheck } = require('../../../src/adapters/outbound/odoo/odooHealthCheck.js')

describe('odooHealthCheck', () => {
  it('returns up=true on successful JSON-RPC response', async () => {
    const transport = { post: vi.fn(async () => ({ status: 200, data: { jsonrpc: '2.0', result: { server_version: '17.0' } } })) }
    const res = await odooHealthCheck({ baseUrl: 'https://odoo.example.com', transport })
    expect(res.up).toBe(true)
    expect(res.version).toBe('17.0')
    expect(transport.post).toHaveBeenCalledWith('/jsonrpc', expect.objectContaining({ method: 'call', params: expect.objectContaining({ service: 'common', method: 'version' }) }))
  })

  it('returns up=false on RPC error', async () => {
    const transport = { post: vi.fn(async () => ({ status: 200, data: { jsonrpc: '2.0', error: { code: 99, message: 'nope' } } })) }
    const res = await odooHealthCheck({ baseUrl: 'https://odoo.example.com', transport })
    expect(res.up).toBe(false)
    expect(res.error).toMatch(/nope|error/i)
  })

  it('returns up=false on transport failure', async () => {
    const transport = { post: vi.fn(async () => { throw new Error('ECONNREFUSED') }) }
    const res = await odooHealthCheck({ baseUrl: 'https://odoo.example.com', transport })
    expect(res.up).toBe(false)
    expect(res.error).toMatch(/refused|connect/i)
  })

  it('returns stub-mode note when mode is stub', async () => {
    const res = await odooHealthCheck({ mode: 'stub' })
    expect(res.up).toBe(true)
    expect(res.mode).toBe('stub')
    expect(res.note).toMatch(/stub/i)
  })

  it('requires baseUrl in http mode', async () => {
    await expect(odooHealthCheck({ mode: 'http', baseUrl: '' })).rejects.toThrow(/baseUrl/)
  })
})
