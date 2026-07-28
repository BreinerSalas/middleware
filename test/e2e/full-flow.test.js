import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const request = require('supertest')
import crypto from 'node:crypto'
const { MongoMemoryServer } = require('mongodb-memory-server')
const mongoose = require('mongoose')

const { createApp } = require('../../src/app.js')
const { createDealSyncModule } = require('../../src/composition/dealSyncModule.js')

let mongoServer
let mod
let app
let calls

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create()
  await mongoose.connect(mongoServer.getUri())
}, 120_000)

afterAll(async () => {
  try { await app.close() } catch (_) {}
  await mongoose.disconnect()
  if (mongoServer) await mongoServer.stop()
}, 60_000)

const config = {
  mongodbUri: 'mongodb://x',
  hubspot: {
    accessToken: 't',
    apiBase: 'https://api.hubapi.com',
    clientSecret: 'e2e-test-secret',
    signatureTimestampToleranceMs: 5 * 60 * 1000,
    propertyOdooCustomerId: 'id_cliente_odoo',
    propertyOdooOrderId: 'id_orden_odoo'
  },
  webhook: { sharedSecret: '', headerName: 'x-smartflow-secret' },
  odoo: { mode: 'stub', baseUrl: '', apiKey: '' },
  server: { port: 0, nodeEnv: 'test' },
  logging: { level: 'error' },
  worker: { concurrency: 1, pollIntervalMs: 50 },
  retry: { maxAttempts: 8, maxDelayMs: 60_000 }
}

describe('e2e: webhook -> job -> upsert -> writeback (Private App HMAC)', () => {
  it('completes a full sync within the polling window', async () => {
    calls = { writeBack: [], upsert: [] }
    const sourceGateway = {
      async fetchRecord(sourceId) { return { id: sourceId, properties: { id_cliente_odoo: '42', dealstage: 'closedwon' } } },
      async resolveReferences() { return { odooCustomerId: '42', lineItems: [{ id: 'L-1', hs_sku: 'SKU-1', quantity: 1, price: 0, name: 'Item 1' }] } },
      async writeBack(sourceId, properties) { calls.writeBack.push({ sourceId, properties }) }
    }
    const targetGateway = {
      async upsert({ existingTargetId } = {}) {
        calls.upsert.push({ existingTargetId })
        return { targetId: existingTargetId || 'stub-mrp-1', targetRef: 'STUB/1', syncToken: 'draft' }
      }
    }
    mod = createDealSyncModule({ config, sourceGateway, targetGateway, logger: null, recoverOrphansOnStart: false })
    app = createApp({ config, dealSyncModule: mod, logger: null })
    await app.listen({ port: 0, host: '127.0.0.1' })
    await mod.startWorker()

    const body = [{
      subscriptionType: 'deal.propertyChange',
      objectId: 'D-1',
      propertyName: 'dealstage',
      propertyValue: 'closedwon'
    }]
    const rawBody = JSON.stringify(body)
    const ts = Date.now()
    const addr = app.server.address()
    const fullUrl = `https://127.0.0.1:${addr.port}/webhooks/hubspot`
    const sig = crypto
      .createHmac('sha256', 'e2e-test-secret')
      .update('POST' + fullUrl + rawBody + String(ts))
      .digest('base64')

    const res = await request(app.server)
      .post('/webhooks/hubspot')
      .set('x-hubspot-signature-v3', sig)
      .set('x-hubspot-request-timestamp', String(ts))
      .send(body)
    expect(res.status).toBe(202)

    // wait until the job completes
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 50))
      if (calls.writeBack.length > 0) break
    }
    expect(calls.upsert).toHaveLength(1)
    expect(calls.writeBack).toHaveLength(1)
    expect(calls.writeBack[0].sourceId).toBe('D-1')

    await mod.stopWorker()
  }, 60_000)
})
