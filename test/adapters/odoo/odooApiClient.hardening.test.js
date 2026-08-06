import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createOdooApiClient } = require('../../../src/adapters/outbound/odoo/odooApiClient.js')
const { isRetryableError } = require('../../../src/core/domain/RetryPolicy.js')

describe('odooApiClient hardening (Fase 2 — docs/plan-cambios-2026-08-05.md)', () => {
  describe('uid cache no longer poisoned by a failed auth attempt', () => {
    it('re-authenticates on the next call after a failed authenticate, instead of replaying the cached rejection', async () => {
      const post = vi.fn()
        .mockRejectedValueOnce(new Error('auth network blip'))
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce({ data: { result: [{ id: 71, name: 'A', country_id: [1, 'X'], product_id: false }] }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
      })
      await expect(api.listOperationCosts()).rejects.toThrow(/auth network blip/)
      const r = await api.listOperationCosts()
      expect(r[0].id).toBe(71)
      // 1: failed authenticate, 2: retried authenticate (succeeds), 3: the actual RPC
      expect(post).toHaveBeenCalledTimes(3)
    })
  })

  describe('Odoo RPC error classification (err.transient)', () => {
    function mockErrorResponse(name, message = 'boom') {
      return { data: { error: { code: 200, data: { name, message } } }, status: 200 }
    }

    it.each([
      'odoo.http.SessionExpiredException',
      'psycopg2.errors.SerializationFailure',
      'psycopg2.errors.DeadlockDetected',
      'socket.TimeoutError'
    ])('marks %s as transient=true', async (name) => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce(mockErrorResponse(name))
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post },
        retry: { maxRetries: 0 }
      })
      let caught
      try { await api.searchProductIdsWithImage() } catch (err) { caught = err }
      expect(caught).toBeDefined()
      expect(caught.transient).toBe(true)
      expect(isRetryableError(caught)).toBe(true)
    })

    it.each([
      'odoo.exceptions.ValidationError',
      'odoo.exceptions.UserError',
      'psycopg2.errors.IntegrityError',
      'odoo.exceptions.AccessError'
    ])('marks %s as transient=false', async (name) => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce(mockErrorResponse(name))
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
      })
      let caught
      try { await api.searchProductIdsWithImage() } catch (err) { caught = err }
      expect(caught.transient).toBe(false)
      expect(isRetryableError(caught)).toBe(false)
    })

    it('leaves transient unset for an unrecognized Odoo error name (safe default: not retried)', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce(mockErrorResponse('some.WeirdError'))
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
      })
      let caught
      try { await api.searchProductIdsWithImage() } catch (err) { caught = err }
      expect(caught.transient).toBeUndefined()
      expect(isRetryableError(caught)).toBe(false)
    })
  })

  describe('executeKw retries transient RPC errors with backoff, never retries fatal ones', () => {
    it('retries once on a transient error then succeeds, sleeping between attempts', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce({ data: { error: { code: 200, data: { name: 'psycopg2.errors.SerializationFailure', message: 'retry me' } } }, status: 200 })
        .mockResolvedValueOnce({ data: { result: [16488] }, status: 200 })
      const sleepFn = vi.fn().mockResolvedValue(undefined)
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post },
        retry: { maxRetries: 3, baseMs: 100, sleepFn }
      })
      const ids = await api.searchProductIdsWithImage()
      expect(ids).toEqual([16488])
      expect(sleepFn).toHaveBeenCalledTimes(1)
      expect(sleepFn.mock.calls[0][0]).toBeGreaterThan(0)
      expect(post).toHaveBeenCalledTimes(3)
    })

    it('gives up after maxRetries transient failures and throws the last error', async () => {
      const transientResponse = { data: { error: { code: 200, data: { name: 'socket.TimeoutError', message: 'still down' } } }, status: 200 }
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce(transientResponse)
        .mockResolvedValueOnce(transientResponse)
        .mockResolvedValueOnce(transientResponse)
      const sleepFn = vi.fn().mockResolvedValue(undefined)
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post },
        retry: { maxRetries: 2, baseMs: 10, sleepFn }
      })
      await expect(api.searchProductIdsWithImage()).rejects.toThrow(/still down/)
      // 1 auth + 1 initial attempt + 2 retries = 3 RPC attempts
      expect(post).toHaveBeenCalledTimes(4)
      expect(sleepFn).toHaveBeenCalledTimes(2)
    })

    it('does not retry or sleep on a fatal (non-transient) error', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce({ data: { error: { code: 200, data: { name: 'odoo.exceptions.ValidationError', message: 'bad input' } } }, status: 200 })
      const sleepFn = vi.fn().mockResolvedValue(undefined)
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post },
        retry: { maxRetries: 3, baseMs: 100, sleepFn }
      })
      await expect(api.searchProductIdsWithImage()).rejects.toThrow(/bad input/)
      expect(sleepFn).not.toHaveBeenCalled()
      expect(post).toHaveBeenCalledTimes(2)
    })
  })

  describe('rate limiting', () => {
    it('awaits the injected rate limiter before every RPC call, including authenticate', async () => {
      const calls = []
      const rateLimiter = { take: vi.fn(async () => { calls.push('take') }) }
      const post = vi.fn()
        .mockImplementationOnce(async () => { calls.push('post'); return { data: { result: 2 }, status: 200 } })
        .mockImplementationOnce(async () => { calls.push('post'); return { data: { result: [16488] }, status: 200 } })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post },
        rateLimiter
      })
      await api.searchProductIdsWithImage()
      expect(rateLimiter.take).toHaveBeenCalledTimes(2)
      expect(calls).toEqual(['take', 'post', 'take', 'post'])
    })
  })

  describe('per-operation timeouts', () => {
    it('uses the read timeout for search/read operations and the write timeout for create/write', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce({ data: { result: [16488] }, status: 200 })
        .mockResolvedValueOnce({ data: { result: 999 }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post },
        readTimeoutMs: 30000, writeTimeoutMs: 10000
      })
      await api.searchProductIdsWithImage()
      await api.createSalesOrder({ partner_id: 1, order_line: [] })

      const readCallOpts = post.mock.calls[1][2]
      expect(readCallOpts).toMatchObject({ timeoutMs: 30000 })
      const writeCallOpts = post.mock.calls[2][2]
      expect(writeCallOpts).toMatchObject({ timeoutMs: 10000 })
    })
  })
})
