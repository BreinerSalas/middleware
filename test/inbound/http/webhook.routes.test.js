import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import crypto from 'node:crypto'
const request = require('supertest')
const { createApp } = require('../../../src/app.js')

function baseConfig(overrides = {}) {
  return {
    mongodbUri: 'mongodb://x',
    hubspot: {
      accessToken: 't',
      apiBase: 'https://api.hubapi.com',
      clientSecret: 'hmac-test-secret',
      signatureTimestampToleranceMs: 5 * 60 * 1000,
      propertyOdooCustomerId: 'a',
      propertyOdooOrderId: 'b'
    },
    odoo: { mode: 'stub', baseUrl: '', apiKey: '' },
    deals: {
      allowedStageIds: ['1409249445'],
      allowedPipelineIds: ['t_5728252902aef7e9938dfcbb6cdc2af8'],
      rejectUnknownPipeline: true
    },
    server: { port: 0, nodeEnv: 'test' },
    logging: { level: 'error' },
    worker: { concurrency: 1, pollIntervalMs: 50 },
    retry: { maxAttempts: 8, maxDelayMs: 60_000 },
    ...overrides
  }
}

function signWebhook({ method, fullUrl, rawBody, timestamp, secret }) {
  const base = method + fullUrl + rawBody + String(timestamp)
  return crypto.createHmac('sha256', secret).update(base).digest('base64')
}

function makeFakeDealSyncModule() {
  const calls = { enqueue: [] }
  return {
    enqueueWebhook: async (args) => {
      calls.enqueue.push(args)
      return { job: { _id: `J-${calls.enqueue.length}` }, deduped: false, correlationId: `C-${calls.enqueue.length}` }
    },
    _calls: calls
  }
}

async function postSigned(app, { body, secret = 'hmac-test-secret', url = '/webhooks/hubspot', method = 'POST' }) {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body)
  const ts = Date.now()
  const addr = app.server.address()
  const host = `127.0.0.1:${addr.port}`
  const fullUrl = `https://${host}${url}`
  const sig = signWebhook({ method, fullUrl, rawBody, timestamp: ts, secret })
  return request(app.server)
    .post(url)
    .set('x-hubspot-signature-v3', sig)
    .set('x-hubspot-request-timestamp', String(ts))
    .set('Content-Type', 'application/json')
    .send(body)
}

describe('HTTP /webhooks/hubspot (Private App HMAC + array body)', () => {
  const apps = []
  async function buildApp(mod, cfg = baseConfig()) {
    const app = createApp({ config: cfg, dealSyncModule: mod })
    await app.listen({ port: 0, host: '127.0.0.1' })
    apps.push(app)
    return app
  }
  afterEach(async () => {
    while (apps.length) { try { await apps.pop().close() } catch (_) {} }
  })

  it('401 when signature header is missing', async () => {
    const mod = makeFakeDealSyncModule()
    const app = await buildApp(mod)
    const res = await request(app.server).post('/webhooks/hubspot').send([{ objectId: '1' }])
    expect(res.status).toBe(401)
    expect(mod._calls.enqueue).toHaveLength(0)
  })

  it('401 when signature is invalid', async () => {
    const mod = makeFakeDealSyncModule()
    const app = await buildApp(mod)
    const body = JSON.stringify([{ objectId: '1' }])
    const ts = Date.now()
    const res = await request(app.server)
      .post('/webhooks/hubspot')
      .set('x-hubspot-signature-v3', 'wrong')
      .set('x-hubspot-request-timestamp', String(ts))
      .set('Content-Type', 'application/json')
      .send(body)
    expect(res.status).toBe(401)
    expect(mod._calls.enqueue).toHaveLength(0)
  })

  it('202 when array contains deal.propertyChange(dealstage=Cierre Ganado stageId) — enqueues 1 job', async () => {
    const mod = makeFakeDealSyncModule()
    const app = await buildApp(mod)
    const body = [{
      subscriptionType: 'deal.propertyChange',
      objectId: '12345',
      propertyName: 'dealstage',
      propertyValue: '1409249445'
    }]
    const res = await postSigned(app, { body })
    expect(res.status).toBe(202)
    expect(res.body.ok).toBe(true)
    expect(mod._calls.enqueue).toHaveLength(1)
    expect(mod._calls.enqueue[0].objectId).toBe('12345')
    expect(mod._calls.enqueue[0].eventType).toBe('deal.propertyChange')
  })

  it('200 (ack) and 0 enqueues when deal.propertyChange has a different property', async () => {
    const mod = makeFakeDealSyncModule()
    const app = await buildApp(mod)
    const body = [{
      subscriptionType: 'deal.propertyChange',
      objectId: '12345',
      propertyName: 'amount',
      propertyValue: '999'
    }]
    const res = await postSigned(app, { body })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.enqueued).toBe(0)
    expect(mod._calls.enqueue).toHaveLength(0)
  })

  it('200 and 0 enqueues when deal.propertyChange has dealstage=stage-not-in-allowlist (sales pipeline Cierre Ganado)', async () => {
    const mod = makeFakeDealSyncModule()
    const app = await buildApp(mod)
    const body = [{
      subscriptionType: 'deal.propertyChange',
      objectId: '12345',
      propertyName: 'dealstage',
      propertyValue: 'qualifiedtobuy'
    }]
    const res = await postSigned(app, { body })
    expect(res.status).toBe(200)
    expect(res.body.enqueued).toBe(0)
    expect(mod._calls.enqueue).toHaveLength(0)
  })

  it('200 and 0 enqueues for legacy "closedwon" string when allowlist is stageId-based', async () => {
    const mod = makeFakeDealSyncModule()
    const app = await buildApp(mod)
    const body = [{
      subscriptionType: 'deal.propertyChange',
      objectId: '12345',
      propertyName: 'dealstage',
      propertyValue: 'closedwon'
    }]
    const res = await postSigned(app, { body })
    expect(res.status).toBe(200)
    expect(res.body.enqueued).toBe(0)
    expect(mod._calls.enqueue).toHaveLength(0)
  })

  it('200 and 0 enqueues for deal.creation (strict mode)', async () => {
    const mod = makeFakeDealSyncModule()
    const app = await buildApp(mod)
    const body = [{ subscriptionType: 'deal.creation', objectId: '12345' }]
    const res = await postSigned(app, { body })
    expect(res.status).toBe(200)
    expect(res.body.enqueued).toBe(0)
    expect(mod._calls.enqueue).toHaveLength(0)
  })

  it('200 and 0 enqueues for deal.deletion', async () => {
    const mod = makeFakeDealSyncModule()
    const app = await buildApp(mod)
    const body = [{ subscriptionType: 'deal.deletion', objectId: '12345' }]
    const res = await postSigned(app, { body })
    expect(res.status).toBe(200)
    expect(res.body.enqueued).toBe(0)
    expect(mod._calls.enqueue).toHaveLength(0)
  })

  it('200 and 0 enqueues for empty array', async () => {
    const mod = makeFakeDealSyncModule()
    const app = await buildApp(mod)
    const res = await postSigned(app, { body: [] })
    expect(res.status).toBe(200)
    expect(res.body.enqueued).toBe(0)
    expect(mod._calls.enqueue).toHaveLength(0)
  })

  it('202 and enqueues only the relevant event when batch mixes relevant + ignored', async () => {
    const mod = makeFakeDealSyncModule()
    const app = await buildApp(mod)
    const body = [
      { subscriptionType: 'deal.creation', objectId: 'IGNORE-1' },
      { subscriptionType: 'deal.propertyChange', objectId: 'KEEP-1', propertyName: 'amount', propertyValue: '10' },
      { subscriptionType: 'deal.propertyChange', objectId: 'KEEP-2', propertyName: 'dealstage', propertyValue: '1409249445' },
      { subscriptionType: 'deal.deletion', objectId: 'IGNORE-2' }
    ]
    const res = await postSigned(app, { body })
    expect(res.status).toBe(202)
    expect(mod._calls.enqueue).toHaveLength(1)
    expect(mod._calls.enqueue[0].objectId).toBe('KEEP-2')
    expect(res.body.enqueued).toBe(1)
  })

  it('200 and 0 enqueues for events missing objectId', async () => {
    const mod = makeFakeDealSyncModule()
    const app = await buildApp(mod)
    const body = [{
      subscriptionType: 'deal.propertyChange',
      propertyName: 'dealstage',
      propertyValue: '1409249445'
    }]
    const res = await postSigned(app, { body })
    expect(res.status).toBe(200)
    expect(res.body.enqueued).toBe(0)
    expect(mod._calls.enqueue).toHaveLength(0)
  })

  it('echoes x-correlation-id when provided', async () => {
    const mod = makeFakeDealSyncModule()
    const app = await buildApp(mod)
    const body = [{
      subscriptionType: 'deal.propertyChange',
      objectId: '12345',
      propertyName: 'dealstage',
      propertyValue: '1409249445'
    }]
    const rawBody = JSON.stringify(body)
    const ts = Date.now()
    const addr = app.server.address()
    const sig = signWebhook({ method: 'POST', fullUrl: `https://127.0.0.1:${addr.port}/webhooks/hubspot`, rawBody, timestamp: ts, secret: 'hmac-test-secret' })
    const res = await request(app.server)
      .post('/webhooks/hubspot')
      .set('x-hubspot-signature-v3', sig)
      .set('x-hubspot-request-timestamp', String(ts))
      .set('x-correlation-id', 'CUSTOM-1')
      .set('Content-Type', 'application/json')
      .send(body)
    expect(res.headers['x-correlation-id']).toBe('CUSTOM-1')
  })

  it('500 when clientSecret is missing and NODE_ENV is production (fail-closed)', async () => {
    const mod = makeFakeDealSyncModule()
    const cfg = baseConfig({
      hubspot: {
        accessToken: 't',
        apiBase: 'https://api.hubapi.com',
        clientSecret: '',
        signatureTimestampToleranceMs: 300000,
        propertyOdooCustomerId: 'a',
        propertyOdooOrderId: 'b'
      },
      server: { port: 0, nodeEnv: 'production' }
    })
    const app = await buildApp(mod, cfg)
    const res = await request(app.server)
      .post('/webhooks/hubspot')
      .set('x-hubspot-signature-v3', 'x')
      .set('x-hubspot-request-timestamp', String(Date.now()))
      .send([])
    expect(res.status).toBe(500)
    expect(mod._calls.enqueue).toHaveLength(0)
  })

  describe('Pipeline Comercial Visual Branding selector', () => {
    it('accepts dealstage with stageId 1409249445 (Cierre Ganado) under default config', async () => {
      const mod = makeFakeDealSyncModule()
      const app = await buildApp(mod)
      const body = [{
        subscriptionType: 'deal.propertyChange',
        objectId: 'CVB-1',
        propertyName: 'dealstage',
        propertyValue: '1409249445'
      }]
      const res = await postSigned(app, { body })
      expect(res.status).toBe(202)
      expect(res.body.enqueued).toBe(1)
      expect(mod._calls.enqueue[0].objectId).toBe('CVB-1')
    })

    it('rejects a Cierre Ganado event with a different stageId (sales pipeline)', async () => {
      const mod = makeFakeDealSyncModule()
      const app = await buildApp(mod)
      const body = [{
        subscriptionType: 'deal.propertyChange',
        objectId: 'SALES-1',
        propertyName: 'dealstage',
        propertyValue: '888888'
      }]
      const res = await postSigned(app, { body })
      expect(res.status).toBe(200)
      expect(res.body.enqueued).toBe(0)
      expect(mod._calls.enqueue).toHaveLength(0)
    })

    it('honors a custom HS_ALLOWED_STAGE_IDS via config override (CSV)', async () => {
      const mod = makeFakeDealSyncModule()
      const cfg = baseConfig({
        deals: { allowedStageIds: ['STAGE-A', 'STAGE-B'], allowedPipelineIds: [], rejectUnknownPipeline: false }
      })
      const app = await buildApp(mod, cfg)
      const accepted = [{
        subscriptionType: 'deal.propertyChange',
        objectId: 'X-1',
        propertyName: 'dealstage',
        propertyValue: 'STAGE-A'
      }]
      const rejected = [{
        subscriptionType: 'deal.propertyChange',
        objectId: 'X-2',
        propertyName: 'dealstage',
        propertyValue: '1409249445'
      }]
      const res1 = await postSigned(app, { body: accepted })
      expect(res1.status).toBe(202)
      expect(mod._calls.enqueue).toHaveLength(1)
      const res2 = await postSigned(app, { body: rejected })
      expect(res2.status).toBe(200)
      expect(res2.body.enqueued).toBe(0)
      expect(mod._calls.enqueue).toHaveLength(1)
    })

    it('returns 200 with enqueued=0 when dealstage has no value (defensive)', async () => {
      const mod = makeFakeDealSyncModule()
      const app = await buildApp(mod)
      const body = [{
        subscriptionType: 'deal.propertyChange',
        objectId: 'NO-STAGE',
        propertyName: 'dealstage',
        propertyValue: null
      }]
      const res = await postSigned(app, { body })
      expect(res.status).toBe(200)
      expect(res.body.enqueued).toBe(0)
      expect(mod._calls.enqueue).toHaveLength(0)
    })
  })
})