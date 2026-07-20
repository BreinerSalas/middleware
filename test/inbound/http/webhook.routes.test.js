import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const request = require('supertest')
const { createApp } = require('../../../src/app.js')

function baseConfig(overrides = {}) {
  return {
    mongodbUri: 'mongodb://x',
    hubspot: { accessToken: 't', apiBase: 'https://api.hubapi.com', propertyOdooCustomerId: 'a', propertyOdooOrderId: 'b' },
    webhook: { sharedSecret: 'topsecret', headerName: 'x-smartflow-secret' },
    odoo: { mode: 'stub', baseUrl: '', apiKey: '' },
    server: { port: 0, nodeEnv: 'test' },
    logging: { level: 'error' },
    worker: { concurrency: 1, pollIntervalMs: 50 },
    retry: { maxAttempts: 8, maxDelayMs: 60_000 },
    ...overrides
  }
}

function makeFakeDealSyncModule() {
  const calls = { enqueue: [] }
  return {
    enqueueWebhook: async (args) => { calls.enqueue.push(args); return { job: { _id: 'J-1' }, deduped: false, correlationId: 'C-1' } },
    _calls: calls
  }
}

describe('HTTP /webhooks/hubspot', () => {
  const apps = []
  async function buildApp(mod) {
    const app = createApp({ config: baseConfig(), dealSyncModule: mod })
    await app.listen({ port: 0, host: '127.0.0.1' })
    apps.push(app)
    return app
  }
  afterEach(async () => {
    while (apps.length) { try { await apps.pop().close() } catch (_) {} }
  })

  it('rejects without secret', async () => {
    const mod = makeFakeDealSyncModule()
    const app = await buildApp(mod)
    const res = await request(app.server).post('/webhooks/hubspot').send({ objectId: 'D-1' })
    expect(res.status).toBe(401)
    expect(mod._calls.enqueue).toHaveLength(0)
  })

  it('rejects with wrong secret', async () => {
    const mod = makeFakeDealSyncModule()
    const app = await buildApp(mod)
    const res = await request(app.server).post('/webhooks/hubspot').set('x-smartflow-secret', 'wrong').send({ objectId: 'D-1' })
    expect(res.status).toBe(401)
    expect(mod._calls.enqueue).toHaveLength(0)
  })

  it('accepts and enqueues with correct secret', async () => {
    const mod = makeFakeDealSyncModule()
    const app = await buildApp(mod)
    const res = await request(app.server).post('/webhooks/hubspot').set('x-smartflow-secret', 'topsecret').send({ objectId: 'D-1', subscriptionType: 'deal.creation' })
    expect(res.status).toBe(202)
    expect(res.body.ok).toBe(true)
    expect(res.body.jobId).toBe('J-1')
    expect(mod._calls.enqueue).toHaveLength(1)
    expect(mod._calls.enqueue[0].objectId).toBe('D-1')
    expect(mod._calls.enqueue[0].eventType).toBe('deal.creation')
    expect(res.headers['x-correlation-id']).toBeTruthy()
  })

  it('400 when objectId missing', async () => {
    const mod = makeFakeDealSyncModule()
    const app = await buildApp(mod)
    const res = await request(app.server).post('/webhooks/hubspot').set('x-smartflow-secret', 'topsecret').send({})
    expect(res.status).toBe(400)
  })

  it('echoes provided x-correlation-id', async () => {
    const mod = makeFakeDealSyncModule()
    const app = await buildApp(mod)
    const res = await request(app.server).post('/webhooks/hubspot').set('x-smartflow-secret', 'topsecret').set('x-correlation-id', 'CUSTOM-1').send({ objectId: 'D-2' })
    expect(res.headers['x-correlation-id']).toBe('CUSTOM-1')
  })
})
