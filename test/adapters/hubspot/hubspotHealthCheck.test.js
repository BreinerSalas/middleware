import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { hubspotHealthCheck } = require('../../../src/adapters/outbound/hubspot/hubspotHealthCheck.js')

describe('hubspotHealthCheck', () => {
  it('returns up=true on 2xx', async () => {
    const http = { get: vi.fn(async () => ({ status: 200, data: { results: [] } })) }
    const res = await hubspotHealthCheck({ baseUrl: 'https://api.hubapi.com', accessToken: 't', httpClient: http })
    expect(res.up).toBe(true)
    expect(res.latencyMs).toBeGreaterThanOrEqual(0)
    expect(res.error).toBeNull()
    expect(http.get).toHaveBeenCalledWith('/crm/v3/objects/deals', { params: { limit: 1 } })
  })

  it('returns up=false on non-2xx with status', async () => {
    const http = { get: vi.fn(async () => { const e = new Error('Unauthorized'); e.response = { status: 401 }; throw e }) }
    const res = await hubspotHealthCheck({ baseUrl: 'https://api.hubapi.com', accessToken: 't', httpClient: http })
    expect(res.up).toBe(false)
    expect(res.status).toBe(401)
    expect(res.error).toMatch(/401/)
  })

  it('returns up=false on timeout', async () => {
    const http = { get: vi.fn(async () => { const e = new Error('timeout'); e.code = 'ECONNABORTED'; throw e }) }
    const res = await hubspotHealthCheck({ baseUrl: 'https://api.hubapi.com', accessToken: 't', httpClient: http, timeoutMs: 50 })
    expect(res.up).toBe(false)
    expect(res.error).toMatch(/timeout|aborted|ETIMEDOUT|ECONNABORTED/i)
  })

  it('requires baseUrl and accessToken', async () => {
    await expect(hubspotHealthCheck({ baseUrl: '', accessToken: 't' })).rejects.toThrow(/baseUrl/)
    await expect(hubspotHealthCheck({ baseUrl: 'https://x', accessToken: '' })).rejects.toThrow(/accessToken/)
  })
})
