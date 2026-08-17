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
const { buildContactPropertyDefinitions } = require('./composition/contactPropertyDefinitions')
const { buildProductPropertyDefinitions } = require('./composition/productPropertyDefinitions')
const { createOdooApiClient } = require('./adapters/outbound/odoo/odooApiClient')
const { OdooProductSource } = require('./adapters/outbound/odoo/OdooProductSource')
const { HubspotProductGateway } = require('./adapters/outbound/hubspot/HubspotProductGateway')
const { createProductSyncModule } = require('./composition/productSyncModule')
const { buildProductImageUrlBuilder } = require('./composition/productImageUrlBuilder')
const { createProductSyncJobModule } = require('./composition/productSyncJobModule')
const { MongoJobRepository } = require('./adapters/outbound/mongo/MongoJobRepository')
const { MongoProductMappingRepository } = require('./adapters/outbound/mongo/MongoProductMappingRepository')
const { MongoProductSyncRunRepository } = require('./adapters/outbound/mongo/MongoProductSyncRunRepository')
const { MongoSyncCursorRepository } = require('./adapters/outbound/mongo/MongoSyncCursorRepository')
const { OdooSaleOrderSource } = require('./adapters/outbound/odoo/OdooSaleOrderSource')
const { createSaleOrderStatusSyncModule } = require('./composition/saleOrderStatusSyncModule')
const { createSaleOrderStatusSyncJobModule } = require('./composition/saleOrderStatusSyncJobModule')
const { HubspotSourceGateway } = require('./adapters/outbound/hubspot/HubspotSourceGateway')
const { MongoMappingRepository } = require('./adapters/outbound/mongo/MongoMappingRepository')
const { createEchoGuard } = require('./core/shared/echoGuard')
const { createManufacturingOrderRetrySyncModule } = require('./composition/manufacturingOrderRetrySyncModule')
const { createManufacturingOrderRetrySyncJobModule } = require('./composition/manufacturingOrderRetrySyncJobModule')
const { OdooPartnerSource } = require('./adapters/outbound/odoo/OdooPartnerSource')
const { HubspotContactGateway } = require('./adapters/outbound/hubspot/HubspotContactGateway')
const { createPartnerSyncModule } = require('./composition/partnerSyncModule')
const { createPartnerSyncJobModule } = require('./composition/partnerSyncJobModule')
const { MongoPartnerMappingRepository } = require('./adapters/outbound/mongo/MongoPartnerMappingRepository')
const { MongoPartnerSyncRunRepository } = require('./adapters/outbound/mongo/MongoPartnerSyncRunRepository')
const { runProductsProvisioningGate } = require('./composition/productsProvisioningGate')

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
  const contactPropertiesToProvision = buildContactPropertyDefinitions(cfg.hubspot)
  const productsPropertiesToProvision = buildProductPropertyDefinitions(cfg.hubspot)
  try {
    const [dealSummary, quoteSummary, contactSummary, productsSummary] = await Promise.all([
      provisionProperties({ api: hubspotApi, objectType: 'deals', properties: dealPropertiesToProvision, logger }),
      provisionProperties({ api: hubspotApi, objectType: 'quotes', properties: quotePropertiesToProvision, logger }),
      provisionProperties({ api: hubspotApi, objectType: 'contacts', properties: contactPropertiesToProvision, logger }),
      // Fail-loud products provisioning (openspec/hubspot-product-odoo-id-key design D7):
      // throws if any products entry has status:'failed' — never falls back to SKU matching.
      runProductsProvisioningGate({ api: hubspotApi, hubspotCfg: cfg.hubspot, logger })
    ])
    const combined = [...dealSummary, ...quoteSummary, ...contactSummary, ...productsSummary]
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
    const productImageUrlBuilder = buildProductImageUrlBuilder(cfg.media)
    const productSyncModule = createProductSyncModule({
      config: cfg,
      odooSource: new OdooProductSource({ apiClient: odooApi, logger }),
      hubspotGateway: new HubspotProductGateway({ apiClient: productHubspotApi, logger, imageUrlBuilder: productImageUrlBuilder }),
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

  let saleOrderStatusSyncJobModule = null
  if (cfg.saleOrderStatusSync && cfg.saleOrderStatusSync.jobEnabled) {
    const odooApi = createOdooApiClient({
      mode: cfg.odoo.mode, baseUrl: cfg.odoo.baseUrl, db: cfg.odoo.db, login: cfg.odoo.login, apiKey: cfg.odoo.apiKey
    })
    const saleOrderHubspotApi = createHubspotApiClient({ baseUrl: cfg.hubspot.apiBase, accessToken: cfg.hubspot.accessToken })
    const saleOrderHubspotGateway = new HubspotSourceGateway({
      apiClient: saleOrderHubspotApi,
      propertyOdooCustomerId: cfg.hubspot.propertyOdooCustomerId,
      propertyOdooOrderId: cfg.hubspot.propertyOdooOrderId,
      propertyOdooQuoteId: cfg.hubspot.propertyOdooQuoteId,
      propertyQuoteOdooQuoteId: cfg.hubspot.propertyQuoteOdooQuoteId,
      propertyQuoteCountry: cfg.hubspot.propertyQuoteCountry,
      propertyManufacturingOrder: cfg.hubspot.propertyManufacturingOrder,
      propertyQuoteState: cfg.hubspot.propertyQuoteState,
      propertyQuoteInvoiceStatus: cfg.hubspot.propertyQuoteInvoiceStatus,
      closedWonStageId: cfg.deals.closedWonStageId,
      quoteEligibleStatuses: cfg.hubspot.quoteEligibleStatuses,
      // TTL propio, aislado del echoGuard del flujo principal (deal->Odoo) — ancho
      // al intervalo del tick para no repetir una llamada real a HubSpot con el
      // mismo valor mientras no haya un cambio nuevo en Odoo.
      echoGuard: createEchoGuard({ ttlMs: cfg.saleOrderStatusSync.tickIntervalMs + 5000 }),
      logger
    })
    const saleOrderStatusSyncModule = createSaleOrderStatusSyncModule({
      odooSource: new OdooSaleOrderSource({ apiClient: odooApi, logger }),
      mappingRepository: new MongoMappingRepository(),
      hubspotGateway: saleOrderHubspotGateway,
      cursorRepo: new MongoSyncCursorRepository(),
      logger
    })
    saleOrderStatusSyncJobModule = createSaleOrderStatusSyncJobModule({
      config: cfg,
      logger,
      jobRepository: new MongoJobRepository({ logger }),
      saleOrderStatusSyncModule,
      tickIntervalMs: cfg.saleOrderStatusSync.tickIntervalMs,
      orphanWatchdogMs: cfg.saleOrderStatusSync.orphanWatchdogMs
    })
  }

  let manufacturingOrderRetrySyncJobModule = null
  if (cfg.manufacturingOrderRetrySync && cfg.manufacturingOrderRetrySync.jobEnabled) {
    const moRetryOdooApi = createOdooApiClient({
      mode: cfg.odoo.mode, baseUrl: cfg.odoo.baseUrl, db: cfg.odoo.db, login: cfg.odoo.login, apiKey: cfg.odoo.apiKey
    })
    const moRetryHubspotApi = createHubspotApiClient({ baseUrl: cfg.hubspot.apiBase, accessToken: cfg.hubspot.accessToken })
    const moRetryHubspotGateway = new HubspotSourceGateway({
      apiClient: moRetryHubspotApi,
      propertyManufacturingOrder: cfg.hubspot.propertyManufacturingOrder,
      echoGuard: createEchoGuard({ ttlMs: cfg.manufacturingOrderRetrySync.tickIntervalMs + 5000 }),
      logger
    })
    const manufacturingOrderRetrySyncModule = createManufacturingOrderRetrySyncModule({
      mappingRepository: new MongoMappingRepository(),
      odooApiClient: moRetryOdooApi,
      hubspotGateway: moRetryHubspotGateway,
      logger
    })
    manufacturingOrderRetrySyncJobModule = createManufacturingOrderRetrySyncJobModule({
      config: cfg,
      logger,
      jobRepository: new MongoJobRepository({ logger }),
      manufacturingOrderRetrySyncModule,
      tickIntervalMs: cfg.manufacturingOrderRetrySync.tickIntervalMs,
      orphanWatchdogMs: cfg.manufacturingOrderRetrySync.orphanWatchdogMs
    })
  }

  let partnerSyncJobModule = null
  if (cfg.partnerSync && cfg.partnerSync.jobEnabled) {
    const partnerOdooApi = createOdooApiClient({
      mode: cfg.odoo.mode, baseUrl: cfg.odoo.baseUrl, db: cfg.odoo.db, login: cfg.odoo.login, apiKey: cfg.odoo.apiKey
    })
    const partnerHubspotApi = createHubspotApiClient({ baseUrl: cfg.hubspot.apiBase, accessToken: cfg.hubspot.accessToken })
    const partnerSyncModule = createPartnerSyncModule({
      config: cfg,
      odooSource: new OdooPartnerSource({ apiClient: partnerOdooApi, logger, pageSize: cfg.partnerSync.pageSize }),
      hubspotGateway: new HubspotContactGateway({
        apiClient: partnerHubspotApi, logger, idProperty: cfg.hubspot.propertyOdooPartnerId
      }),
      mappingRepo: new MongoPartnerMappingRepository({ logger }),
      runRepo: new MongoPartnerSyncRunRepository({ logger }),
      cursorRepo: new MongoSyncCursorRepository(),
      logger,
      concurrency: 10
    })
    partnerSyncJobModule = createPartnerSyncJobModule({
      config: cfg,
      logger,
      jobRepository: new MongoJobRepository({ logger }),
      partnerSyncModule,
      tickIntervalMs: cfg.partnerSync.tickIntervalMs,
      orphanWatchdogMs: cfg.partnerSync.orphanWatchdogMs
    })
  }

  const staticRoot = path.resolve(__dirname, 'panel')
  const app = createApp({ config: cfg, logger, dealSyncModule, staticRoot })

  await dealSyncModule.startWorker()
  if (productSyncJobModule) await productSyncJobModule.startWorker()
  if (saleOrderStatusSyncJobModule) await saleOrderStatusSyncJobModule.startWorker()
  if (manufacturingOrderRetrySyncJobModule) await manufacturingOrderRetrySyncJobModule.startWorker()
  if (partnerSyncJobModule) await partnerSyncJobModule.startWorker()
  await app.listen({ port: cfg.server.port, host: '0.0.0.0' })
  logger.info('server.started', { port: cfg.server.port })

  const shutdown = async (signal) => {
    logger.info('server.shutdown', { signal })
    try { await app.close() } catch (_) { /* noop */ }
    try { await dealSyncModule.stopWorker() } catch (_) { /* noop */ }
    if (productSyncJobModule) { try { await productSyncJobModule.stopWorker() } catch (_) { /* noop */ } }
    if (saleOrderStatusSyncJobModule) { try { await saleOrderStatusSyncJobModule.stopWorker() } catch (_) { /* noop */ } }
    if (manufacturingOrderRetrySyncJobModule) { try { await manufacturingOrderRetrySyncJobModule.stopWorker() } catch (_) { /* noop */ } }
    if (partnerSyncJobModule) { try { await partnerSyncJobModule.stopWorker() } catch (_) { /* noop */ } }
    try { await disconnectMongo({ logger }) } catch (_) { /* noop */ }
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  return {
    app,
    logger,
    config: cfg,
    dealSyncModule,
    productSyncJobModule,
    saleOrderStatusSyncJobModule,
    manufacturingOrderRetrySyncJobModule,
    partnerSyncJobModule
  }
}

if (require.main === module) {
  start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: 'error', msg: 'startup.failed', error: err.message, stack: err.stack }))
    process.exit(1)
  })
}

module.exports = { start }
