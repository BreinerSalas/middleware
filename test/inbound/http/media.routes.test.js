import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const request = require('supertest')
const Fastify = require('fastify')

const { createMediaRoutes, sniffImageContentType } = require('../../../src/adapters/inbound/http/media.routes.js')
const { signProductImageToken } = require('../../../src/core/shared/mediaSignature.js')

const SECRET = 'test-media-secret'
// 1x1 transparent PNG
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

let apps = []
afterEach(async () => { while (apps.length) { try { await apps.pop().close() } catch (_) {} } })

function fakeRateLimiter() {
  return { take: async () => {} }
}

async function buildApp({ odooApiClient, secret = SECRET, rateLimiter = fakeRateLimiter() } = {}) {
  const app = Fastify({ logger: false })
  await app.register(createMediaRoutes, {
    odooApiClient,
    mediaConfig: { urlSecret: secret },
    rateLimiter
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  apps.push(app)
  return app
}

describe('media.routes', () => {
  it('throws when odooApiClient is missing', async () => {
    const app = Fastify({ logger: false })
    await expect(app.register(createMediaRoutes, { mediaConfig: { urlSecret: SECRET } })).rejects.toThrow(/odooApiClient/)
  })

  it('throws when mediaConfig.urlSecret is missing', async () => {
    const app = Fastify({ logger: false })
    await expect(app.register(createMediaRoutes, { odooApiClient: {} })).rejects.toThrow(/urlSecret/)
  })

  it('serves the real image bytes with a sniffed content-type for a valid signed token', async () => {
    const odooApiClient = {
      readProductImage: async (id) => {
        expect(id).toBe(16488)
        return { base64: PNG_BYTES.toString('base64'), writeDate: '2026-08-05 10:00:00' }
      }
    }
    const app = await buildApp({ odooApiClient })
    const token = signProductImageToken(16488, SECRET)
    const res = await request(app.server).get(`/media/products/${token}/image`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['cache-control']).toBe('public, max-age=86400')
    expect(res.headers.etag).toBeDefined()
    expect(Buffer.compare(res.body, PNG_BYTES)).toBe(0)
  })

  it('returns 404 for a token signed with a different secret', async () => {
    const odooApiClient = { readProductImage: async () => ({ base64: PNG_BYTES.toString('base64'), writeDate: 'x' }) }
    const app = await buildApp({ odooApiClient })
    const token = signProductImageToken(16488, 'other-secret')
    const res = await request(app.server).get(`/media/products/${token}/image`)
    expect(res.status).toBe(404)
  })

  it('returns 404 for a malformed token without calling Odoo', async () => {
    const readProductImage = async () => { throw new Error('should not be called') }
    const app = await buildApp({ odooApiClient: { readProductImage } })
    const res = await request(app.server).get('/media/products/not-a-real-token/image')
    expect(res.status).toBe(404)
  })

  it('returns 404 when the product has no image', async () => {
    const odooApiClient = { readProductImage: async () => null }
    const app = await buildApp({ odooApiClient })
    const token = signProductImageToken(999999, SECRET)
    const res = await request(app.server).get(`/media/products/${token}/image`)
    expect(res.status).toBe(404)
  })

  it('returns 502 when Odoo read fails', async () => {
    const odooApiClient = { readProductImage: async () => { throw new Error('odoo down') } }
    const app = await buildApp({ odooApiClient })
    const token = signProductImageToken(16488, SECRET)
    const res = await request(app.server).get(`/media/products/${token}/image`)
    expect(res.status).toBe(502)
  })

  it('returns 304 when If-None-Match matches the current write_date etag', async () => {
    const odooApiClient = {
      readProductImage: async () => ({ base64: PNG_BYTES.toString('base64'), writeDate: '2026-08-05 10:00:00' })
    }
    const app = await buildApp({ odooApiClient })
    const token = signProductImageToken(16488, SECRET)
    const first = await request(app.server).get(`/media/products/${token}/image`)
    const etag = first.headers.etag
    const second = await request(app.server).get(`/media/products/${token}/image`).set('If-None-Match', etag)
    expect(second.status).toBe(304)
  })

  it('awaits the rate limiter before calling Odoo', async () => {
    const calls = []
    const rateLimiter = { take: async () => { calls.push('take') } }
    const odooApiClient = {
      readProductImage: async () => { calls.push('read'); return { base64: PNG_BYTES.toString('base64'), writeDate: 'x' } }
    }
    const app = await buildApp({ odooApiClient, rateLimiter })
    const token = signProductImageToken(16488, SECRET)
    await request(app.server).get(`/media/products/${token}/image`)
    expect(calls).toEqual(['take', 'read'])
  })
})

describe('sniffImageContentType', () => {
  it('detects PNG, JPEG, GIF, WEBP, BMP by magic bytes', () => {
    expect(sniffImageContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe('image/png')
    expect(sniffImageContentType(Buffer.from([0xff, 0xd8, 0xff, 0]))).toBe('image/jpeg')
    expect(sniffImageContentType(Buffer.from([0x47, 0x49, 0x46, 0x38, 0]))).toBe('image/gif')
    expect(sniffImageContentType(Buffer.from([0x42, 0x4d, 0, 0]))).toBe('image/bmp')
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')])
    expect(sniffImageContentType(webp)).toBe('image/webp')
  })

  it('falls back to application/octet-stream for unknown bytes', () => {
    expect(sniffImageContentType(Buffer.from([1, 2, 3, 4]))).toBe('application/octet-stream')
  })
})
