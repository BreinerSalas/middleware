'use strict'

const Fastify = require('fastify')
const mongoose = require('mongoose')
const { createLogger } = require('./lib/logger')
const { createAuthMiddleware } = require('./adapters/inbound/http/auth.middleware')
const { createCorrelationMiddleware } = require('./adapters/inbound/http/correlation.middleware')
const { createHealthRoutes } = require('./adapters/inbound/http/health.routes')

function createApp({ config, logger = null, dealSyncModule = null } = {}) {
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

  const auth = createAuthMiddleware({
    secret: config.webhook.sharedSecret,
    headerName: config.webhook.headerName,
    isDev: config.server.nodeEnv !== 'production'
  })

  const mongoForHealth = dealSyncModule && dealSyncModule._internals && dealSyncModule._internals.jobRepository && dealSyncModule._internals.jobRepository.model
    ? dealSyncModule._internals.jobRepository.model.db
    : mongoose.connection

  // health
  app.register(createHealthRoutes({ mongo: mongoForHealth }), { prefix: '' })

  // webhook
  app.post('/webhooks/hubspot', { preHandler: auth }, async (req, reply) => {
    if (!dealSyncModule) return reply.code(503).send({ ok: false, error: 'sync_module_not_ready' })
    const payload = req.body || {}
    const objectId = payload.objectId || (payload.dealId) || null
    if (!objectId) return reply.code(400).send({ ok: false, error: 'objectId required' })
    try {
      const result = await dealSyncModule.enqueueWebhook({ rawBody: payload, objectId: String(objectId), eventType: payload.subscriptionType || null })
      return reply.code(202).send({ ok: true, deduped: result.deduped, correlationId: result.correlationId, jobId: result.job ? result.job._id : null })
    } catch (err) {
      log.error('enqueue failed', { error: err.message, stack: err.stack })
      return reply.code(500).send({ ok: false, error: 'enqueue_failed' })
    }
  })

  return app
}

module.exports = { createApp }
