'use strict'

const fp = require('fastify-plugin')
const { createPanelAuthMiddleware } = require('./panel.auth.middleware.js')

// Distinct trust boundary from the internal ops panel (panel.routes.js): a separate
// token/header guards the manual per-quote MO release action a future React CRM card calls.
async function quoteReleaseRoutesImpl(fastify, opts) {
  const { triggerQuoteRelease, hubspotApiClient = null, config } = opts || {}
  if (!triggerQuoteRelease) throw new Error('createQuoteReleaseRoutes requires triggerQuoteRelease')
  if (!config || !config.quoteRelease) throw new Error('createQuoteReleaseRoutes requires config.quoteRelease')

  const auth = createPanelAuthMiddleware({
    token: config.quoteRelease.token,
    headerName: config.quoteRelease.headerName || 'authorization',
    nodeEnv: (config.server && config.server.nodeEnv) || 'production'
  })

  fastify.post('/api/integrations/quotes/:quoteId/release', { preHandler: auth }, async (req, reply) => {
    const { dealId, correlationId = null } = req.body || {}
    if (!dealId) {
      return reply.code(400).send({ ok: false, error: 'dealId_required' })
    }

    const { released, tracker, enqueued } = await triggerQuoteRelease.execute({
      dealId,
      quoteId: req.params.quoteId,
      correlationId
    })

    return reply.send({
      ok: true,
      released,
      tracker: tracker ? { quoteId: tracker.quoteId, dealId: tracker.dealId, stage: tracker.stage } : null,
      enqueued: enqueued ? { jobId: enqueued.job ? enqueued.job._id : null, deduped: enqueued.deduped } : null
    })
  })

  // The card only gets the raw stored value of enumeration properties (e.g. pais_de_destino
  // holds an Odoo operation.costs id, not its name) — this lets it resolve the human label.
  fastify.get('/api/integrations/quotes/properties/:propertyName/options', { preHandler: auth }, async (req, reply) => {
    if (!hubspotApiClient) return reply.code(503).send({ ok: false, error: 'hubspot_client_not_ready' })
    const property = await hubspotApiClient.getCustomProperty('quotes', req.params.propertyName)
    return reply.send({ ok: true, options: (property && property.options) || [] })
  })
}

module.exports = fp(quoteReleaseRoutesImpl, { name: 'quote-release-routes' })
module.exports.createQuoteReleaseRoutes = module.exports
module.exports.quoteReleaseRoutesPlugin = fp(quoteReleaseRoutesImpl, { name: 'quote-release-routes' })
