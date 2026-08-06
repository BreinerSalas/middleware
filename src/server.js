'use strict'

const path = require('node:path')
const { load } = require('./config')
const { createLogger } = require('./lib/logger')
const { createApp } = require('./app')
const { connectMongo, disconnectMongo } = require('./adapters/outbound/mongo/connection')
const { createDealSyncModule } = require('./composition/dealSyncModule')
const { createHubspotApiClient } = require('./adapters/outbound/hubspot/hubspotApiClient')
const { provisionProperties } = require('./composition/provisionProperties')
const { buildDealPropertyDefinitions } = require('./composition/dealPropertyDefinitions')
const { buildQuotePropertyDefinitions } = require('./composition/quotePropertyDefinitions')
const { createOdooApiClient } = require('./adapters/outbound/odoo/odooApiClient')
const { OdooProductSource } = require('./adapters/outbound/odoo/OdooProductSource')
const { HubspotProductGateway } = require('./adapters/outbound/hubspot/HubspotProductGateway')
const { createProductSyncModule } = require('./composition/productSyncModule')
const { createProductSyncJobModule } = require('./composition/productSyncJobModule')
const { MongoJobRepository } = require('./adapters/outbound/mongo/MongoJobRepository')
const { MongoProductMappingRepository } = require('./adapters/outbound/mongo/MongoProductMappingRepository')
const { MongoProductSyncRunRepository } = require('./adapters/outbound/mongo/MongoProductSyncRunRepository')
const { MongoSyncCursorRepository } = require('./adapters/outbound/mongo/MongoSyncCursorRepository')

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
  const quotePropertiesToProvision = buildQuotePropertyDefinitions(cfg.hubspot)
  try {
    const [dealSummary, quoteSummary] = await Promise.all([
      provisionProperties({ api: hubspotApi, objectType: 'deals', properties: dealPropertiesToProvision, logger }),
      provisionProperties({ api: hubspotApi, objectType: 'quotes', properties: quotePropertiesToProvision, logger })
    ])
    const combined = [...dealSummary, ...quoteSummary]
    logger.info('hubspot.provision.summary', {
      total: combined.length,
      created: combined.filter((s) => s.status === 'created').length,
      existing: combined.filter((s) => s.status === 'existing').length,
      failed: combined.filter((s) => s.status === 'failed').length
    })
  } catch (err) {
    logger.warn('hubspot.provision.bootstrap.failed', { error: err.message })
  }

  let productSyncJobModule = null
  if (cfg.productSync && cfg.productSync.jobEnabled) {
    const odooApi = createOdooApiClient({
      mode: cfg.odoo.mode, baseUrl: cfg.odoo.baseUrl, db: cfg.odoo.db, login: cfg.odoo.login, apiKey: cfg.odoo.apiKey
    })
    const productHubspotApi = createHubspotApiClient({ baseUrl: cfg.hubspot.apiBase, accessToken: cfg.hubspot.accessToken })
    const productSyncModule = createProductSyncModule({
      config: cfg,
      odooSource: new OdooProductSource({ apiClient: odooApi, logger }),
      hubspotGateway: new HubspotProductGateway({ apiClient: productHubspotApi, logger }),
      mappingRepo: new MongoProductMappingRepository({ logger }),
      runRepo: new MongoProductSyncRunRepository({ logger }),
      cursorRepo: new MongoSyncCursorRepository(),
      logger,
      concurrency: 10
    })
    productSyncJobModule = createProductSyncJobModule({
      config: cfg,
      logger,
      jobRepository: new MongoJobRepository({ logger }),
      productSyncModule,
      includeNoSku: cfg.productSync.includeNoSku,
      tickIntervalMs: cfg.productSync.tickIntervalMs,
      orphanWatchdogMs: cfg.productSync.orphanWatchdogMs
    })
  }

  const staticRoot = path.resolve(__dirname, 'panel')
  const app = createApp({ config: cfg, logger, dealSyncModule, staticRoot })

  await dealSyncModule.startWorker()
  if (productSyncJobModule) await productSyncJobModule.startWorker()
  await app.listen({ port: cfg.server.port, host: '0.0.0.0' })
  logger.info('server.started', { port: cfg.server.port })

  const shutdown = async (signal) => {
    logger.info('server.shutdown', { signal })
    try { await app.close() } catch (_) { /* noop */ }
    try { await dealSyncModule.stopWorker() } catch (_) { /* noop */ }
    if (productSyncJobModule) { try { await productSyncJobModule.stopWorker() } catch (_) { /* noop */ } }
    try { await disconnectMongo({ logger }) } catch (_) { /* noop */ }
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  return { app, logger, config: cfg, dealSyncModule, productSyncJobModule }
}

if (require.main === module) {
  start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: 'error', msg: 'startup.failed', error: err.message, stack: err.stack }))
    process.exit(1)
  })
}

module.exports = { start }
