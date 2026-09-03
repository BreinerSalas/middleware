import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const request = require('supertest')

const { createQuoteReleaseRoutes } = require('../../../src/adapters/inbound/http/quoteRelease.routes.js')

let apps

const config = {
  quoteRelease: { token: 'qr-secret', headerName: 'authorization' },
  server: { nodeEnv: 'test' }
}

beforeEach(() => { apps = [] })
afterEach(async () => { while (apps.length) { try { await apps.pop().close() } catch (_) {} } })

function makeTriggerQuoteRelease(result) {
  return { execute: vi.fn(async () => result) }
}

async function buildApp({ triggerQuoteRelease, hubspotApiClient = null, cfg = config } = {}) {
  const Fastify = require('fastify')
  const app = Fastify({ logger: false })
  await app.register(createQuoteReleaseRoutes, { triggerQuoteRelease, hubspotApiClient, config: cfg })
  await app.listen({ port: 0, host: '127.0.0.1' })
  apps.push(app)
  return app
}

describe('quoteRelease.routes', () => {
  describe('auth', () => {
    it('returns 401 without token', async () => {
      const app = await buildApp({ triggerQuoteRelease: makeTriggerQuoteRelease({}) })
      const res = await request(app.server).post('/api/integrations/quotes/Q-1/release').send({ dealId: 'D-1' })
      expect(res.status).toBe(401)
      expect(res.body.error).toBe('missing_panel_token')
    })

    it('returns 401 on invalid token', async () => {
      const app = await buildApp({ triggerQuoteRelease: makeTriggerQuoteRelease({}) })
      const res = await request(app.server)
        .post('/api/integrations/quotes/Q-1/release')
        .set('authorization', 'wrong')
        .send({ dealId: 'D-1' })
      expect(res.status).toBe(401)
    })
  })

  describe('POST /api/integrations/quotes/:quoteId/release', () => {
    it('returns 400 when dealId is missing', async () => {
      const app = await buildApp({ triggerQuoteRelease: makeTriggerQuoteRelease({}) })
      const res = await request(app.server)
        .post('/api/integrations/quotes/Q-1/release')
        .set('authorization', 'qr-secret')
        .send({})
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('dealId_required')
    })

    it('returns 200 with released:true and tracker/enqueued detail on the happy path', async () => {
      const tracker = { quoteId: 'Q-1', dealId: 'D-1', stage: 'released' }
      const enqueued = { job: { _id: 'JOB-1' }, deduped: false }
      const triggerQuoteRelease = makeTriggerQuoteRelease({ released: true, tracker, enqueued })
      const app = await buildApp({ triggerQuoteRelease })
      const res = await request(app.server)
        .post('/api/integrations/quotes/Q-1/release')
        .set('authorization', 'qr-secret')
        .send({ dealId: 'D-1', correlationId: 'corr-1' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        ok: true,
        released: true,
        tracker: { quoteId: 'Q-1', dealId: 'D-1', stage: 'released' },
        enqueued: { jobId: 'JOB-1', deduped: false }
      })
      expect(triggerQuoteRelease.execute).toHaveBeenCalledWith({
        dealId: 'D-1',
        quoteId: 'Q-1',
        correlationId: 'corr-1'
      })
    })

    it('returns 200 with released:false when the quote is not releasable (already released/cancelled)', async () => {
      const tracker = { quoteId: 'Q-1', dealId: 'D-1', stage: 'cancelled' }
      const triggerQuoteRelease = makeTriggerQuoteRelease({ released: false, tracker, enqueued: null })
      const app = await buildApp({ triggerQuoteRelease })
      const res = await request(app.server)
        .post('/api/integrations/quotes/Q-1/release')
        .set('authorization', 'qr-secret')
        .send({ dealId: 'D-1' })
      expect(res.status).toBe(200)
      expect(res.body.released).toBe(false)
      expect(res.body.tracker).toEqual({ quoteId: 'Q-1', dealId: 'D-1', stage: 'cancelled' })
      expect(res.body.enqueued).toBeNull()
    })

    it('returns 200 with a null tracker when the use case reports one (e.g. no dealId, no tracker created)', async () => {
      const triggerQuoteRelease = makeTriggerQuoteRelease({ released: false, tracker: null, enqueued: null })
      const app = await buildApp({ triggerQuoteRelease })
      const res = await request(app.server)
        .post('/api/integrations/quotes/Q-1/release')
        .set('authorization', 'qr-secret')
        .send({ dealId: 'D-1' })
      expect(res.status).toBe(200)
      expect(res.body.tracker).toBeNull()
    })
  })

  describe('GET /api/integrations/quotes/properties/:propertyName/options', () => {
    function makeHubspotApiClient(property) {
      return { getCustomProperty: vi.fn(async () => property) }
    }

    it('returns 401 without token', async () => {
      const app = await buildApp({
        triggerQuoteRelease: makeTriggerQuoteRelease({}),
        hubspotApiClient: makeHubspotApiClient({ options: [] })
      })
      const res = await request(app.server).get('/api/integrations/quotes/properties/pais_de_destino/options')
      expect(res.status).toBe(401)
    })

    it('returns 503 when hubspotApiClient was not wired', async () => {
      const app = await buildApp({ triggerQuoteRelease: makeTriggerQuoteRelease({}) })
      const res = await request(app.server)
        .get('/api/integrations/quotes/properties/pais_de_destino/options')
        .set('authorization', 'qr-secret')
      expect(res.status).toBe(503)
      expect(res.body.error).toBe('hubspot_client_not_ready')
    })

    it('returns 200 with the option list resolved from the property definition', async () => {
      const hubspotApiClient = makeHubspotApiClient({
        options: [
          { label: 'DDP Costa Rica', value: '104' },
          { label: 'DDP Panamá', value: '105' }
        ]
      })
      const app = await buildApp({ triggerQuoteRelease: makeTriggerQuoteRelease({}), hubspotApiClient })
      const res = await request(app.server)
        .get('/api/integrations/quotes/properties/pais_de_destino/options')
        .set('authorization', 'qr-secret')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        ok: true,
        options: [
          { label: 'DDP Costa Rica', value: '104' },
          { label: 'DDP Panamá', value: '105' }
        ]
      })
      expect(hubspotApiClient.getCustomProperty).toHaveBeenCalledWith('quotes', 'pais_de_destino')
    })
  })
})
