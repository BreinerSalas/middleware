import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createHubspotApiClient } = require('../../../src/adapters/outbound/hubspot/hubspotApiClient.js')

function makeHttpMock({ get = async () => ({ data: {} }), patch = async () => ({ data: {} }), post = async () => ({ data: { results: [] } }) } = {}) {
  return { get: vi.fn(get), patch: vi.fn(patch), post: vi.fn(post) }
}

describe('hubspotApiClient - rate limit wrapper', () => {
  it('takes a token from the rateLimiter before each HTTP call', async () => {
    const http = makeHttpMock()
    const takeSpy = vi.fn().mockResolvedValue(undefined)
    const rl = { take: takeSpy, pause: vi.fn() }
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http,
      rateLimiter: rl
    })
    await api.getDeal('D-1')
    await api.updateDeal('D-1', { foo: 'bar' })
    expect(takeSpy).toHaveBeenCalledTimes(2)
  })

  it('retries on 429 honoring Retry-After header', async () => {
    let calls = 0
    const http = {
      get: vi.fn(async () => {
        calls += 1
        if (calls === 1) {
          const err = new Error('Too Many Requests')
          err.response = {
            status: 429,
            data: { message: 'rate exceeded' },
            headers: { 'retry-after': '0' }
          }
          throw err
        }
        return { data: { id: 'D-1', properties: { dealname: 'X' } } }
      }),
      patch: vi.fn(),
      post: vi.fn()
    }
    const pauseSpy = vi.fn()
    const rl = { take: vi.fn().mockResolvedValue(undefined), pause: pauseSpy }
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http,
      rateLimiter: rl,
      maxRetries: 3
    })
    const data = await api.getDeal('D-1')
    expect(data.id).toBe('D-1')
    expect(http.get).toHaveBeenCalledTimes(2)
    expect(pauseSpy).toHaveBeenCalled()
  })

  it('throws after maxRetries (3) on persistent 429', async () => {
    const err429 = () => {
      const err = new Error('Too Many Requests')
      err.response = {
        status: 429,
        data: { message: 'rate' },
        headers: { 'retry-after': '0' }
      }
      return err
    }
    const http = {
      get: vi.fn(async () => { throw err429() }),
      patch: vi.fn(),
      post: vi.fn()
    }
    const rl = { take: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http,
      rateLimiter: rl,
      maxRetries: 3
    })
    await expect(api.getDeal('D-1')).rejects.toThrow(/Too Many Requests|429|rate/i)
    expect(http.get).toHaveBeenCalledTimes(4)
  })

  it('does not retry on non-429 errors', async () => {
    const http = {
      get: vi.fn(async () => {
        const err = new Error('Boom')
        err.response = { status: 500, data: { message: 'server' } }
        throw err
      }),
      patch: vi.fn(),
      post: vi.fn()
    }
    const pauseSpy = vi.fn()
    const rl = { take: vi.fn().mockResolvedValue(undefined), pause: pauseSpy }
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http,
      rateLimiter: rl
    })
    await expect(api.getDeal('D-1')).rejects.toThrow(/server|Boom/i)
    expect(http.get).toHaveBeenCalledTimes(1)
    expect(pauseSpy).not.toHaveBeenCalled()
  })

  it('when rateLimiter is null, calls go through with no rate limiting', async () => {
    const http = makeHttpMock({ get: vi.fn(async () => ({ data: { id: 'D-1' } })) })
    const api = createHubspotApiClient({
      baseUrl: 'https://api.hubapi.com',
      accessToken: 'tok-1',
      httpClient: http,
      rateLimiter: null
    })
    const data = await api.getDeal('D-1')
    expect(data.id).toBe('D-1')
  })
})
