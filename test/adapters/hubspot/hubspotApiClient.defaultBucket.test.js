import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createHubspotApiClient } = require('../../../src/adapters/outbound/hubspot/hubspotApiClient.js')

function makeHttpMock() {
  return {
    get: vi.fn(async () => ({ data: {} })),
    patch: vi.fn(async () => ({ data: {} })),
    post: vi.fn(async () => ({ data: { results: [] } }))
  }
}

describe('hubspotApiClient - default rate limiter (retrofit to deal-sync)', () => {
  it('creates a rate limiter by default when none is injected', () => {
    const http = makeHttpMock()
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http
    })
    expect(api._rateLimiter).toBeTruthy()
    expect(typeof api._rateLimiter.take).toBe('function')
    expect(typeof api._rateLimiter.pause).toBe('function')
  })

  it('exposes the rate limiter so callers can inspect remaining tokens', () => {
    const http = makeHttpMock()
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http
    })
    const before = api._rateLimiter.tokens
    expect(before).toBeGreaterThan(0)
    expect(before).toBeLessThanOrEqual(15)
  })

  it('deals sync would benefit: 10 consecutive getDeal calls under a small bucket produce observable waits', async () => {
    const http = makeHttpMock({
      get: vi.fn(async () => ({ data: { id: 'D' } }))
    })
    const rl = { tokens: 2, take: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http,
      rateLimiter: rl
    })
    const promises = []
    for (let i = 0; i < 5; i += 1) promises.push(api.getDeal(`D-${i}`))
    await Promise.all(promises)
    expect(rl.take).toHaveBeenCalledTimes(5)
  })
})
