'use strict'

const fp = require('fastify-plugin')
const { createPanelAuthMiddleware } = require('./panel.auth.middleware.js')

const CLEAR_COOLDOWN_MS = 30_000

async function panelRoutesImpl(fastify, opts) {
  const { panelRepository, healthCheck, config, productRepository = null } = opts || {}
  if (!panelRepository) throw new Error('createPanelRoutes requires panelRepository')
  if (!healthCheck) throw new Error('createPanelRoutes requires healthCheck')
  if (!config || !config.panel) throw new Error('createPanelRoutes requires config.panel')

  const auth = createPanelAuthMiddleware({
    token: config.panel.token,
    headerName: config.panel.headerName,
    nodeEnv: (config.server && config.server.nodeEnv) || 'production'
  })

  const requireAuth = { preHandler: auth }

  fastify.get('/api/panel/status', requireAuth, async (req, reply) => {
    const [hubspot, odoo, counts] = await Promise.all([
      healthCheck.hubspot(),
      healthCheck.odoo(),
      panelRepository.getCounts()
    ])
    return reply.send({ ok: true, hubspot, odoo, counts, ts: new Date().toISOString() })
  })

  fastify.get('/api/panel/mappings', requireAuth, async (req, reply) => {
    const { page = 1, pageSize = 25, q = null } = req.query || {}
    const result = await panelRepository.listMappings({ page: Number(page) || 1, pageSize: Number(pageSize) || 25, q })
    return reply.send({ ok: true, ...result })
  })

  fastify.get('/api/panel/product-mappings', requireAuth, async (req, reply) => {
    if (!productRepository) return reply.code(503).send({ ok: false, error: 'product_repository_not_ready' })
    const { page = 1, pageSize = 25, q = null } = req.query || {}
    const result = await productRepository.listProductMappings({ page: Number(page) || 1, pageSize: Number(pageSize) || 25, q })
    return reply.send({ ok: true, ...result })
  })

  fastify.get('/api/panel/product-runs', requireAuth, async (req, reply) => {
    if (!productRepository) return reply.code(503).send({ ok: false, error: 'product_repository_not_ready' })
    const { limit = 10 } = req.query || {}
    const items = await productRepository.listRecentRuns({ limit: Number(limit) || 10 })
    return reply.send({ ok: true, items })
  })

  fastify.get('/api/panel/logs', requireAuth, async (req, reply) => {
    const { page = 1, pageSize = 25, event = null, success, q = null } = req.query || {}
    const successBool = typeof success === 'string' ? (success === 'true') : success
    const result = await panelRepository.listLogs({
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 25,
      event,
      success: successBool,
      q
    })
    return reply.send({ ok: true, ...result })
  })

  fastify.get('/api/panel/logs/:id', requireAuth, async (req, reply) => {
    const item = await panelRepository.getLogById(req.params.id)
    if (!item) return reply.code(404).send({ ok: false, error: 'not_found' })
    return reply.send({ ok: true, item })
  })

  fastify.delete('/api/panel/mappings/:id', requireAuth, async (req, reply) => {
    const ok = await panelRepository.deleteMapping(req.params.id)
    return reply.send({ ok, removed: ok ? 1 : 0 })
  })

  fastify.delete('/api/panel/logs/:id', requireAuth, async (req, reply) => {
    const ok = await panelRepository.deleteLog(req.params.id)
    return reply.send({ ok, removed: ok ? 1 : 0 })
  })

  const lastClearAt = { logs: 0, mappings: 0 }

  fastify.post('/api/panel/logs/clear', requireAuth, async (req, reply) => {
    if (!req.body || req.body.confirm !== true) {
      return reply.code(400).send({ ok: false, error: 'confirm_required' })
    }
    const now = Date.now()
    if (now - lastClearAt.logs < CLEAR_COOLDOWN_MS) {
      return reply.code(429).send({ ok: false, error: 'cooldown', retryInMs: CLEAR_COOLDOWN_MS - (now - lastClearAt.logs) })
    }
    lastClearAt.logs = now
    const removed = await panelRepository.clearLogs()
    return reply.send({ ok: true, removed })
  })

  fastify.post('/api/panel/mappings/clear', requireAuth, async (req, reply) => {
    if (!req.body || req.body.confirm !== true) {
      return reply.code(400).send({ ok: false, error: 'confirm_required' })
    }
    const now = Date.now()
    if (now - lastClearAt.mappings < CLEAR_COOLDOWN_MS) {
      return reply.code(429).send({ ok: false, error: 'cooldown', retryInMs: CLEAR_COOLDOWN_MS - (now - lastClearAt.mappings) })
    }
    lastClearAt.mappings = now
    const removed = await panelRepository.clearMappings()
    return reply.send({ ok: true, removed })
  })
}

module.exports = fp(panelRoutesImpl, { name: 'panel-routes' })
module.exports.createPanelRoutes = module.exports
module.exports.panelRoutesPlugin = fp(panelRoutesImpl, { name: 'panel-routes' })
