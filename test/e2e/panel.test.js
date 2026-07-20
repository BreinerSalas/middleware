import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const path = require('node:path')
const request = require('supertest')
const { MongoMemoryServer } = require('mongodb-memory-server')
const mongoose = require('mongoose')

const { createApp } = require('../../src/app.js')
const { MongoPanelRepository } = require('../../src/adapters/outbound/mongo/MongoPanelRepository.js')
const { MappingModel } = require('../../src/adapters/outbound/mongo/schemas/mapping.schema.js')
const { AuditModel } = require('../../src/adapters/outbound/mongo/schemas/audit.schema.js')

let mongoServer
let apps

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
  apps = []
})

afterEach(async () => { while (apps.length) { try { await apps.pop().close() } catch (_) {} } })

function buildConfig() {
  return {
    mongodbUri: 'mongodb://x',
    hubspot: { accessToken: 't', apiBase: 'https://api.hubapi.com', propertyOdooCustomerId: 'a', propertyOdooOrderId: 'b' },
    webhook: { sharedSecret: 'whsecret', headerName: 'x-smartflow-secret' },
    odoo: { mode: 'stub', baseUrl: '', apiKey: '' },
    server: { port: 0, nodeEnv: 'test' },
    logging: { level: 'error' },
    worker: { concurrency: 1, pollIntervalMs: 50 },
    retry: { maxAttempts: 8, maxDelayMs: 60_000 },
    panel: { token: 'paneltoken', headerName: 'x-panel-token' }
  }
}

describe('e2e: panel + static assets', () => {
  it('serves index.html at / and references static assets', async () => {
    const cfg = buildConfig()
    const app = createApp({ config: cfg, staticRoot: path.resolve(__dirname, '../../src/panel') })
    await app.listen({ port: 0, host: '127.0.0.1' })
    apps.push(app)
    const res = await request(app.server).get('/')
    expect(res.status).toBe(200)
    expect(res.text).toContain('Panel Integración HubSpot + Odoo')
    expect(res.text).toContain('/static/panel.css')
    expect(res.text).toContain('/static/panel.js')
  })

  it('serves panel.css and panel.js as static assets', async () => {
    const cfg = buildConfig()
    const app = createApp({ config: cfg, staticRoot: path.resolve(__dirname, '../../src/panel') })
    await app.listen({ port: 0, host: '127.0.0.1' })
    apps.push(app)
    const css = await request(app.server).get('/static/panel.css')
    expect(css.status).toBe(200)
    expect(css.text).toContain(':root')
    const js = await request(app.server).get('/static/panel.js')
    expect(js.status).toBe(200)
    expect(js.text).toContain('x-panel-token')
  })

  it('full flow: status -> list mappings -> delete one -> list logs -> delete one', async () => {
    const cfg = buildConfig()
    const panelRepository = new MongoPanelRepository()
    const app = createApp({ config: cfg, panelRepository, staticRoot: path.resolve(__dirname, '../../src/panel') })
    await app.listen({ port: 0, host: '127.0.0.1' })
    apps.push(app)

    const seedMappings = []
    for (let i = 0; i < 3; i += 1) {
      const m = await MappingModel.create({ sourceId: `D-${i}`, targetId: `T-${i}`, payloadHash: 'h', metadata: {} })
      seedMappings.push(String(m._id))
    }
    await AuditModel.create({ sourceId: 'D-1', event: 'job.completed', success: true, detail: { msg: 'all good' } })
    await AuditModel.create({ sourceId: 'D-1', event: 'job.skipped', success: false, detail: { msg: 'no line items' } })

    const statusRes = await request(app.server).get('/api/panel/status').set('x-panel-token', 'paneltoken')
    expect(statusRes.status).toBe(200)
    expect(statusRes.body.counts.mappings).toBe(3)
    expect(statusRes.body.counts.audits).toBe(2)
    expect(statusRes.body.hubspot).toBeTruthy()
    expect(statusRes.body.odoo).toBeTruthy()

    const mappingsRes = await request(app.server).get('/api/panel/mappings').set('x-panel-token', 'paneltoken')
    expect(mappingsRes.status).toBe(200)
    expect(mappingsRes.body.total).toBe(3)

    const delRes = await request(app.server).delete(`/api/panel/mappings/${seedMappings[0]}`).set('x-panel-token', 'paneltoken')
    expect(delRes.status).toBe(200)
    expect(delRes.body.ok).toBe(true)

    const logsRes = await request(app.server).get('/api/panel/logs').set('x-panel-token', 'paneltoken')
    expect(logsRes.status).toBe(200)
    expect(logsRes.body.total).toBe(2)

    const delLogRes = await request(app.server).delete(`/api/panel/logs/${logsRes.body.items[0]._id}`).set('x-panel-token', 'paneltoken')
    expect(delLogRes.status).toBe(200)
    expect(delLogRes.body.ok).toBe(true)

    const finalMappings = await request(app.server).get('/api/panel/mappings').set('x-panel-token', 'paneltoken')
    expect(finalMappings.body.total).toBe(2)
    const finalLogs = await request(app.server).get('/api/panel/logs').set('x-panel-token', 'paneltoken')
    expect(finalLogs.body.total).toBe(1)
  }, 60_000)

  it('clear-all flow: logs then mappings', async () => {
    const cfg = buildConfig()
    const panelRepository = new MongoPanelRepository()
    const app = createApp({ config: cfg, panelRepository, staticRoot: path.resolve(__dirname, '../../src/panel') })
    await app.listen({ port: 0, host: '127.0.0.1' })
    apps.push(app)

    for (let i = 0; i < 3; i += 1) await AuditModel.create({ sourceId: 'D-1', event: 'a', success: true })
    for (let i = 0; i < 2; i += 1) await MappingModel.create({ sourceId: `D-${i}`, targetId: `T-${i}`, payloadHash: 'h', metadata: {} })

    const bad = await request(app.server).post('/api/panel/logs/clear').set('x-panel-token', 'paneltoken').send({})
    expect(bad.status).toBe(400)

    const logsClear = await request(app.server).post('/api/panel/logs/clear').set('x-panel-token', 'paneltoken').send({ confirm: true })
    expect(logsClear.status).toBe(200)
    expect(logsClear.body.removed).toBe(3)

    const mappingsClear = await request(app.server).post('/api/panel/mappings/clear').set('x-panel-token', 'paneltoken').send({ confirm: true })
    expect(mappingsClear.status).toBe(200)
    expect(mappingsClear.body.removed).toBe(2)
  })

  it('production with PANEL_TOKEN unset returns 503 on panel routes', async () => {
    const cfg = buildConfig()
    cfg.server.nodeEnv = 'production'
    cfg.panel.token = ''
    const app = createApp({ config: cfg })
    await app.listen({ port: 0, host: '127.0.0.1' })
    apps.push(app)
    const res = await request(app.server).get('/api/panel/status')
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('panel_disabled')
  })
})
