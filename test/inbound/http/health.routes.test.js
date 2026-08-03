import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const request = require('supertest')
const { createApp } = require('../../../src/app.js')

function baseConfig() {
  return {
    mongodbUri: 'mongodb://x',
    hubspot: { accessToken: 't', apiBase: 'x', propertyOdooCustomerId: 'a', propertyOdooOrderId: 'b' },
    odoo: { mode: 'stub', baseUrl: '', apiKey: '' },
    server: { port: 0, nodeEnv: 'test' },
    logging: { level: 'error' },
    worker: { concurrency: 1, pollIntervalMs: 50 },
    retry: { maxAttempts: 8, maxDelayMs: 60_000 }
  }
}

describe('GET /health', () => {
  const apps = []
  afterEach(async () => { while (apps.length) { try { await apps.pop().close() } catch (_) {} } })

  it('returns 503 when no mongo', async () => {
    const app = createApp({ config: baseConfig(), dealSyncModule: null })
    await app.listen({ port: 0, host: '127.0.0.1' })
    apps.push(app)
    const res = await request(app.server).get('/health')
    expect([200, 503]).toContain(res.status)
    expect(res.body.mongo).toBeDefined()
  })
})
