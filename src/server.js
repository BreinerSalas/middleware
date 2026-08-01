'use strict'

const path = require('node:path')
const { load } = require('./config')
const { createLogger } = require('./lib/logger')
const { createApp } = require('./app')
const { connectMongo, disconnectMongo } = require('./adapters/outbound/mongo/connection')
const { createDealSyncModule } = require('./composition/dealSyncModule')
const { createHubspotApiClient } = require('./adapters/outbound/hubspot/hubspotApiClient')
const { provisionDealProperties } = require('./composition/provisionDealProperties')
const { buildDealPropertyDefinitions } = require('./composition/dealPropertyDefinitions')

async function start({ config = null } = {}) {
  const cfg = config || load()
  const logger = createLogger({ level: cfg.logging.level })
  await connectMongo({ uri: cfg.mongodbUri, logger })
  const dealSyncModule = createDealSyncModule({ config: cfg, logger })

  const hubspotApi = createHubspotApiClient({
    baseUrl: cfg.hubspot.apiBase,
    accessToken: cfg.hubspot.accessToken
  })
  const dealPropertiesToProvision = buildDealPropertyDefinitions(cfg.hubspot)
  try {
    const summary = await provisionDealProperties({
      api: hubspotApi,
      properties: dealPropertiesToProvision,
      logger
    })
    logger.info('hubspot.provision.summary', {
      total: summary.length,
      created: summary.filter((s) => s.status === 'created').length,
      existing: summary.filter((s) => s.status === 'existing').length,
      failed: summary.filter((s) => s.status === 'failed').length
    })
  } catch (err) {
    logger.warn('hubspot.provision.bootstrap.failed', { error: err.message })
  }

  const staticRoot = path.resolve(__dirname, 'panel')
  const app = createApp({ config: cfg, logger, dealSyncModule, staticRoot })

  await dealSyncModule.startWorker()
  await app.listen({ port: cfg.server.port, host: '0.0.0.0' })
  logger.info('server.started', { port: cfg.server.port })

  const shutdown = async (signal) => {
    logger.info('server.shutdown', { signal })
    try { await app.close() } catch (_) { /* noop */ }
    try { await dealSyncModule.stopWorker() } catch (_) { /* noop */ }
    try { await disconnectMongo({ logger }) } catch (_) { /* noop */ }
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  return { app, logger, config: cfg, dealSyncModule }
}

if (require.main === module) {
  start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: 'error', msg: 'startup.failed', error: err.message, stack: err.stack }))
    process.exit(1)
  })
}

module.exports = { start }
