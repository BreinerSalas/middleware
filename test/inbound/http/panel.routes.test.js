import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const request = require('supertest')
const { MongoMemoryServer } = require('mongodb-memory-server')
const mongoose = require('mongoose')

const { createPanelRoutes } = require('../../../src/adapters/inbound/http/panel.routes.js')
const { MongoPanelRepository } = require('../../../src/adapters/outbound/mongo/MongoPanelRepository.js')
const { MappingModel } = require('../../../src/adapters/outbound/mongo/schemas/mapping.schema.js')
const { AuditModel } = require('../../../src/adapters/outbound/mongo/schemas/audit.schema.js')

let mongoServer
let repo
let apps
const config = {
  panel: { token: 'topsecret', headerName: 'x-panel-token' },
  hubspot: { accessToken: 't', apiBase: 'https://api.hubapi.com' },
  odoo: { mode: 'stub', baseUrl: '', apiKey: '' },
  server: { nodeEnv: 'test' }
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create()
  await mongoose.connect(mongoServer.getUri())
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  if (mongoServer) await mongoServer.stop()
}, 60_000)

beforeEach(async () => {
  const collections = await mongoose.connection.db.collections()
  await Promise.all(collections.map((c) => c.deleteMany({})))
  repo = new MongoPanelRepository()
  apps = []
})

afterEach(async () => { while (apps.length) { try { await apps.pop().close() } catch (_) {} } })

async function buildApp({ httpClient = null, transport = null, config: cfgOverride = null } = {}) {
  const Fastify = require('fastify')
  const app = Fastify({ logger: false })
  const useConfig = cfgOverride || config
  const fakeHealthCheck = {
    async hubspot() {
      if (!httpClient) return { up: true, latencyMs: 5, status: 200, error: null }
      try {
        const { hubspotHealthCheck } = require('../../../src/adapters/outbound/hubspot/hubspotHealthCheck.js')
        return await hubspotHealthCheck({ baseUrl: useConfig.hubspot.apiBase, accessToken: useConfig.hubspot.accessToken, httpClient, timeoutMs: 1000 })
      } catch (e) { return { up: false, latencyMs: 0, error: e.message } }
    },
    async odoo() {
      const { odooHealthCheck } = require('../../../src/adapters/outbound/odoo/odooHealthCheck.js')
      return await odooHealthCheck({ mode: useConfig.odoo.mode, baseUrl: useConfig.odoo.baseUrl, transport, timeoutMs: 1000 })
    }
  }
  await app.register(createPanelRoutes, {
    panelRepository: repo,
    healthCheck: fakeHealthCheck,
    config: useConfig
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  apps.push(app)
  return app
}

describe('panel.routes', () => {
  describe('auth', () => {
    it('returns 401 without token when configured', async () => {
      const app = await buildApp()
      const res = await request(app.server).get('/api/panel/status')
      expect(res.status).toBe(401)
      expect(res.body.error).toBe('missing_panel_token')
    })

    it('returns 401 on invalid token', async () => {
      const app = await buildApp()
      const res = await request(app.server).get('/api/panel/status').set('x-panel-token', 'wrong')
      expect(res.status).toBe(401)
      expect(res.body.error).toBe('invalid_panel_token')
    })

    it('returns 200 on valid token', async () => {
      const app = await buildApp()
      const res = await request(app.server).get('/api/panel/status').set('x-panel-token', 'topsecret')
      expect(res.status).toBe(200)
    })
  })

  describe('GET /api/panel/status', () => {
    it('returns hubspot + odoo + counts', async () => {
      await MappingModel.create({ sourceId: 'D-1', targetId: 'T-1', payloadHash: 'h', metadata: {} })
      await AuditModel.create({ sourceId: 'D-1', event: 'job.completed', success: true })
      const app = await buildApp()
      const res = await request(app.server).get('/api/panel/status').set('x-panel-token', 'topsecret')
      expect(res.status).toBe(200)
      expect(res.body.hubspot.up).toBe(true)
      expect(res.body.odoo.up).toBe(true)
      expect(res.body.counts.mappings).toBe(1)
      expect(res.body.counts.audits).toBe(1)
    })

    it('reports hubspot down when http client returns 401', async () => {
      const httpClient = { get: async () => { const e = new Error('auth'); e.response = { status: 401 }; throw e } }
      const app = await buildApp({ httpClient })
      const res = await request(app.server).get('/api/panel/status').set('x-panel-token', 'topsecret')
      expect(res.body.hubspot.up).toBe(false)
      expect(res.body.hubspot.status).toBe(401)
    })

    it('reports odoo down when transport fails (http mode)', async () => {
      const transport = { post: async () => { throw new Error('ECONNREFUSED') } }
      const httpConfig = { ...config, odoo: { mode: 'http', baseUrl: 'https://odoo.example.com', apiKey: '' } }
      const app = await buildApp({ transport, config: httpConfig })
      const res = await request(app.server).get('/api/panel/status').set('x-panel-token', 'topsecret')
      expect(res.body.odoo.up).toBe(false)
    })
  })

  describe('GET /api/panel/mappings', () => {
    it('returns paginated list with total', async () => {
      for (let i = 0; i < 5; i += 1) await MappingModel.create({ sourceId: `D-${i}`, targetId: `T-${i}`, payloadHash: 'h', metadata: {} })
      const app = await buildApp()
      const res = await request(app.server).get('/api/panel/mappings?page=1&pageSize=3').set('x-panel-token', 'topsecret')
      expect(res.status).toBe(200)
      expect(res.body.items).toHaveLength(3)
      expect(res.body.total).toBe(5)
      expect(res.body.page).toBe(1)
      expect(res.body.pageSize).toBe(3)
    })

    it('filters by q', async () => {
      await MappingModel.create({ sourceId: 'hubspot-deal-1', targetId: 'T-1', payloadHash: 'h', metadata: {} })
      await MappingModel.create({ sourceId: 'hubspot-deal-2', targetId: 'T-2', payloadHash: 'h', metadata: {} })
      await MappingModel.create({ sourceId: 'other', targetId: 'T-3', payloadHash: 'h', metadata: {} })
      const app = await buildApp()
      const res = await request(app.server).get('/api/panel/mappings?q=hubspot').set('x-panel-token', 'topsecret')
      expect(res.body.total).toBe(2)
    })
  })

  describe('GET /api/panel/logs', () => {
    it('returns paginated audits with filters', async () => {
      await AuditModel.create({ sourceId: 'D-1', event: 'job.completed', success: true })
      await AuditModel.create({ sourceId: 'D-1', event: 'job.skipped', success: false })
      const app = await buildApp()
      const res = await request(app.server).get('/api/panel/logs?success=false').set('x-panel-token', 'topsecret')
      expect(res.status).toBe(200)
      expect(res.body.total).toBe(1)
      expect(res.body.items[0].event).toBe('job.skipped')
    })
  })

  describe('GET /api/panel/logs/:id', () => {
    it('returns full audit with detail', async () => {
      const created = await AuditModel.create({ sourceId: 'D-1', event: 'job.processing.start', success: true, detail: { foo: 'bar' } })
      const app = await buildApp()
      const res = await request(app.server).get(`/api/panel/logs/${String(created._id)}`).set('x-panel-token', 'topsecret')
      expect(res.status).toBe(200)
      expect(res.body.item.detail).toEqual({ foo: 'bar' })
    })

    it('returns 404 when not found', async () => {
      const app = await buildApp()
      const res = await request(app.server).get('/api/panel/logs/000000000000000000000000').set('x-panel-token', 'topsecret')
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /api/panel/mappings/:id', () => {
    it('removes a mapping', async () => {
      const m = await MappingModel.create({ sourceId: 'D-1', targetId: 'T-1', payloadHash: 'h', metadata: {} })
      const app = await buildApp()
      const res = await request(app.server).delete(`/api/panel/mappings/${String(m._id)}`).set('x-panel-token', 'topsecret')
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      const remaining = await MappingModel.find()
      expect(remaining).toHaveLength(0)
    })

    it('returns 200 with ok=false when id does not exist', async () => {
      const app = await buildApp()
      const res = await request(app.server).delete('/api/panel/mappings/000000000000000000000000').set('x-panel-token', 'topsecret')
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(false)
    })
  })

  describe('DELETE /api/panel/logs/:id', () => {
    it('removes an audit', async () => {
      const a = await AuditModel.create({ sourceId: 'D-1', event: 'job.completed', success: true })
      const app = await buildApp()
      const res = await request(app.server).delete(`/api/panel/logs/${String(a._id)}`).set('x-panel-token', 'topsecret')
      expect(res.status).toBe(200)
      const remaining = await AuditModel.find()
      expect(remaining).toHaveLength(0)
    })
  })

  describe('POST /api/panel/logs/clear', () => {
    it('requires confirm:true in body', async () => {
      const app = await buildApp()
      const res = await request(app.server).post('/api/panel/logs/clear').set('x-panel-token', 'topsecret').send({})
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('confirm_required')
    })

    it('removes all audits when confirm:true', async () => {
      await AuditModel.create({ sourceId: 'D-1', event: 'a', success: true })
      await AuditModel.create({ sourceId: 'D-1', event: 'b', success: true })
      const app = await buildApp()
      const res = await request(app.server).post('/api/panel/logs/clear').set('x-panel-token', 'topsecret').send({ confirm: true })
      expect(res.status).toBe(200)
      expect(res.body.removed).toBe(2)
    })
  })

  describe('POST /api/panel/mappings/clear', () => {
    it('removes all mappings when confirm:true', async () => {
      await MappingModel.create({ sourceId: 'D-1', targetId: 'T-1', payloadHash: 'h', metadata: {} })
      await MappingModel.create({ sourceId: 'D-2', targetId: 'T-2', payloadHash: 'h', metadata: {} })
      const app = await buildApp()
      const res = await request(app.server).post('/api/panel/mappings/clear').set('x-panel-token', 'topsecret').send({ confirm: true })
      expect(res.status).toBe(200)
      expect(res.body.removed).toBe(2)
    })
  })
})
