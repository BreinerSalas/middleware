'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const Fastify = require('fastify')
const mongoose = require('mongoose')
const { createLogger } = require('./lib/logger')
const { createHubspotSignatureMiddleware } = require('./adapters/inbound/http/hubspotSignature.middleware')
const { createCorrelationMiddleware } = require('./adapters/inbound/http/correlation.middleware')
const { createHealthRoutes } = require('./adapters/inbound/http/health.routes')
const { createPanelRoutes } = require('./adapters/inbound/http/panel.routes')
const { MongoPanelRepository } = require('./adapters/outbound/mongo/MongoPanelRepository')
const { MongoProductPanelRepository } = require('./adapters/outbound/mongo/MongoProductPanelRepository')
const { hubspotHealthCheck } = require('./adapters/outbound/hubspot/hubspotHealthCheck')
const { odooHealthCheck } = require('./adapters/outbound/odoo/odooHealthCheck')

function createApp({ config, logger = null, dealSyncModule = null, panelRepository = null, staticRoot = null } = {}) {
  if (!config) throw new Error('createApp requires config')
  const log = logger || createLogger({ level: config.logging.level })
  const app = Fastify({ logger: false })

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body
    if (!body) return done(null, {})
    try {
      done(null, JSON.parse(body))
    } catch (err) {
      err.statusCode = 400
      done(err, undefined)
    }
  })

  app.addHook('onRequest', createCorrelationMiddleware())

  const auth = createHubspotSignatureMiddleware({
    clientSecret: config.hubspot.clientSecret,
    toleranceMs: config.hubspot.signatureTimestampToleranceMs,
    isDev: config.server.nodeEnv !== 'production'
  })

  const mongoForHealth = dealSyncModule && dealSyncModule._internals && dealSyncModule._internals.jobRepository && dealSyncModule._internals.jobRepository.model
    ? dealSyncModule._internals.jobRepository.model.db
    : mongoose.connection

  // health
  app.register(createHealthRoutes({ mongo: mongoForHealth }), { prefix: '' })

  // webhook — HubSpot Private App: HMAC + array of events, strict filter
  app.post('/webhooks/hubspot', { preHandler: auth }, async (req, reply) => {
    if (!dealSyncModule) return reply.code(503).send({ ok: false, error: 'sync_module_not_ready' })

    const body = req.body
    if (!Array.isArray(body)) {
      log.warn('webhook.non_array_body', { type: typeof body })
      return reply.code(200).send({ ok: true, enqueued: 0 })
    }

    let enqueued = 0
    let lastResult = null
    for (const event of body) {
      if (!event || typeof event !== 'object') continue
      if (event.subscriptionType !== 'deal.propertyChange') continue
      if (event.propertyName !== 'dealstage' || event.propertyValue !== 'closedwon') continue
      const objId = event.objectId || event.dealId
      if (!objId) continue
      try {
        const result = await dealSyncModule.enqueueWebhook({
          rawBody: event,
          objectId: String(objId),
          eventType: event.subscriptionType
        })
        enqueued++
        lastResult = result
      } catch (err) {
        log.error('enqueue failed', { error: err.message, objectId: objId })
      }
    }

    if (enqueued === 0) {
      return reply.code(200).send({ ok: true, enqueued: 0 })
    }
    return reply.code(202).send({
      ok: true,
      enqueued,
      deduped: lastResult.deduped,
      correlationId: lastResult.correlationId,
      jobId: lastResult.job ? lastResult.job._id : null
    })
  })

  // panel: API + static assets
  if (config.panel) {
    const repo = panelRepository || new MongoPanelRepository()
    const productRepo = new MongoProductPanelRepository()
    const healthCheck = {
      hubspot: () => hubspotHealthCheck({ baseUrl: config.hubspot.apiBase, accessToken: config.hubspot.accessToken, timeoutMs: 5000 }),
      odoo: () => odooHealthCheck({ mode: config.odoo.mode, baseUrl: config.odoo.baseUrl, timeoutMs: 5000 })
    }
    app.register(createPanelRoutes, { panelRepository: repo, productRepository: productRepo, healthCheck, config })
  }

  if (staticRoot) {
    const staticAssetsDir = path.join(staticRoot, 'static')
    app.register(require('@fastify/static'), { root: staticAssetsDir, prefix: '/static/', decorateReply: false })
    app.get('/', async (req, reply) => {
      try {
        const html = await fs.readFile(path.join(staticRoot, 'index.html'), 'utf8')
        reply.type('text/html; charset=utf-8').send(html)
      } catch (err) {
        reply.code(500).send({ ok: false, error: 'panel_html_missing' })
      }
    })
  }

  return app
}

module.exports = { createApp }
